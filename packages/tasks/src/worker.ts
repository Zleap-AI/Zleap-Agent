#!/usr/bin/env node
import { ChatEngine, DEFAULT_SYSTEM_PROMPT, shouldAutoApproveToolWithoutHitl } from '@zleap/agent/engine';
import { ConversationService, createSharedStore, modelFromEnv, toEngineModelResolved } from '@zleap/agent/conversation';
import { buildScheduledRunInput } from '@zleap/avatar';
import {
  DEFAULT_FILE_WORKSPACE_ROOT,
  resolveConversationWorkspaceRoot,
  CANONICAL_MAIN_SPACE_ID,
  toCanonicalSpaceId,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { TaskExecutionService } from './execution.js';
import { PgBossTaskQueue } from './queue.js';
import { TaskHandlerRegistry } from './registry.js';
import type { CreateTaskInput, TaskHandler, TaskRunContext, TaskRunRequest, TaskRunResult } from './types.js';

const EXPIRE_SECONDS = Number(process.env.ZLEAP_TASK_EXPIRE_SECONDS ?? 3600) || 3600;
const HEARTBEAT_SECONDS = Number(process.env.ZLEAP_TASK_HEARTBEAT_SECONDS ?? 60) || 60;

type TaskModelConfig = NonNullable<ConstructorParameters<typeof ChatEngine>[0]>;
type TaskRuntimeContext = {
  conversationId: string;
  workspaceRoot: string;
  systemPrompt: string;
  metadata: Record<string, unknown>;
};
type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  note?: string;
  spec?: string;
};

function loadDotEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    for (const name of ['.env.local', '.env']) {
      const file = join(dir, name);
      if (existsSync(file)) {
        loadEnvFile({ path: file, override: false, quiet: true });
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const databaseUrl = process.env.ZLEAP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('ZLEAP_DATABASE_URL or DATABASE_URL is required for zleap-task-worker.');
  }
  // Shared, process-level store (one PG pool). Embedding config is data-first
  // (DB default embedding row → env) and the default avatar is seeded once here,
  // since the injected store bypasses the engine's own first-run seeding.
  const store = await createSharedStore({
    databaseUrl,
    onWarn: (message) => process.stderr.write(`[task-worker] ${message}\n`),
  });
  if (!store) {
    throw new Error('Unable to open Zleap store.');
  }
  const queue = new PgBossTaskQueue({
    connectionString: databaseUrl,
    role: 'worker',
    expireInSeconds: EXPIRE_SECONDS,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  });
  await queue.start();

  // Shared L2 conversation layer. Engines run on the injected shared store
  // (single pool), so no per-engine persistence/pool is created.
  const conversations = new ConversationService({ store });

  const registry = new TaskHandlerRegistry();
  registry.register(new AgentTaskHandler(store, conversations));

  const executor = new TaskExecutionService(store.tasks, registry, {
    unschedule: (taskId) => queue.unschedule(taskId),
  });

  // Two-way schedule sync + reclaim orphaned running rows from a prior crash.
  await queue.reconcileAll(await store.tasks.listTasks({ enabled: true, includeDeleted: false }));
  const reclaimed = await store.tasks.reclaimStaleRuns(EXPIRE_SECONDS);
  if (reclaimed > 0) process.stdout.write(`zleap-task-worker reclaimed ${reclaimed} stale run(s).\n`);

  await queue.workRuns((request, signal) => executor.handleRun(request, signal).then(() => undefined));
  await queue.workDeadLetter((request) => recordDeadLetter(store, request));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await queue.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.stdout.write('zleap-task-worker started.\n');
}

async function recordDeadLetter(store: ZleapStore, request: TaskRunRequest): Promise<void> {
  const now = new Date();
  const failOne = async (run: ScheduledTaskRunRecord) => {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'skipped') return;
    await store.tasks.updateRun(run.id, { status: 'failed', finishedAt: now, error: 'dead-lettered: retries exhausted' });
  };
  if (request.runId) {
    const existing = await store.tasks.getRun(request.runId);
    if (existing) await failOne(existing);
  }
  const running = await store.tasks.listRuns({ taskId: request.taskId, status: 'running', limit: 20 });
  for (const run of running) await failOne(run);
  process.stderr.write(`[task-worker] dead-letter task=${request.taskId}\n`);
}

/** Built-in handler: runs the agent (ChatEngine) for `type === 'agent'` tasks. */
class AgentTaskHandler implements TaskHandler {
  readonly type = 'agent';

  constructor(
    private readonly store: ZleapStore,
    private readonly conversations: ConversationService,
  ) {}

  validate(input: CreateTaskInput): void {
    if (!input.prompt?.trim()) throw new Error('prompt_required');
  }

  async run(ctx: TaskRunContext, signal?: AbortSignal): Promise<TaskRunResult> {
    const { task, run } = ctx;
    const targetSpace = normalizeTaskTargetSpace(task.targetSpace);
    const modelResolution = await this.resolveModel(task);
    if (modelResolution.error) {
      return {
        status: 'failed',
        error: modelResolution.error,
        metadata: modelResolution.metadata,
      };
    }
    const model = modelResolution.model;
    if (!model) {
      return { status: 'failed', error: 'model_unavailable', metadata: modelResolution.metadata };
    }
    const runtime = await this.runtimeContext(task, run, modelResolution.metadata, targetSpace);
    const scheduledRun = buildScheduledRunInput({
      avatarId: task.avatarId,
      actorId: task.userId ?? 'task-worker',
      spaceId: targetSpace,
      taskId: task.id,
      prompt: task.prompt,
    });
    // L2 owns the run loop. Scheduled tasks are stateless (historySource 'none')
    // and unattended (no slash-command routing, auto-approve per permission mode).
    const { text, error } = await this.conversations.run(
      {
        channel: 'web',
        conversationId: runtime.conversationId,
        kind: 'schedule',
        text: scheduledRun.prompt,
        actor: { userId: scheduledRun.actorId, role: 'user', ...(task.tenantId ? { tenantId: task.tenantId } : {}) },
      },
      {
        historySource: 'none',
        model,
        avatarId: scheduledRun.avatarId,
        systemPrompt: runtime.systemPrompt,
        workspaceRoot: runtime.workspaceRoot,
        ...(targetSpace ? { targetSpace } : {}),
        confirm: async (request) => {
          if (task.permissionMode === 'full_access') return true;
          return shouldAutoApproveToolWithoutHitl(request.name);
        },
        ...(signal ? { signal } : {}),
      },
    );
    const summary = summarize(text);
    return {
      status: error ? 'failed' : 'completed',
      agentRunId: undefined,
      summary,
      ...(error ? { error } : {}),
      metadata: runtime.metadata,
    };
  }

  private async resolveModel(task: ScheduledTaskRecord): Promise<{ model?: TaskModelConfig; error?: string; metadata: Record<string, unknown> }> {
    if (task.modelConfigId) {
      const record = await this.store.models.getModelConfig(task.modelConfigId);
      if (!record) {
        return { error: `model_not_found:${task.modelConfigId}`, metadata: { modelId: task.modelConfigId, modelSource: 'task' } };
      }
      const model = await toEngineModelResolved(record);
      if (!model) {
        return { error: `model_not_runnable:${task.modelConfigId}`, metadata: { modelId: task.modelConfigId, modelSource: 'task' } };
      }
      return { model, metadata: { modelId: record.id, modelSource: 'task' } };
    }

    const spaceModelId = await this.modelConfigIdFromTargetSpace(normalizeTaskTargetSpace(task.targetSpace));
    if (spaceModelId) {
      const record = await this.store.models.getModelConfig(spaceModelId);
      const model = record ? await toEngineModelResolved(record) : undefined;
      if (model) {
        return { model, metadata: { modelId: record!.id, modelSource: 'space' } };
      }
    }

    const defaultRecord = (await this.store.models.listModelConfigs()).find((record) => record.purpose !== 'embedding' && record.config?.isDefault === true)
      ?? (await this.store.models.listModelConfigs({ purpose: 'main' })).find((record) => record.purpose !== 'embedding');
    const defaultModel = defaultRecord ? await toEngineModelResolved(defaultRecord) : undefined;
    if (defaultModel) {
      return { model: defaultModel, metadata: { modelId: defaultRecord!.id, modelSource: 'default' } };
    }

    const envModel = modelFromEnv();
    return { model: envModel, metadata: { modelId: envModel?.id, modelSource: envModel ? 'env' : 'none' } };
  }

  private async modelConfigIdFromTargetSpace(targetSpace?: string): Promise<string | undefined> {
    const rawSpaceId = targetSpace?.trim();
    if (!rawSpaceId) return undefined;
    try {
      const space = await this.store.spaces.getSpace(toCanonicalSpaceId(rawSpaceId));
      if (!space) return undefined;
      const version = await this.store.spaces.getSpaceVersion(space.id, space.currentVersion);
      return version?.modelConfigId?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async runtimeContext(task: ScheduledTaskRecord, run: ScheduledTaskRunRecord, modelMetadata: Record<string, unknown>, targetSpace?: string): Promise<TaskRuntimeContext> {
    const conversationId = task.conversationId ?? run.conversationId ?? `task:${task.id}`;
    const base = taskSystemPrompt(task, targetSpace);
    if (task.projectId) {
      const project = await findProject(task.projectId);
      if (!project) {
        throw new Error(`project_not_found:${task.projectId}`);
      }
      const workspaceRoot = await resolveProjectRoot(project.path, project.id);
      const projectLines = [
        `Working directory: ${workspaceRoot}`,
        `Project: ${project.name}`,
        `Project id: ${project.id}`,
        `Project root: ${workspaceRoot}`,
        'Project mode: read and write files directly in the selected project folder. Do not copy this project into the Zleap history folder.',
        'Use relative paths under this project root for generated files unless the user explicitly provides another path.',
      ];
      if (project.note?.trim()) projectLines.push(`Note: ${project.note.trim()}`);
      if (project.spec?.trim()) projectLines.push('', project.spec.trim());
      return {
        conversationId,
        workspaceRoot,
        systemPrompt: `${base}\n\n## Project context\n${projectLines.join('\n')}`,
        metadata: { ...modelMetadata, workspaceRoot, projectId: project.id, projectName: project.name },
      };
    }

    const workspaceRoot = resolveConversationWorkspaceRoot({
      conversationId,
      titleSeed: task.name,
      baseRoot: process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT,
    });
    await mkdir(workspaceRoot, { recursive: true });
    const lines = [
      `Working directory: ${workspaceRoot}`,
      'Project mode: no project selected; use this Zleap history folder for generated files.',
      'Use relative paths under this folder for all generated files. Do not write to any other local folder unless the user explicitly provides that path.',
    ];
    return {
      conversationId,
      workspaceRoot,
      systemPrompt: `${base}\n\n## Project context\n${lines.join('\n')}`,
      metadata: { ...modelMetadata, workspaceRoot },
    };
  }
}

function taskSystemPrompt(task: ScheduledTaskRecord, targetSpace?: string): string {
  const lines = [
    DEFAULT_SYSTEM_PROMPT,
    '## Scheduled task context',
    `Task: ${task.name}`,
    `Task id: ${task.id}`,
    'This is an unattended scheduled-task run. Do not ask the user for live input.',
    `Permission mode: ${task.permissionMode}`,
    `Target space: ${targetSpace ?? CANONICAL_MAIN_SPACE_ID}`,
  ];
  return lines.join('\n\n');
}

function summarize(value: string): string {
  if (!value) return 'Task completed.';
  return value.length <= 1000 ? value : `${value.slice(0, 997)}...`;
}

function normalizeTaskTargetSpace(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return toCanonicalSpaceId(trimmed) === CANONICAL_MAIN_SPACE_ID ? undefined : trimmed;
}

async function findProject(projectId: string): Promise<ProjectRecord | undefined> {
  return (await readProjects()).find((project) => project.id === projectId);
}

async function readProjects(): Promise<ProjectRecord[]> {
  try {
    const raw = await readFile(projectStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isProjectRecord) : [];
  } catch {
    return [];
  }
}

function projectStorePath(): string {
  return process.env.ZLEAP_WEB_PROJECTS_PATH ?? join(homedir(), '.zleap', 'projects.json');
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string' && typeof record.path === 'string';
}

async function resolveProjectRoot(projectPath: string, projectId: string): Promise<string> {
  const home = resolve(homedir());
  const resolved = resolve(projectPath);
  if (!resolved.startsWith(home)) {
    throw new Error(`project_path_not_allowed:${projectId}`);
  }
  try {
    return await realpath(resolved);
  } catch {
    throw new Error(`project_path_not_accessible:${projectId}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { CANONICAL_MAIN_SPACE_ID, toCanonicalSpaceId, type ScheduledTaskRecord, type ScheduledTaskRunRecord } from '@zleap/core';
import { isBuiltInScheduledTask, PgBossTaskQueue, TaskManagementService, type TaskActor, type TaskRuntimeDefaults } from '@zleap/tasks';
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode } from '../permissions';
import { storeFromEnv } from './avatarStore';

let queuePromise: Promise<PgBossTaskQueue> | undefined;

export async function withTaskService<T>(operation: (service: TaskManagementService) => Promise<T>): Promise<T> {
  const store = await storeFromEnv();
  if (!store) {
    throw new Error('database_required');
  }
  try {
    const queue = await taskQueueFromEnv();
    const service = new TaskManagementService({ store: store.tasks, queue });
    return await operation(service);
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function actorToTaskActor(actor: { userId: string; tenantId?: string; role?: string }): TaskActor {
  return { userId: actor.userId, tenantId: actor.tenantId, role: actor.role };
}

export function taskDefaultsFromBody(
  body: { avatarId?: string | null; projectId?: string | null; conversationId?: string | null; modelId?: string | null; permissionMode?: unknown; targetSpace?: string | null; timezone?: string | null },
  fallbackAvatarId: string,
): TaskRuntimeDefaults {
  return {
    avatarId: clean(body.avatarId) ?? fallbackAvatarId,
    projectId: clean(body.projectId),
    conversationId: clean(body.conversationId),
    modelConfigId: clean(body.modelId),
    permissionMode: normalizePermissionMode(body.permissionMode ?? DEFAULT_PERMISSION_MODE),
    targetSpace: cleanTargetSpace(body.targetSpace),
    timezone: clean(body.timezone),
  };
}

export function taskToJson(task: ScheduledTaskRecord, runs?: ScheduledTaskRunRecord[]): Record<string, unknown> {
  const builtin = isBuiltInScheduledTask(task);
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    builtin,
    deletable: !builtin,
    cron: task.cron,
    timezone: task.timezone,
    prompt: task.prompt,
    payload: task.payload,
    enabled: task.enabled,
    avatarId: task.avatarId,
    projectId: task.projectId,
    conversationId: task.conversationId,
    modelId: task.modelConfigId,
    permissionMode: task.permissionMode,
    targetSpace: task.targetSpace,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    deletedAt: task.deletedAt?.toISOString(),
    lastRunAt: runs?.find((run) => run.startedAt || run.scheduledFor)?.startedAt?.toISOString() ?? runs?.find((run) => run.scheduledFor)?.scheduledFor?.toISOString(),
    runs: runs?.map(taskRunToJson),
  };
}

export function isVisibleTaskInList(task: ScheduledTaskRecord): boolean {
  return !isBuiltInScheduledTask(task);
}

export function taskRunToJson(run: ScheduledTaskRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    taskId: run.taskId,
    queueJobId: run.queueJobId,
    mode: run.trigger,
    trigger: run.trigger,
    status: run.status,
    scheduledFor: run.scheduledFor?.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? run.scheduledFor?.toISOString() ?? new Date(0).toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    conversationId: run.conversationId,
    agentRunId: run.agentRunId,
    summary: run.summary,
    error: run.error,
    metadata: run.metadata,
  };
}

async function taskQueueFromEnv(): Promise<PgBossTaskQueue> {
  if (!queuePromise) {
    const connectionString = process.env.ZLEAP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('database_required');
    }
    queuePromise = (async () => {
      const queue = new PgBossTaskQueue({ connectionString, role: 'client' });
      await queue.start?.();
      return queue;
    })();
  }
  return queuePromise;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanTargetSpace(value: string | null | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) {
    return undefined;
  }
  return toCanonicalSpaceId(trimmed) === CANONICAL_MAIN_SPACE_ID ? undefined : trimmed;
}

import { CANONICAL_MAIN_SPACE_ID, toCanonicalSpaceId, type ScheduledTaskRecord, type ScheduledTaskRunRecord } from '@zleap/core';
import { normalizeCron, normalizeTimezone, systemTimezone } from './cron.js';
import { isBuiltInScheduledTask, type CreateTaskInput, type TaskActor, type TaskRuntimeDefaults, type TaskServiceDeps, type UpdateTaskInput } from './types.js';

const STALE_ACTIVE_RUN_SECONDS = positiveInteger(
  process.env.ZLEAP_TASK_ACTIVE_RUN_STALE_SECONDS ?? process.env.ZLEAP_TASK_EXPIRE_SECONDS,
  60 * 60,
);

export class TaskManagementService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async listTasks(actor: TaskActor, options: { all?: boolean; includeDeleted?: boolean } = {}): Promise<ScheduledTaskRecord[]> {
    return this.deps.store.listTasks({
      ...(options.all && actor.role === 'admin' ? {} : ownerOf(actor)),
      includeDeleted: options.includeDeleted,
    });
  }

  async createTask(actor: TaskActor, input: CreateTaskInput, defaults: TaskRuntimeDefaults): Promise<ScheduledTaskRecord> {
    const type = clean(input.type) ?? 'agent';
    const prompt = (input.prompt ?? '').trim();
    if (type === 'agent' && !prompt) throw new Error('prompt_required');
    const name = input.name?.trim() || 'Task';
    const id = this.idFactory();
    const projectId = input.projectId === undefined ? clean(defaults.projectId) : clean(input.projectId);
    const conversationId = clean(input.conversationId) ?? clean(defaults.conversationId) ?? `task:${id}`;
    const task = await this.deps.store.createTask({
      id,
      ...ownerOf(actor),
      avatarId: clean(input.avatarId) || defaults.avatarId,
      projectId,
      conversationId,
      modelConfigId: clean(input.modelConfigId) ?? clean(defaults.modelConfigId),
      permissionMode: input.permissionMode ?? defaults.permissionMode ?? 'request_approval',
      targetSpace: cleanTargetSpace(input.targetSpace) ?? cleanTargetSpace(defaults.targetSpace),
      name,
      type,
      prompt,
      payload: input.payload ?? undefined,
      cron: normalizeCron(input.cron),
      timezone: normalizeTimezone(clean(input.timezone), clean(defaults.timezone) ?? systemTimezone()),
      enabled: input.enabled ?? true,
    });
    await this.deps.queue.syncSchedule(task);
    return task;
  }

  async updateTask(actor: TaskActor, id: string, input: UpdateTaskInput): Promise<ScheduledTaskRecord> {
    const owner = actor.role === 'admin' ? undefined : ownerOf(actor);
    const patch: Parameters<typeof this.deps.store.updateTask>[1] = {};
    if (input.name !== undefined) patch.name = input.name.trim() || 'Task';
    if (input.type !== undefined) patch.type = clean(input.type) ?? 'agent';
    if (input.prompt !== undefined) patch.prompt = input.prompt.trim();
    if (input.payload !== undefined) patch.payload = input.payload ?? undefined;
    if (input.cron !== undefined) patch.cron = normalizeCron(input.cron);
    if (input.timezone !== undefined) patch.timezone = normalizeTimezone(clean(input.timezone));
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.avatarId !== undefined) patch.avatarId = clean(input.avatarId) ?? undefined;
    if (input.projectId !== undefined) patch.projectId = cleanPatch(input.projectId);
    if (input.conversationId !== undefined) patch.conversationId = cleanPatch(input.conversationId);
    if (input.modelConfigId !== undefined) patch.modelConfigId = cleanPatch(input.modelConfigId);
    if (input.permissionMode !== undefined) patch.permissionMode = input.permissionMode;
    if (input.targetSpace !== undefined) patch.targetSpace = cleanTargetSpacePatch(input.targetSpace);

    const task = await this.deps.store.updateTask(id, patch, owner);
    await this.deps.queue.syncSchedule(task);
    return task;
  }

  async deleteTask(actor: TaskActor, id: string): Promise<void> {
    const owner = actor.role === 'admin' ? undefined : ownerOf(actor);
    const task = await this.deps.store.getTask(id, owner);
    if (!task) throw new Error(`scheduled task "${id}" not found`);
    if (isBuiltInScheduledTask(task)) throw new Error('built_in_task_not_deletable');
    await this.deps.store.softDeleteTask(id, owner);
    await this.deps.queue.syncSchedule({ ...task, enabled: false, deletedAt: this.now() });
  }

  async runNow(actor: TaskActor, id: string): Promise<{ task: ScheduledTaskRecord; run: ScheduledTaskRunRecord }> {
    const owner = actor.role === 'admin' ? undefined : ownerOf(actor);
    const task = await this.deps.store.getTask(id, owner);
    if (!task) throw new Error(`scheduled task "${id}" not found`);
    await this.deps.store.reclaimStaleRuns(STALE_ACTIVE_RUN_SECONDS);
    await this.reclaimStaleActiveRuns(task.id);
    const run = await this.deps.store.createRun({
      id: this.idFactory().replace(/^task-/, 'run-'),
      taskId: task.id,
      trigger: 'manual',
      status: 'queued',
      scheduledFor: this.now(),
      conversationId: task.conversationId ?? `task:${task.id}`,
    });
    const queueJobId = await this.deps.queue.enqueueRun({ taskId: task.id, runId: run.id, trigger: 'manual', scheduledFor: run.scheduledFor });
    const updatedRun = queueJobId
      ? await this.deps.store.updateRun(run.id, { queueJobId })
      : await this.deps.store.updateRun(run.id, {
          status: 'skipped',
          finishedAt: this.now(),
          summary: await this.describeActiveRunConflict(task.id, run.id),
        });
    return { task, run: updatedRun };
  }

  async listRuns(actor: TaskActor, taskId: string, options: { limit?: number; offset?: number } = {}): Promise<ScheduledTaskRunRecord[]> {
    const owner = actor.role === 'admin' ? undefined : ownerOf(actor);
    const task = await this.deps.store.getTask(taskId, owner);
    if (!task) throw new Error(`scheduled task "${taskId}" not found`);
    return this.deps.store.listRuns({ taskId, ...(owner ?? {}), limit: options.limit, offset: options.offset });
  }

  private async describeActiveRunConflict(taskId: string, runId: string): Promise<string> {
    const activeRuns = await this.deps.store.listRuns({
      taskId,
      status: ['queued', 'running'],
      limit: 5,
    });
    const activeRun = activeRuns.find((candidate) => candidate.id !== runId);
    if (!activeRun) {
      return 'Skipped: pg-boss already has an active job for this task.';
    }
    const since = activeRun.startedAt ?? activeRun.scheduledFor;
    const ageSeconds = since ? Math.max(0, Math.round((this.now().getTime() - since.getTime()) / 1000)) : 0;
    return `Skipped: previous run ${activeRun.id} is still ${activeRun.status} after ${ageSeconds}s. Stale active runs older than ${STALE_ACTIVE_RUN_SECONDS}s are reclaimed before enqueue.`;
  }

  private async reclaimStaleActiveRuns(taskId: string): Promise<void> {
    const now = this.now();
    const activeRuns = await this.deps.store.listRuns({
      taskId,
      status: ['queued', 'running'],
      limit: 50,
    });
    await Promise.all(activeRuns.map(async (run) => {
      const since = run.startedAt ?? run.scheduledFor ?? now;
      const ageSeconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
      if (ageSeconds < STALE_ACTIVE_RUN_SECONDS) return;
      await this.deps.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: now,
        error: `reclaimed: active run exceeded ${STALE_ACTIVE_RUN_SECONDS}s before manual enqueue`,
      });
    }));
  }
}

function ownerOf(actor: TaskActor): { userId: string; tenantId?: string } {
  return { userId: actor.userId, tenantId: actor.tenantId };
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanPatch(value: string | null | undefined): string | null {
  return clean(value) ?? null;
}

function cleanTargetSpace(value: string | null | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) {
    return undefined;
  }
  return toCanonicalSpaceId(trimmed) === CANONICAL_MAIN_SPACE_ID ? undefined : trimmed;
}

function cleanTargetSpacePatch(value: string | null | undefined): string | null {
  return cleanTargetSpace(value) ?? null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

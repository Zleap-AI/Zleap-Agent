import { describe, expect, it, vi } from 'vitest';
import type { ScheduledTaskRecord, ScheduledTaskRunRecord, ScheduledTaskStore } from '@zleap/core';
import { TaskManagementService } from '../src/service.js';
import type { TaskQueue } from '../src/types.js';

describe('TaskManagementService', () => {
  it('creates scheduled tasks, syncs schedules, and enqueues manual runs', async () => {
    const store = new FakeTaskStore();
    const queue: TaskQueue = {
      syncSchedule: vi.fn(),
      enqueueRun: vi.fn().mockResolvedValue('job-1'),
    };
    const service = new TaskManagementService({
      store,
      queue,
      idFactory: sequence('task-1', 'run-1'),
      now: () => new Date('2026-06-16T10:00:00.000Z'),
    });

    const task = await service.createTask(
      { userId: 'u1', tenantId: 't1' },
      { name: 'Daily', prompt: 'Run report', cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      { avatarId: 'zleap-default' },
    );

    expect(task).toMatchObject({ id: 'task-1', userId: 'u1', tenantId: 't1', conversationId: 'task:task-1', cron: '0 9 * * *', timezone: 'Asia/Shanghai' });
    expect(queue.syncSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', enabled: true }));

    const result = await service.runNow({ userId: 'u1', tenantId: 't1' }, task.id);

    expect(result.run).toMatchObject({ id: 'run-1', taskId: 'task-1', trigger: 'manual', status: 'queued', queueJobId: 'job-1' });
    expect(queue.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', runId: 'run-1', trigger: 'manual' }));
  });

  it('rejects cron expressions with seconds', async () => {
    const service = new TaskManagementService({
      store: new FakeTaskStore(),
      queue: { syncSchedule: vi.fn(), enqueueRun: vi.fn() },
    });

    await expect(
      service.createTask(
        { userId: 'u1' },
        { prompt: 'Run report', cron: '0 0 9 * * *', timezone: 'UTC' },
        { avatarId: 'zleap-default' },
      ),
    ).rejects.toThrow('cron_must_have_5_fields');
  });

  it('uses conversation target when projectId is explicitly cleared on create', async () => {
    const service = new TaskManagementService({
      store: new FakeTaskStore(),
      queue: { syncSchedule: vi.fn(), enqueueRun: vi.fn() },
      idFactory: sequence('task-1'),
    });

    const task = await service.createTask(
      { userId: 'u1' },
      { prompt: 'Run report', cron: '0 9 * * *', projectId: null, conversationId: 'conv-1' },
      { avatarId: 'zleap-default', projectId: 'project-default' },
    );

    expect(task.projectId).toBeUndefined();
    expect(task.conversationId).toBe('conv-1');
  });

  it('creates project tasks as project-bound conversations', async () => {
    const service = new TaskManagementService({
      store: new FakeTaskStore(),
      queue: { syncSchedule: vi.fn(), enqueueRun: vi.fn() },
      idFactory: sequence('task-1'),
    });

    const task = await service.createTask(
      { userId: 'u1' },
      { prompt: 'Run report', cron: '0 9 * * *', projectId: 'project-1' },
      { avatarId: 'zleap-default' },
    );

    expect(task.projectId).toBe('project-1');
    expect(task.conversationId).toBe('task:task-1');
  });

  it('treats main and legacy session target spaces as the default task flow', async () => {
    const store = new FakeTaskStore();
    const service = new TaskManagementService({
      store,
      queue: { syncSchedule: vi.fn(), enqueueRun: vi.fn() },
      idFactory: sequence('task-1', 'task-2'),
    });

    const sessionTask = await service.createTask(
      { userId: 'u1' },
      { prompt: 'Run report', cron: '0 9 * * *', targetSpace: 'session' },
      { avatarId: 'zleap-default' },
    );
    const mainTask = await service.createTask(
      { userId: 'u1' },
      { prompt: 'Run report', cron: '0 9 * * *' },
      { avatarId: 'zleap-default', targetSpace: 'main' },
    );

    expect(sessionTask.targetSpace).toBeUndefined();
    expect(mainTask.targetSpace).toBeUndefined();
  });

  it('clears nullable runtime bindings on update', async () => {
    const store = new FakeTaskStore();
    const service = new TaskManagementService({
      store,
      queue: { syncSchedule: vi.fn(), enqueueRun: vi.fn() },
      idFactory: sequence('task-1'),
    });
    const task = await service.createTask(
      { userId: 'u1' },
      {
        name: 'Project task',
        prompt: 'Run report',
        cron: '0 9 * * *',
        projectId: 'project-1',
        conversationId: 'conv-1',
        modelConfigId: 'model-1',
        targetSpace: 'work',
        permissionMode: 'full_access',
      },
      { avatarId: 'zleap-default' },
    );

    const updated = await service.updateTask({ userId: 'u1' }, task.id, {
      projectId: null,
      conversationId: null,
      modelConfigId: null,
      targetSpace: null,
      permissionMode: 'request_approval',
    });

    expect(updated).toMatchObject({ permissionMode: 'request_approval' });
    expect(updated.projectId).toBeUndefined();
    expect(updated.conversationId).toBeUndefined();
    expect(updated.modelConfigId).toBeUndefined();
    expect(updated.targetSpace).toBeUndefined();
  });

  it('prevents built-in memory dream tasks from being deleted', async () => {
    const store = new FakeTaskStore();
    const syncSchedule = vi.fn();
    const service = new TaskManagementService({
      store,
      queue: { syncSchedule, enqueueRun: vi.fn() },
      idFactory: sequence('memory-dream-u1'),
    });
    const task = await service.createTask(
      { userId: 'u1' },
      { name: 'Memory Dream', type: 'memory_dream', cron: '0 3 * * *', payload: { mode: 'lazy' } },
      { avatarId: 'zleap-default' },
    );
    syncSchedule.mockClear();

    await expect(service.deleteTask({ userId: 'u1' }, task.id)).rejects.toThrow('built_in_task_not_deletable');

    expect(syncSchedule).not.toHaveBeenCalled();
    expect((await store.getTask(task.id))?.deletedAt).toBeUndefined();
    expect((await store.getTask(task.id))?.enabled).toBe(true);
  });
});

class FakeTaskStore implements ScheduledTaskStore {
  private readonly tasks = new Map<string, ScheduledTaskRecord>();
  private readonly runs = new Map<string, ScheduledTaskRunRecord>();

  async createTask(input: Parameters<ScheduledTaskStore['createTask']>[0]): Promise<ScheduledTaskRecord> {
    const now = new Date('2026-06-16T10:00:00.000Z');
    const task: ScheduledTaskRecord = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.tasks.set(task.id, task);
    return task;
  }

  async updateTask(id: string, patch: Parameters<ScheduledTaskStore['updateTask']>[1]): Promise<ScheduledTaskRecord> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('not found');
    const next = { ...task, ...patch, updatedAt: new Date('2026-06-16T10:00:00.000Z') };
    if (patch.projectId === null) delete next.projectId;
    if (patch.conversationId === null) delete next.conversationId;
    if (patch.modelConfigId === null) delete next.modelConfigId;
    if (patch.targetSpace === null) delete next.targetSpace;
    this.tasks.set(id, next);
    return next;
  }

  async getTask(id: string): Promise<ScheduledTaskRecord | undefined> {
    return this.tasks.get(id);
  }

  async listTasks(): Promise<ScheduledTaskRecord[]> {
    return [...this.tasks.values()];
  }

  async softDeleteTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, { ...task, enabled: false, deletedAt: new Date('2026-06-16T10:00:00.000Z') });
  }

  async createRun(input: Parameters<ScheduledTaskStore['createRun']>[0]): Promise<ScheduledTaskRunRecord> {
    const run: ScheduledTaskRunRecord = { ...input };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(id: string, patch: Parameters<ScheduledTaskStore['updateRun']>[1]): Promise<ScheduledTaskRunRecord> {
    const run = this.runs.get(id);
    if (!run) throw new Error('not found');
    const next = { ...run, ...patch };
    this.runs.set(id, next);
    return next;
  }

  async getRun(id: string): Promise<ScheduledTaskRunRecord | undefined> {
    return this.runs.get(id);
  }

  async listRuns(input: Parameters<ScheduledTaskStore['listRuns']>[0]): Promise<ScheduledTaskRunRecord[]> {
    return [...this.runs.values()].filter((run) => run.taskId === input.taskId);
  }

  async reclaimStaleRuns(): Promise<number> {
    return 0;
  }
}

function sequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

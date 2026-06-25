import type { ScheduledTaskRunRecord, ScheduledTaskRunStatus, ScheduledTaskStore } from '@zleap/core';
import type { TaskHandlerRegistry } from './registry.js';
import type { TaskRunRequest } from './types.js';

export type TaskExecutionDeps = {
  /** Remove an orphaned schedule when its task no longer exists/enabled. */
  unschedule?: (taskId: string) => Promise<void>;
  now?: () => Date;
};

/**
 * Executes a single task run. Concurrency/timeout/retry are owned by pg-boss;
 * this service only resolves the handler by `task.type`, runs it, and writes the
 * audit projection (scheduled_task_runs).
 */
export class TaskExecutionService {
  private readonly now: () => Date;
  private readonly unschedule?: (taskId: string) => Promise<void>;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly registry: TaskHandlerRegistry,
    deps: TaskExecutionDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.unschedule = deps.unschedule;
  }

  async handleRun(request: TaskRunRequest, signal?: AbortSignal): Promise<ScheduledTaskRunRecord | undefined> {
    const task = await this.store.getTask(request.taskId);
    if (!task || task.deletedAt) {
      await this.dropOrphanSchedule(request.taskId);
      return this.finalizeExistingRun(request, 'Task not found or deleted.');
    }
    if (request.trigger === 'scheduled' && !task.enabled) {
      await this.dropOrphanSchedule(request.taskId);
      return this.finalizeExistingRun(request, 'Task is disabled.');
    }

    let run = await this.ensureRun(request, task.id, task.conversationId);

    const handler = this.registry.resolve(task.type);
    if (!handler) {
      return this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: this.now(),
        error: `unknown_task_type:${task.type}`,
      });
    }

    run = await this.store.updateRun(run.id, {
      status: 'running',
      startedAt: this.now(),
      conversationId: run.conversationId ?? task.conversationId ?? `task:${task.id}`,
    });

    try {
      const result = await handler.run({ task, run }, signal);
      return this.store.updateRun(run.id, {
        status: result.status,
        finishedAt: this.now(),
        agentRunId: result.agentRunId,
        summary: result.summary,
        error: result.error,
        metadata: result.metadata,
      });
    } catch (error) {
      return this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureRun(request: TaskRunRequest, taskId: string, conversationId?: string): Promise<ScheduledTaskRunRecord> {
    if (request.runId) {
      const existing = await this.store.getRun(request.runId);
      if (existing) return existing;
    }
    return this.store.createRun({
      id: request.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      trigger: request.trigger,
      status: 'queued',
      scheduledFor: request.scheduledFor ?? this.now(),
      conversationId: conversationId ?? `task:${taskId}`,
    });
  }

  /**
   * Only touch a pre-existing audit row (e.g. a manual runNow that pre-created
   * one). For orphaned scheduled triggers there is no run row and we must NOT
   * create one (the task_id foreign key would fail).
   */
  private async finalizeExistingRun(request: TaskRunRequest, summary: string, status: ScheduledTaskRunStatus = 'skipped'): Promise<ScheduledTaskRunRecord | undefined> {
    if (!request.runId) return undefined;
    const existing = await this.store.getRun(request.runId);
    if (!existing) return undefined;
    return this.store.updateRun(existing.id, { status, finishedAt: this.now(), summary });
  }

  private async dropOrphanSchedule(taskId: string): Promise<void> {
    if (!this.unschedule) return;
    await this.unschedule(taskId).catch(() => undefined);
  }
}

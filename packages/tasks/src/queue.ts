import { PgBoss, type Job } from 'pg-boss';
import type { ScheduledTaskRecord } from '@zleap/core';
import { TASK_DLQ_QUEUE, TASK_RUN_QUEUE, type TaskQueue, type TaskRunRequest } from './types.js';

export type TaskQueueRole = 'client' | 'worker';

type PgBossTaskQueueOptions = {
  connectionString: string;
  /**
   * 'worker' owns the cron scheduler + maintenance (supervise) and runs jobs.
   * 'client' only enqueues/manages schedules (e.g. the web process).
   */
  role?: TaskQueueRole;
  /** Absolute ceiling for an active job before pg-boss fails/retries it. */
  expireInSeconds?: number;
  /** Worker heartbeat interval; a dead worker is reclaimed after this. */
  heartbeatSeconds?: number;
};

type RunJobData = {
  taskId?: string;
  runId?: string;
  trigger?: 'manual' | 'scheduled';
  scheduledFor?: string;
};

const DEFAULT_EXPIRE_SECONDS = 3600;
const DEFAULT_HEARTBEAT_SECONDS = 60;
const PGBOSS_KEY_SAFE = /^[A-Za-z0-9_.\-/]+$/;

export class PgBossTaskQueue implements TaskQueue {
  private readonly boss: PgBoss;
  private readonly isWorker: boolean;
  private readonly expireInSeconds: number;
  private readonly heartbeatSeconds: number;
  private stopping = false;

  constructor(options: PgBossTaskQueueOptions) {
    this.isWorker = (options.role ?? 'worker') === 'worker';
    this.expireInSeconds = options.expireInSeconds ?? DEFAULT_EXPIRE_SECONDS;
    this.heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      application_name: this.isWorker ? 'zleap-task-worker' : 'zleap-task-client',
      // Only the worker turns schedules into jobs and runs maintenance.
      schedule: this.isWorker,
      supervise: this.isWorker,
    });
  }

  async start(): Promise<void> {
    this.boss.on('error', (error: unknown) => {
      // pg-boss emits a benign "connection is not opened" assertion when an
      // in-flight poll loses the pool during graceful shutdown; ignore it.
      if (this.stopping) return;
      const detail = error instanceof Error ? (error.stack ?? error.message) : safeSerialize(error);
      process.stderr.write(`[task-queue] ${detail}\n`);
    });
    await this.boss.start();
    await this.ensureQueues();
  }

  /**
   * Idempotently ensure both queues exist with the desired policy/options.
   * Only the worker performs the destructive migration (pg-boss policy is
   * immutable, so a legacy queue with a different policy is dropped and
   * recreated; its schedules are restored afterwards by reconcileAll). The
   * client only ensures queues exist so schedule()'s queue foreign key holds.
   */
  private async ensureQueues(): Promise<void> {
    if (this.isWorker) {
      // Clean up the obsolete sync queue from the previous design.
      await this.boss.deleteQueue('zleap.task.sync').catch(() => undefined);

      const run = await this.boss.getQueue(TASK_RUN_QUEUE);
      if (run && run.policy !== 'stately') {
        for (const schedule of await this.boss.getSchedules(TASK_RUN_QUEUE)) {
          await this.boss.unschedule(TASK_RUN_QUEUE, schedule.key).catch(() => undefined);
        }
        await this.boss.deleteQueue(TASK_RUN_QUEUE).catch(() => undefined);
      }
    }

    // Dead-letter queue must exist before the run queue references it.
    await this.boss.createQueue(TASK_DLQ_QUEUE, {
      policy: 'standard',
      retryLimit: 0,
    });
    // Queue must exist before any schedule() (schedule has an FK to the queue).
    await this.boss.createQueue(TASK_RUN_QUEUE, {
      policy: 'stately',
      expireInSeconds: this.expireInSeconds,
      heartbeatSeconds: this.heartbeatSeconds,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 600,
      deadLetter: TASK_DLQ_QUEUE,
      deleteAfterSeconds: 7 * 24 * 3600,
    });

    if (this.isWorker) {
      // Reapply mutable options for an already-correct (pre-existing) run queue.
      await this.boss.updateQueue(TASK_RUN_QUEUE, {
        expireInSeconds: this.expireInSeconds,
        heartbeatSeconds: this.heartbeatSeconds,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 600,
        deadLetter: TASK_DLQ_QUEUE,
        deleteAfterSeconds: 7 * 24 * 3600,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.boss.stop({ graceful: true });
  }

  async syncSchedule(task: ScheduledTaskRecord): Promise<void> {
    const scheduleKey = scheduleKeyForTask(task.id);
    if (task.enabled && !task.deletedAt) {
      await this.boss.schedule(
        TASK_RUN_QUEUE,
        task.cron,
        { taskId: task.id, trigger: 'scheduled' },
        { tz: task.timezone, key: scheduleKey, singletonKey: scheduleKey },
      );
      return;
    }
    await this.unschedule(task.id);
  }

  async unschedule(taskId: string): Promise<void> {
    const scheduleKey = scheduleKeyForTask(taskId);
    await this.boss.unschedule(TASK_RUN_QUEUE, scheduleKey);
    if (scheduleKey !== taskId) {
      await this.boss.unschedule(TASK_RUN_QUEUE, taskId).catch(() => undefined);
    }
  }

  async enqueueRun(request: TaskRunRequest): Promise<string | undefined> {
    const id = await this.boss.send(
      TASK_RUN_QUEUE,
      {
        taskId: request.taskId,
        runId: request.runId,
        trigger: request.trigger,
        scheduledFor: request.scheduledFor?.toISOString(),
      },
      { singletonKey: scheduleKeyForTask(request.taskId) },
    );
    return id ?? undefined;
  }

  async workRuns(handler: (request: TaskRunRequest, signal?: AbortSignal) => Promise<void>): Promise<void> {
    await this.boss.work<RunJobData>(TASK_RUN_QUEUE, async ([job]: Job<RunJobData>[]) => {
      const request = runRequestFromJob(job);
      if (!request) return;
      await handler(request, job.signal);
    });
  }

  async workDeadLetter(handler: (request: TaskRunRequest) => Promise<void>): Promise<void> {
    await this.boss.work<RunJobData>(TASK_DLQ_QUEUE, async ([job]: Job<RunJobData>[]) => {
      const request = runRequestFromJob(job);
      if (!request) return;
      await handler(request);
    });
  }

  /** Schedule every enabled task; remove any schedule whose task is gone/disabled. */
  async reconcileAll(tasks: ScheduledTaskRecord[]): Promise<void> {
    const enabled = tasks.filter((task) => task.enabled && !task.deletedAt);
    const wanted = new Set(enabled.map((task) => scheduleKeyForTask(task.id)));
    for (const task of enabled) {
      await this.syncSchedule(task);
    }
    const existing = await this.boss.getSchedules(TASK_RUN_QUEUE);
    for (const schedule of existing) {
      if (!wanted.has(schedule.key)) {
        await this.boss.unschedule(TASK_RUN_QUEUE, schedule.key);
      }
    }
  }
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, Object.getOwnPropertyNames(value as object));
  } catch {
    return String(value);
  }
}

function runRequestFromJob(job: Job<RunJobData>): TaskRunRequest | undefined {
  const taskId = job.data?.taskId?.trim();
  if (!taskId) return undefined;
  const trigger = job.data?.trigger === 'manual' ? 'manual' : 'scheduled';
  const scheduledFor = job.data?.scheduledFor ? new Date(job.data.scheduledFor) : undefined;
  return {
    taskId,
    // Scheduled occurrences carry no runId in data; the job id is stable across
    // retries of the same occurrence, so reuse it as the audit run id.
    runId: job.data?.runId?.trim() || job.id,
    trigger,
    scheduledFor: scheduledFor && !Number.isNaN(scheduledFor.getTime()) ? scheduledFor : undefined,
  };
}

export function scheduleKeyForTask(taskId: string): string {
  if (PGBOSS_KEY_SAFE.test(taskId)) {
    return taskId;
  }
  return `task/${Buffer.from(taskId, 'utf8').toString('base64url')}`;
}

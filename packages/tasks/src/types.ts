import type {
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskRunTrigger,
  ScheduledTaskStore,
} from '@zleap/core';

export const TASK_RUN_QUEUE = 'zleap.task.run';
export const TASK_DLQ_QUEUE = 'zleap.task.run.dlq';
export const BUILT_IN_SCHEDULED_TASK_TYPES = new Set(['memory_dream']);

export function isBuiltInScheduledTask(task: Pick<ScheduledTaskRecord, 'type'>): boolean {
  return BUILT_IN_SCHEDULED_TASK_TYPES.has(task.type);
}

export type TaskActor = {
  userId: string;
  tenantId?: string;
  role?: string;
};

export type TaskRuntimeDefaults = {
  avatarId: string;
  projectId?: string | null;
  conversationId?: string | null;
  modelConfigId?: string | null;
  permissionMode?: ScheduledTaskRecord['permissionMode'];
  targetSpace?: string | null;
  timezone?: string | null;
};

export type CreateTaskInput = {
  name?: string;
  /** Handler type. Defaults to 'agent'. */
  type?: string;
  /** Agent prompt. Optional for non-agent task types. */
  prompt?: string;
  /** Handler-specific configuration. */
  payload?: Record<string, unknown> | null;
  cron: string;
  timezone?: string | null;
  enabled?: boolean;
  avatarId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  modelConfigId?: string | null;
  permissionMode?: ScheduledTaskRecord['permissionMode'];
  targetSpace?: string | null;
};

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'enabled'>> & {
  enabled?: boolean;
};

export type TaskRunRequest = {
  taskId: string;
  runId?: string;
  trigger: ScheduledTaskRunTrigger;
  scheduledFor?: Date;
};

export type TaskQueue = {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  syncSchedule(task: ScheduledTaskRecord): Promise<void>;
  enqueueRun(request: TaskRunRequest): Promise<string | undefined>;
  workRuns?(handler: (request: TaskRunRequest, signal?: AbortSignal) => Promise<void>): Promise<void>;
  workDeadLetter?(handler: (request: TaskRunRequest) => Promise<void>): Promise<void>;
  /** Two-way sync: schedule enabled tasks, unschedule everything else (orphans). */
  reconcileAll?(tasks: ScheduledTaskRecord[]): Promise<void>;
};

export type TaskRunResult = {
  status: 'completed' | 'failed';
  agentRunId?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type TaskRunContext = {
  task: ScheduledTaskRecord;
  run: ScheduledTaskRunRecord;
};

/**
 * A task handler implements the "what to do" for a given task `type`. The
 * pg-boss scheduling/concurrency/retry/dead-letter layer is type-agnostic; new
 * task types are added by registering a handler, with zero changes to the
 * queue/worker core.
 */
export interface TaskHandler {
  readonly type: string;
  /** Optional create-time validation of the task input/payload. */
  validate?(input: CreateTaskInput): void;
  run(ctx: TaskRunContext, signal?: AbortSignal): Promise<TaskRunResult>;
}

export type TaskServiceDeps = {
  store: ScheduledTaskStore;
  queue: TaskQueue;
  now?: () => Date;
  idFactory?: () => string;
};

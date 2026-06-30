import type { TaskHandler } from './types.js';

export const DEFAULT_TASK_TYPE = 'agent';

/**
 * Resolves a task `type` to its handler. New scheduled-task kinds (e.g. a
 * news-sync handler) are added by registering here, without touching the
 * pg-boss scheduling/concurrency/retry core.
 */
export class TaskHandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  register(handler: TaskHandler): this {
    if (this.handlers.has(handler.type)) {
      throw new Error(`task handler already registered for type "${handler.type}"`);
    }
    this.handlers.set(handler.type, handler);
    return this;
  }

  resolve(type: string | undefined): TaskHandler | undefined {
    return this.handlers.get(type?.trim() || DEFAULT_TASK_TYPE);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}

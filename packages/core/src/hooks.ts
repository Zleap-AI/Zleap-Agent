import type {
  AgentRuntimeHook,
  ArtifactHookContext,
  RunHookContext,
  SessionHookContext,
  SpaceHookContext,
  ToolHookContext,
  WorkHookContext,
} from './types.js';

export class AgentHookRegistry {
  private readonly hooks = new Set<AgentRuntimeHook>();

  register(hook: AgentRuntimeHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  async beforeRun(context: RunHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.beforeRun?.(context);
    }
  }

  async afterRun(context: RunHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterRun?.(context);
    }
  }

  async beforeWork(context: WorkHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.beforeWork?.(context);
    }
  }

  async afterWork(context: WorkHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterWork?.(context);
    }
  }

  async beforeSpace(context: SpaceHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.beforeSpace?.(context);
    }
  }

  async afterSpace(context: SpaceHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterSpace?.(context);
    }
  }

  async beforeToolCall(context: ToolHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.beforeToolCall?.(context);
    }
  }

  async afterToolCall(context: ToolHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterToolCall?.(context);
    }
  }

  async afterArtifact(context: ArtifactHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterArtifact?.(context);
    }
  }

  async afterSessionTouch(context: SessionHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterSessionTouch?.(context);
    }
  }
}

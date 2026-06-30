import type { AgentEvent, AgentEventHandler } from './types.js';

export class AgentEventBus {
  private readonly handlers = new Set<AgentEventHandler>();

  observe(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}


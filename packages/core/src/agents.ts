import type { AgentDefinition } from './types.js';

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): void {
    this.agents.set(definition.id, definition);
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

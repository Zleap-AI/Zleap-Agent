import type { ToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    this.tools.set(definition.id, definition);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}


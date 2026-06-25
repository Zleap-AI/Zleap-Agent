import type { WorkSpaceDefinition } from './types.js';

export class WorkSpaceRegistry {
  private readonly spaces = new Map<string, WorkSpaceDefinition>();

  register(definition: WorkSpaceDefinition): void {
    this.spaces.set(definition.id, definition);
  }

  get(id: string): WorkSpaceDefinition | undefined {
    return this.spaces.get(id);
  }

  list(): WorkSpaceDefinition[] {
    return [...this.spaces.values()];
  }
}


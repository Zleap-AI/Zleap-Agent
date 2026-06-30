import type { MemoryQuery, MemoryRecord } from './types.js';

export class MemoryRegistry {
  private readonly records = new Map<string, MemoryRecord>();

  register(record: MemoryRecord): void {
    this.records.set(record.id, record);
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  list(): MemoryRecord[] {
    return [...this.records.values()];
  }

  query(query: MemoryQuery = {}): MemoryRecord[] {
    const text = query.text?.trim().toLocaleLowerCase();
    const matches = this.list().filter((record) => {
      if (query.scope && record.scope !== query.scope) {
        return false;
      }
      if (query.agentId && record.agentId !== query.agentId) {
        return false;
      }
      if (query.sessionId && record.sessionId !== query.sessionId) {
        return false;
      }
      if (query.tags?.length && !query.tags.every((tag) => record.tags.includes(tag))) {
        return false;
      }
      if (text) {
        const haystack = `${record.title}\n${record.summary}`.toLocaleLowerCase();
        if (!haystack.includes(text)) {
          return false;
        }
      }
      return true;
    });

    return typeof query.limit === 'number' ? matches.slice(0, query.limit) : matches;
  }
}

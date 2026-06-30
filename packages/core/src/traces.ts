import type { TraceQuery, TraceRecord } from './types.js';

export class TraceStore {
  private readonly records: TraceRecord[] = [];

  append(record: TraceRecord): void {
    this.records.push(record);
  }

  list(): TraceRecord[] {
    return [...this.records];
  }

  query(query: TraceQuery = {}): TraceRecord[] {
    const matches = this.records.filter((record) => {
      if (query.runId && record.runId !== query.runId) {
        return false;
      }
      if (query.workId && record.workId !== query.workId) {
        return false;
      }
      if (query.stepId && record.stepId !== query.stepId) {
        return false;
      }
      if (query.kind && record.kind !== query.kind) {
        return false;
      }
      if (query.type && record.type !== query.type) {
        return false;
      }
      return true;
    });

    return typeof query.limit === 'number' ? matches.slice(0, query.limit) : matches;
  }
}

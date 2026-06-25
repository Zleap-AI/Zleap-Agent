import type { AgentNote, AgentNoteStore, RecordScope, WriteAgentNoteInput } from '@zleap/core';
import type {
  CoreEvent,
  CoreEventDetail,
  CoreSource,
  CoreStore,
  EnsureSourceInput,
  InsertEventInput,
  ListEventsQuery,
  RecallHit,
  RecallInput,
} from '@zleap/store';

/** In-memory A 线 note store mirroring the production FIFO/scoping contract. */
export class FakeNoteStore implements AgentNoteStore {
  rows: AgentNote[] = [];
  private seq = 0;

  async write(input: WriteAgentNoteInput, limit = 20): Promise<AgentNote> {
    const now = new Date(Date.now() + (this.seq += 1));
    const existing = input.id ? this.rows.find((row) => row.id === input.id) : undefined;
    if (existing) {
      existing.memory = input.memory;
      existing.subject = input.kind === 'impression' ? (input.subject ?? existing.subject ?? 'user') : undefined;
      existing.status = 'active';
      existing.updatedAt = now;
      return existing;
    }
    const note: AgentNote = {
      id: input.id ?? `note_${this.seq}`,
      kind: input.kind,
      agentId: input.scope.agentId,
      userId: input.kind === 'impression' ? input.scope.userId : undefined,
      spaceId: undefined,
      threadId: input.scope.threadId,
      subject: input.kind === 'impression' ? (input.subject ?? 'user') : undefined,
      memory: input.memory,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(note);
    const peers = this.rows
      .filter((r) =>
        r.status === 'active' &&
        r.kind === note.kind &&
        r.agentId === note.agentId &&
        r.userId === note.userId &&
        (note.kind !== 'impression' || (r.subject ?? 'user') === (note.subject ?? 'user')))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const stale of peers.slice(limit)) stale.status = 'archived';
    return note;
  }

  async listRecent({ kind, scope, limit = 20 }: Parameters<AgentNoteStore['listRecent']>[0]): Promise<AgentNote[]> {
    return this.rows
      .filter((r) =>
        r.status === 'active' &&
        r.kind === kind &&
        r.agentId === scope.agentId &&
        r.userId === scope.userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async getById(id: string): Promise<AgentNote | undefined> {
    return this.rows.find((r) => r.id === id && r.status === 'active');
  }
  async archive(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = 'archived';
  }
  async purgeByAgent(agentId: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.agentId !== agentId);
  }
  async archiveBySpace(): Promise<void> {
    // New experience memories are core records, not space-scoped notes.
  }
  async purgeByUser({ agentId, userId }: { agentId: string; userId: string }): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.kind === 'impression' && r.agentId === agentId && r.userId === userId));
  }
}

type StoredSource = CoreSource;
type StoredEvent = CoreEvent & { sourceId: string };

/** Minimal in-memory B 线 core engine: source dedupe, event insert, lexical recall. */
export class FakeCoreStore implements CoreStore {
  sources: StoredSource[] = [];
  events: StoredEvent[] = [];
  lastRecallInput: RecallInput | undefined;
  private seq = 0;

  private scopeKey(input: EnsureSourceInput): string {
    const s = input.scope;
    return [input.groupId, input.kind, s.agentId, s.userId ?? '', s.tenantId ?? '', s.spaceId ?? '', s.threadId ?? ''].join('|');
  }

  async ensureSource(input: EnsureSourceInput): Promise<CoreSource> {
    const key = this.scopeKey(input);
    const existing = this.sources.find((src) => this.sourceKey(src, input.groupId, input.kind) === key);
    if (existing) return existing;
    const now = new Date(Date.now() + (this.seq += 1));
    const source: StoredSource = {
      id: `src_${this.seq}`,
      groupId: input.groupId,
      kind: input.kind,
      agentId: input.scope.agentId,
      userId: input.scope.userId,
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      threadId: input.scope.threadId,
      name: input.name,
      metadata: input.metadata,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.sources.push(source);
    return source;
  }

  private sourceKey(src: CoreSource, groupId: string, kind: string): string {
    return [groupId, kind, src.agentId, src.userId ?? '', src.tenantId ?? '', src.spaceId ?? '', src.threadId ?? ''].join('|');
  }

  async getSource(id: string): Promise<CoreSource | undefined> {
    return this.sources.find((s) => s.id === id);
  }

  async insertEvent(input: InsertEventInput): Promise<CoreEvent> {
    if (input.contentHash) {
      const dupe = this.events.find((e) => e.sourceId === input.sourceId && e.contentHash === input.contentHash);
      if (dupe) return dupe;
    }
    const now = new Date(Date.now() + (this.seq += 1));
    const event: StoredEvent = {
      id: input.id ?? `evt_${this.seq}`,
      sourceId: input.sourceId,
      memory: input.memory,
      metadata: input.metadata,
      keywords: input.keywords ?? [],
      messageIds: input.messageIds,
      contentHash: input.contentHash,
      relationId: input.relationId,
      supersedesId: input.supersedesId,
      confidence: input.confidence,
      status: input.status ?? 'active',
      validUntil: input.validUntil,
      createdAt: now,
      updatedAt: now,
    };
    this.events.push(event);
    return event;
  }

  async getEvent(id: string): Promise<CoreEvent | undefined> {
    return this.events.find((e) => e.id === id);
  }
  async findEventByHash(sourceId: string, contentHash: string): Promise<CoreEvent | undefined> {
    return this.events.find((e) => e.sourceId === sourceId && e.contentHash === contentHash);
  }
  async detail(id: string): Promise<CoreEventDetail | undefined> {
    const event = this.events.find((e) => e.id === id);
    if (!event) return undefined;
    const source = this.sources.find((s) => s.id === event.sourceId)!;
    return { ...event, source, entities: [] };
  }

  private sourceIdsForScope(query: { groupId: string; kind?: string; scope: ListEventsQuery['scope'] }): string[] {
    return this.sources
      .filter(
        (s) =>
          s.groupId === query.groupId &&
          (query.kind === undefined || s.kind === query.kind) &&
          s.agentId === query.scope.agentId &&
          (query.scope.userId === undefined || s.userId === query.scope.userId) &&
          (query.scope.tenantId === undefined || s.tenantId === query.scope.tenantId) &&
          (query.scope.spaceId === undefined || s.spaceId === query.scope.spaceId) &&
          (query.scope.threadId === undefined || s.threadId === query.scope.threadId),
      )
      .map((s) => s.id);
  }

  async listEvents(query: ListEventsQuery): Promise<CoreEvent[]> {
    const ids = new Set(this.sourceIdsForScope(query));
    return this.events
      .filter((e) => ids.has(e.sourceId) && e.status === 'active')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.limit ?? 50);
  }

  async recall(input: RecallInput): Promise<RecallHit[]> {
    this.lastRecallInput = input;
    const ids = new Set(this.sourceIdsForScope(input));
    const needle = input.queryText.trim().toLowerCase();
    return this.events
      .filter((e) => ids.has(e.sourceId) && e.status === 'active')
      .filter((e) => !needle || e.memory.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 10)
      .map((e) => ({ ...e, score: 1, paths: ['lexical'] }));
  }

  async setEventStatus(
    id: string,
    status: CoreEvent['status'],
    input?: Parameters<CoreStore['setEventStatus']>[2],
  ): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (!event) return;
    event.status = status;
    event.updatedAt = input?.supersededAt ?? new Date();
    event.supersededBy = input?.supersededBy ?? event.supersededBy;
    event.supersededAt = input?.supersededAt ?? event.supersededAt;
  }

  async deleteByThread({ groupId, agentId, threadId, kind }: { groupId: string; agentId: string; threadId: string; kind?: string }): Promise<void> {
    const drop = new Set(
      this.sources
        .filter((s) => s.groupId === groupId && s.agentId === agentId && s.threadId === threadId && (kind === undefined || s.kind === kind))
        .map((s) => s.id),
    );
    this.sources = this.sources.filter((s) => !drop.has(s.id));
    this.events = this.events.filter((e) => !drop.has(e.sourceId));
  }

  async purgeByAgent({ agentId, groupId }: { agentId: string; groupId?: string }): Promise<void> {
    const drop = new Set(
      this.sources.filter((s) => s.agentId === agentId && (groupId === undefined || s.groupId === groupId)).map((s) => s.id),
    );
    this.sources = this.sources.filter((s) => !drop.has(s.id));
    this.events = this.events.filter((e) => !drop.has(e.sourceId));
  }
}

import {
  DEFAULT_AVATAR_ID,
  type AgentNote,
  type AgentNoteStore,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
  type WriteAgentNoteInput,
} from '@zleap/core';
import type { CoreEvent, CoreEventDetail, CoreSource, CoreStore, InsertEventInput, ListEventsQuery, RecallInput, ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from '../app/api/memory/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

/** In-memory A 线 note store mirroring the production contract closely enough. */
class FakeNoteStore implements AgentNoteStore {
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
  async purgeByAgent(): Promise<void> {}
  async archiveBySpace(): Promise<void> {}
  async purgeByUser(): Promise<void> {}
}

type TestStore = {
  notes: FakeNoteStore;
  core: CoreStore & {
    events: CoreEvent[];
    sources: CoreSource[];
    source: CoreSource;
  };
  tasks: {
    taskRows: ScheduledTaskRecord[];
    runRows: ScheduledTaskRunRecord[];
    listTasks: (input?: { userId?: string; tenantId?: string; includeDeleted?: boolean; limit?: number }) => Promise<ScheduledTaskRecord[]>;
    listRuns: (input: { taskId?: string; userId?: string; tenantId?: string; status?: ScheduledTaskRunRecord['status']; limit?: number }) => Promise<ScheduledTaskRunRecord[]>;
  };
  embedText: (text: string) => Promise<number[]>;
  close: ReturnType<typeof vi.fn>;
};

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/memory route actor scope', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('rejects requests without an actor header', async () => {
    const response = await GET(new Request('http://localhost/api/memory'));
    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('lists only memories in the actor partition', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    await POST(actorRequest('POST', undefined, { memory: 'u1 only' }));
    await POST(actorRequest('POST', undefined, { memory: 'u2 only' }, 'u2'));

    const response = await GET(actorRequest('GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as { memories: Array<{ memory: string; userId?: string; subject?: string }> };
    expect(json.memories.map((memory) => memory.memory)).toEqual(['u1 only']);
    expect(json.memories[0]).toMatchObject({ userId: 'u1', subject: 'user' });
  });

  it('lists core records as event memories', async () => {
    const store = makeStore();
    store.core.events.push({
      id: 'evt_1',
      sourceId: store.core.source.id,
      memory: 'User asked the assistant to summarize recent AI news.',
      metadata: { workKind: 'process' },
      keywords: ['ai', 'news'],
      messageIds: ['conversation:demo:messages:0-7:0'],
      status: 'active',
      createdAt: new Date('2026-06-15T01:02:03.000Z'),
      updatedAt: new Date('2026-06-15T01:02:03.000Z'),
    });
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as { memories: Array<{ kind: string; memory: string; userId?: string; messageIds?: string[]; workKind?: string }> };
    expect(json.memories).toEqual([
      expect.objectContaining({
        kind: 'event',
        memory: 'User asked the assistant to summarize recent AI news.',
        userId: 'u1',
        workKind: 'process',
        messageIds: ['conversation:demo:messages:0-7:0'],
      }),
    ]);
  });

  it('lists experience memories by agent only', async () => {
    const store = makeStore();
    const source = await store.core.ensureSource({
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: DEFAULT_AVATAR_ID },
    });
    await store.core.insertEvent({
      id: 'exp_1',
      sourceId: source.id,
      memory: 'For deployment tasks, run a dry-run before write operations.',
      keywords: ['deployment', 'dry-run'],
    });
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as { memories: Array<{ kind: string; memory: string; userId?: string; spaceId?: string }> };
    expect(json.memories).toEqual([
      expect.objectContaining({
        kind: 'experience',
        memory: 'For deployment tasks, run a dry-run before write operations.',
      }),
    ]);
    expect(json.memories[0]).not.toHaveProperty('userId');
    expect(json.memories[0]).not.toHaveProperty('spaceId');
  });

  it('returns memory dream summary when a dream task exists', async () => {
    const store = makeStore();
    store.tasks.taskRows.push({
      id: 'memory_dream_zleap-local-dev-user',
      userId: 'u1',
      tenantId: 't1',
      avatarId: DEFAULT_AVATAR_ID,
      permissionMode: 'full_access',
      name: 'Memory Dream',
      type: 'memory_dream',
      prompt: '',
      cron: '0 3 * * *',
      timezone: 'UTC',
      enabled: true,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      updatedAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    store.tasks.runRows.push({
      id: 'dream_run_1',
      taskId: 'memory_dream_zleap-local-dev-user',
      trigger: 'manual',
      status: 'completed',
      scheduledFor: new Date('2026-06-15T01:00:00.000Z'),
      startedAt: new Date('2026-06-15T01:00:01.000Z'),
      finishedAt: new Date('2026-06-15T01:00:10.000Z'),
      summary: 'person=1 event=1 experience=1',
      metadata: { person: 1, event: 1, experience: 1 },
    });
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as {
      dream?: {
        status?: string;
        taskId?: string;
        lastRunAt?: string;
        runs?: Array<{ id: string; status: string; summary?: string }>;
      };
    };
    expect(json.dream).toMatchObject({
      status: 'completed',
      taskId: 'memory_dream_zleap-local-dev-user',
      lastRunAt: '2026-06-15T01:00:10.000Z',
      runs: [expect.objectContaining({ id: 'dream_run_1', status: 'completed', summary: 'person=1 event=1 experience=1' })],
    });
  });

  it('creates manual memories in the actor partition', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await POST(actorRequest('POST', undefined, { memory: 'Name: u1 manual' }));
    await expectStatus(response, 201);
    expect(store.notes.rows.filter((r) => r.status === 'active' && r.userId === 'u1')).toHaveLength(1);
    expect(store.notes.rows.filter((r) => r.status === 'active' && r.userId === 'u2')).toHaveLength(0);
  });

  it('creates manual experience without user or space scope', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await POST(actorRequest('POST', undefined, {
      kind: 'experience',
      memory: 'For risky write tasks, dry-run first.',
    }));
    await expectStatus(response, 201);
    const json = (await response.json()) as { memory: { kind: string; userId?: string; spaceId?: string } };
    expect(json.memory).toMatchObject({ kind: 'experience' });
    expect(json.memory).not.toHaveProperty('userId');
    expect(json.memory).not.toHaveProperty('spaceId');
    const source = store.core.sources.find((row) => row.kind === 'experience');
    expect(source).toMatchObject({ agentId: DEFAULT_AVATAR_ID, userId: undefined, spaceId: undefined });
  });

  it('keeps agent-subject impressions scoped to the actor user', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await POST(actorRequest('POST', undefined, { memory: 'Assistant name: Call the assistant Z', targetType: 'agent' }));
    await expectStatus(response, 201);

    const row = store.notes.rows.find((r) => r.status === 'active');
    expect(row).toMatchObject({ userId: 'u1', subject: 'agent' });
  });

  it('rejects global agent self memories from normal users', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await POST(actorRequest('POST', undefined, {
      memory: 'Assistant name: Call the assistant Atlas globally',
      targetType: 'agent',
      visibility: 'global',
    }));
    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'global_agent_self_memory_forbidden' });
    expect(store.notes.rows).toHaveLength(0);
  });

  it('lets creator write global agent self memories visible to all users of that agent only', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const created = await POST(actorRequest('POST', undefined, {
      memory: 'Assistant name: Call the assistant Atlas globally',
      targetType: 'agent',
      visibility: 'global',
    }, 'creator-1', 'creator'));
    await expectStatus(created, 201);
    expect(store.notes.rows.find((r) => r.status === 'active')).toMatchObject({
      agentId: DEFAULT_AVATAR_ID,
      userId: undefined,
      subject: 'agent',
    });

    const sameAgent = await GET(actorRequest('GET', undefined, undefined, 'u2'));
    await expectStatus(sameAgent, 200);
    const sameAgentJson = (await sameAgent.json()) as { memories: Array<{ memory: string; subject?: string }> };
    expect(sameAgentJson.memories).toEqual([
      expect.objectContaining({ memory: 'Assistant name: Call the assistant Atlas globally', subject: 'agent' }),
    ]);

    const otherAgent = await GET(actorRequest('GET', '?agentId=other-agent', undefined, 'u2'));
    await expectStatus(otherAgent, 200);
    const otherAgentJson = (await otherAgent.json()) as { memories: unknown[] };
    expect(otherAgentJson.memories).toEqual([]);
  });

  it('scopes delete by actor owner', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    const created = await POST(actorRequest('POST', undefined, { memory: 'Name: u1 original' }));
    const { memory } = (await created.json()) as { memory: { id: string } };

    const deniedDelete = await DELETE(actorRequest('DELETE', undefined, { id: memory.id }, 'u2'));
    await expectStatus(deniedDelete, 400);
    expect(store.notes.rows.find((r) => r.id === memory.id)?.status).toBe('active');

    const allowedDelete = await DELETE(actorRequest('DELETE', undefined, { id: memory.id }));
    await expectStatus(allowedDelete, 200);
    expect(store.notes.rows.find((r) => r.id === memory.id)?.status).toBe('archived');
  });
});

function makeStore(): TestStore {
  const now = new Date('2026-06-15T00:00:00.000Z');
  const source: CoreSource = {
    id: 'src_1',
    groupId: 'memory',
    kind: 'work',
    agentId: DEFAULT_AVATAR_ID,
    userId: 'u1',
    tenantId: 't1',
    spaceId: 'session',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  const sources: CoreSource[] = [source];
  const events: CoreEvent[] = [];
  const taskRows: ScheduledTaskRecord[] = [];
  const runRows: ScheduledTaskRunRecord[] = [];
  return {
    notes: new FakeNoteStore(),
    core: {
      events,
      sources,
      source,
      ensureSource: async (input) => {
        const match = sources.find((row) =>
          row.groupId === input.groupId &&
          row.kind === input.kind &&
          row.agentId === input.scope.agentId &&
          row.userId === input.scope.userId &&
          row.tenantId === input.scope.tenantId &&
          row.spaceId === input.scope.spaceId &&
          row.threadId === input.scope.threadId);
        if (match) return match;
        const created: CoreSource = {
          id: `src_${sources.length + 1}`,
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
        sources.push(created);
        return created;
      },
      getSource: async (id) => sources.find((row) => row.id === id),
      insertEvent: async (input: InsertEventInput) => {
        const event: CoreEvent = {
          id: input.id ?? `evt_${events.length + 1}`,
          sourceId: input.sourceId,
          memory: input.memory,
          metadata: input.metadata,
          keywords: input.keywords ?? [],
          messageIds: input.messageIds,
          contentHash: input.contentHash,
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          confidence: input.confidence,
          validUntil: input.validUntil,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        events.push(event);
        return event;
      },
      getEvent: async (id) => events.find((row) => row.id === id),
      findEventByHash: async (sourceId, contentHash) => events.find((row) => row.sourceId === sourceId && row.contentHash === contentHash),
      listEvents: async (query: ListEventsQuery) => events
        .filter((event) => event.status === 'active')
        .filter((event) => {
          const row = sources.find((item) => item.id === event.sourceId);
          if (!row || row.status !== 'active') return false;
          if (row.groupId !== query.groupId) return false;
          if (query.kind && row.kind !== query.kind) return false;
          if (row.agentId !== query.scope.agentId) return false;
          if (query.scope.userId !== undefined && row.userId !== query.scope.userId) return false;
          if (query.scope.tenantId !== undefined && row.tenantId !== query.scope.tenantId) return false;
          if (query.scope.spaceId !== undefined && row.spaceId !== query.scope.spaceId) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, query.limit ?? 20),
      recall: async (_input: RecallInput) => [],
      detail: async (id) => {
        const event = events.find((row) => row.id === id);
        const detailSource = event ? sources.find((row) => row.id === event.sourceId) : undefined;
        return event && detailSource ? { ...event, source: detailSource, entities: [] } : undefined;
      },
      setEventStatus: async (id, status, input) => {
        const event = events.find((row) => row.id === id);
        if (!event) return;
        event.status = status;
        event.updatedAt = input?.supersededAt ?? new Date();
        event.supersededBy = input?.supersededBy ?? event.supersededBy;
        event.supersededAt = input?.supersededAt ?? event.supersededAt;
      },
      deleteByThread: async () => {},
      purgeByAgent: async () => {},
    },
    tasks: {
      taskRows,
      runRows,
      listTasks: async (input = {}) => taskRows
        .filter((task) => input.includeDeleted || !task.deletedAt)
        .filter((task) => input.userId === undefined || task.userId === input.userId)
        .filter((task) => input.tenantId === undefined || task.tenantId === input.tenantId)
        .slice(0, input.limit ?? 50),
      listRuns: async (input) => runRows
        .filter((run) => input.taskId === undefined || run.taskId === input.taskId)
        .filter((run) => input.status === undefined || run.status === input.status)
        .sort((a, b) => {
          const left = a.finishedAt ?? a.startedAt ?? a.scheduledFor ?? new Date(0);
          const right = b.finishedAt ?? b.startedAt ?? b.scheduledFor ?? new Date(0);
          return right.getTime() - left.getTime();
        })
        .slice(0, input.limit ?? 50),
    },
    embedText: async (text) => [text.length],
    close: vi.fn(async () => {}),
  };
}

function actorRequest(method: string, query = '', body?: unknown, userId = 'u1', role: 'user' | 'creator' | 'admin' = 'user'): Request {
  return new Request(`http://localhost/api/memory${query}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-zleap-user-id': userId,
      'x-zleap-actor-role': role,
      'x-zleap-tenant-id': 't1',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

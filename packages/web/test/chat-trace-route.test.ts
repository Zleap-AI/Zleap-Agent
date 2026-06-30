import {
  DEFAULT_AVATAR_ID,
  type LedgerEventRecord,
  type SessionEntryRecord,
  type SpaceSessionRecord,
  type ThreadRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/chat/trace/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/chat/trace route', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('requires actor identity before reading the store', async () => {
    const response = await GET(new Request('http://localhost/api/chat/trace'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects invalid entry type before reading the store', async () => {
    const response = await GET(actorRequest('?type=raw_json'));

    await expectStatus(response, 400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_entry_type', type: 'raw_json' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects raw trace reads for non-admin actors before reading the store', async () => {
    const response = await GET(actorRequest('?raw=1'));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects raw trace reads for admin actors without explicit debug permission', async () => {
    const response = await GET(actorRequest('?raw=1', 'u1', 'admin'));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('reads the latest actor-owned thread entries with projection filters', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?projectionKind=artifact_handoff&limit=25'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body).toMatchObject({
      conversationId: 'conversation-1',
      threadId: 'web:conversation-1',
      sessionId: 'web:conversation-1:main',
      entries: [
        {
          id: 'entry-1',
          hasContent: true,
          contentLength: 38,
          data: {
            projectionKind: 'artifact_handoff',
            source: 'artifact_produced',
            artifactId: 'artifact-1',
            sourceRefs: [{ table: 'artifacts', ids: ['artifact-1'] }],
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret query');
    expect(JSON.stringify(body)).not.toContain('secret result');
    expect(JSON.stringify(body)).not.toContain('secret artifact payload');
    const entry = (body.entries as Array<Record<string, unknown>>)[0];
    expect(entry).not.toHaveProperty('content');
    expect(entry.data).not.toHaveProperty('input');
    expect(entry.data).not.toHaveProperty('result');
    expect(entry.data).not.toHaveProperty('artifact');
    expect(store.threadQueries).toEqual([{ avatarId: DEFAULT_AVATAR_ID, userId: 'u1', tenantId: 't1', limit: 1 }]);
    expect(store.entryQueries).toEqual([{
      sessionId: 'web:conversation-1:main',
      userId: 'u1',
      tenantId: 't1',
      type: undefined,
      projectionKind: 'artifact_handoff',
      limit: 25,
    }]);
    expect(store.ledgerEvents).toEqual([]);
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('allows admin actors with debug permission to request raw trace entries explicitly', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?raw=true', 'u1', 'admin', 'debug:trace:raw'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.entries).toMatchObject([
      {
        id: 'entry-1',
        content: 'handoff summary with sensitive payload',
        data: {
          input: { query: 'secret query' },
          result: 'secret result',
          artifact: { data: 'secret artifact payload' },
        },
      },
    ]);
    expect(store.entryQueries).toEqual([{
      sessionId: 'web:conversation-1:main',
      userId: 'u1',
      tenantId: 't1',
      type: undefined,
      projectionKind: undefined,
      limit: undefined,
    }]);
    expect(store.ledgerEvents).toHaveLength(1);
    expect(store.ledgerEvents[0]).toMatchObject({
      id: expect.stringMatching(/^chat_trace_raw_read:web:conversation-1:web:conversation-1:main:\d+$/),
      threadId: 'web:conversation-1',
      sessionId: 'web:conversation-1:main',
      userId: 'u1',
      tenantId: 't1',
      type: 'chat_trace_raw_read',
      data: {
        avatarId: DEFAULT_AVATAR_ID,
        conversationId: 'conversation-1',
        sessionKind: 'main',
        filters: {},
        entryCount: 1,
      },
    });
    expect(JSON.stringify(store.ledgerEvents[0])).not.toContain('secret query');
    expect(JSON.stringify(store.ledgerEvents[0])).not.toContain('secret result');
    expect(JSON.stringify(store.ledgerEvents[0])).not.toContain('secret artifact payload');
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('includes provider tool-call ledger events in raw trace responses', async () => {
    const store = makeStore();
    store.ledgerEvents.push({
      id: 'provider-1',
      threadId: 'web:conversation-1',
      sessionId: 'web:conversation-1:main',
      userId: 'u1',
      tenantId: 't1',
      type: 'after_provider_response',
      data: {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            name: 'write',
            rawArgumentsLength: 128,
            argumentsParseError: 'Unexpected end of JSON input',
            preview: '{"path":"/tmp/create_ppt.py"',
          },
        ],
      },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    });
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?raw=true', 'u1', 'admin', 'debug:trace:raw'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.ledgerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider-1',
          type: 'after_provider_response',
          data: expect.objectContaining({
            toolCalls: [
              expect.objectContaining({
                name: 'write',
                rawArgumentsLength: 128,
                argumentsParseError: 'Unexpected end of JSON input',
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it('reads an explicit conversation id through the actor-owned web thread', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation 1&type=tool_result'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({ conversationId: 'conversation-1' });
    expect(store.getThreadQueries).toEqual([{ id: 'web:conversation-1', input: { userId: 'u1', tenantId: 't1' } }]);
    expect(store.entryQueries).toEqual([{
      sessionId: 'web:conversation-1:main',
      userId: 'u1',
      tenantId: 't1',
      type: 'tool_result',
      projectionKind: undefined,
      limit: undefined,
    }]);
  });

  it('reads an explicit child session id through the actor-owned session', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?sessionId=web:conversation-1:terminal:step-1&projectionKind=tool_execution_record'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      conversationId: 'conversation-1',
      threadId: 'web:conversation-1',
      sessionId: 'web:conversation-1:terminal:step-1',
      sessionKind: 'work',
      spaceId: 'terminal',
      entries: [
        {
          id: 'entry-1',
          data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' },
        },
      ],
    });
    expect(store.sessionQueries).toEqual([{
      id: 'web:conversation-1:terminal:step-1',
      input: { userId: 'u1', tenantId: 't1' },
    }]);
    expect(store.getThreadQueries).toEqual([{ id: 'web:conversation-1', input: { userId: 'u1', tenantId: 't1' } }]);
    expect(store.entryQueries).toEqual([{
      sessionId: 'web:conversation-1:terminal:step-1',
      userId: 'u1',
      tenantId: 't1',
      type: undefined,
      projectionKind: 'tool_execution_record',
      limit: undefined,
    }]);
  });

  it('does not reveal a thread owned by another actor', async () => {
    const store = makeStore({ ownerUserId: 'u1' });
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1', 'u2'));

    await expectStatus(response, 404);
    await expect(response.json()).resolves.toMatchObject({ error: 'thread_not_found' });
    expect(store.entryQueries).toEqual([]);
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('does not reveal a child session owned by another actor', async () => {
    const store = makeStore({ ownerUserId: 'u1' });
    storeFromEnvMock.mockResolvedValue(store.store as unknown as ZleapStore);

    const response = await GET(actorRequest('?sessionId=web:conversation-1:terminal:step-1', 'u2'));

    await expectStatus(response, 404);
    await expect(response.json()).resolves.toMatchObject({ error: 'session_not_found' });
    expect(store.getThreadQueries).toEqual([]);
    expect(store.entryQueries).toEqual([]);
    expect(store.close).toHaveBeenCalledOnce();
  });
});

type TestStore = {
  close: ReturnType<typeof vi.fn>;
  threadQueries: unknown[];
  getThreadQueries: unknown[];
  sessionQueries: unknown[];
  entryQueries: unknown[];
  ledgerEvents: LedgerEventRecord[];
  store: Partial<ZleapStore>;
};

function makeStore(options: { ownerUserId?: string } = {}): TestStore {
  const ownerUserId = options.ownerUserId ?? 'u1';
  const thread: ThreadRecord = {
    id: 'web:conversation-1',
    avatarId: DEFAULT_AVATAR_ID,
    userId: ownerUserId,
    tenantId: 't1',
    title: 'Conversation',
    status: 'active',
    source: 'web',
    mainSessionId: 'web:conversation-1:main',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    metadata: { conversationId: 'conversation-1' },
  };
  const workSession: SpaceSessionRecord = {
    id: 'web:conversation-1:terminal:step-1',
    threadId: thread.id,
    avatarId: DEFAULT_AVATAR_ID,
    userId: ownerUserId,
    tenantId: 't1',
    spaceId: 'terminal',
    kind: 'work',
    parentSessionId: 'web:conversation-1:main',
    status: 'active',
    source: 'web',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
  };
  const entry: SessionEntryRecord = {
    id: 'entry-1',
    sessionId: 'web:conversation-1:main',
    type: 'tool_result',
    role: 'tool',
    content: 'handoff summary with sensitive payload',
    data: {
      projectionKind: 'artifact_handoff',
      source: 'artifact_produced',
      sourceRefs: [{ table: 'artifacts', ids: ['artifact-1'] }],
      artifactId: 'artifact-1',
      input: { query: 'secret query' },
      result: 'secret result',
      artifact: { data: 'secret artifact payload' },
    },
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  };
  const threadQueries: unknown[] = [];
  const getThreadQueries: unknown[] = [];
  const sessionQueries: unknown[] = [];
  const entryQueries: unknown[] = [];
  const ledgerEvents: LedgerEventRecord[] = [];
  const close = vi.fn(async () => {});
  const store: Partial<ZleapStore> = {
    threads: {
      createThread: async () => thread,
      getThread: async (id, input = {}) => {
        getThreadQueries.push({ id, input });
        return input.userId === ownerUserId && input.tenantId === 't1' ? thread : undefined;
      },
      listThreads: async (input = {}) => {
        threadQueries.push(input);
        return input.userId === ownerUserId && input.tenantId === 't1' ? [thread] : [];
      },
      deleteThread: async () => false,
    },
    sessions: {
      createSession: async () => {
        throw new Error('not implemented');
      },
      getSession: async (id, input = {}) => {
        sessionQueries.push({ id, input });
        return id === workSession.id && input.userId === ownerUserId && input.tenantId === 't1'
          ? workSession
          : undefined;
      },
      appendEntry: async () => {
        throw new Error('not implemented');
      },
      deleteEntry: async () => false,
      setLeaf: async () => undefined,
      listEntries: async (input) => {
        entryQueries.push(input);
        return [entry];
      },
      buildConversation: async () => [],
      listSessions: async () => [workSession],
      buildSessionContext: async () => [],
    },
    ledger: {
      saveRun: async () => undefined,
      saveWork: async () => undefined,
      saveWorkStep: async () => undefined,
      saveEvent: async (record) => {
        ledgerEvents.push(record);
      },
      listEvents: async () => ledgerEvents,
      saveArtifact: async () => undefined,
      getArtifact: async () => undefined,
      saveArtifactReference: async () => undefined,
      saveCapabilitySnapshot: async () => undefined,
    },
    close,
  };
  return { close, threadQueries, getThreadQueries, sessionQueries, entryQueries, ledgerEvents, store };
}

function actorRequest(query = '', userId = 'u1', role: 'user' | 'admin' = 'user', permissions?: string): Request {
  const headers: Record<string, string> = {
    'x-zleap-user-id': userId,
    'x-zleap-actor-role': role,
    'x-zleap-tenant-id': 't1',
  };
  if (permissions) {
    headers['x-zleap-actor-permissions'] = permissions;
  }
  return new Request(`http://localhost/api/chat/trace${query}`, {
    method: 'GET',
    headers,
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

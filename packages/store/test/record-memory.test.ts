import { describe, expect, it } from 'vitest';
import {
  createRecordMemoryPort,
  type CoreEvent,
  type CoreStore,
  type EnsureSourceInput,
  type InsertEventInput,
} from '../src/index.js';

describe('record memory adapter', () => {
  it('keeps work recall and recency inside the current thread scope', async () => {
    let recallInput: Parameters<CoreStore['recall']>[0] | undefined;
    let listInput: Parameters<CoreStore['listEvents']>[0] | undefined;
    const core: Partial<CoreStore> = {
      recall: async (input) => {
        recallInput = input;
        return [];
      },
      listEvents: async (input) => {
        listInput = input;
        return [];
      },
    };
    const port = createRecordMemoryPort({ core: core as CoreStore });
    const scope = {
      agentId: 'agent-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      spaceId: 'cli',
      threadId: 'thread-current',
    };

    await port.recall({ scope, kinds: ['work'], query: 'deploy', limit: 3 });
    await port.listRecent({ scope, kind: 'work', limit: 3 });

    expect(recallInput?.scope).toEqual(scope);
    expect(listInput?.scope).toEqual(scope);
  });

  it('stores experience as agent-wide memory with origin user audit metadata', async () => {
    const now = new Date();
    let ensureInput: EnsureSourceInput | undefined;
    let insertInput: InsertEventInput | undefined;
    const core: Partial<CoreStore> = {
      ensureSource: async (input) => {
        ensureInput = input;
        return {
          id: 'src-experience',
          groupId: input.groupId,
          kind: input.kind,
          agentId: input.scope.agentId,
          userId: input.scope.userId,
          tenantId: input.scope.tenantId,
          spaceId: input.scope.spaceId,
          threadId: input.scope.threadId,
          name: input.name,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
      },
      findEventByHash: async () => undefined,
      recall: async () => [],
      insertEvent: async (input) => {
        insertInput = input;
        return {
          id: 'event-experience',
          sourceId: input.sourceId,
          memory: input.memory,
          metadata: input.metadata,
          keywords: input.keywords ?? [],
          messageIds: input.messageIds,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        } satisfies CoreEvent;
      },
      setEventStatus: async () => {},
    };
    const port = createRecordMemoryPort({ core: core as CoreStore });

    await port.writeExperience({
      scope: { agentId: 'agent-1', userId: 'user-1', spaceId: 'cli', threadId: 'thread-1' },
      memory: 'retry lesson: Retry transient API failures with bounded backoff before changing approach.',
    });

    expect(ensureInput?.scope).toEqual({ agentId: 'agent-1' });
    expect(ensureInput?.name).toBe('experience');
    expect(insertInput?.metadata).toMatchObject({
      memoryKind: 'experience',
      originUserId: 'user-1',
    });
  });
});

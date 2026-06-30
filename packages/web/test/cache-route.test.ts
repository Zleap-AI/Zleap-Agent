import type { RuntimeCacheEntryRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/cache/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/cache route', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('requires a conversationId', async () => {
    const response = await GET(actorRequest('http://localhost/api/cache'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'conversation_id_required' });
  });

  it('lists scoped cache entries without raw content', async () => {
    const entry: RuntimeCacheEntryRecord = {
      id: 'cache_1',
      userId: 'u1',
      agentId: 'zleap-default',
      conversationId: 'thread-1',
      kind: 'search_result',
      title: 'web_search: 302.AI',
      summary: '302.AI research summary',
      content: 'full raw search result',
      createdAt: new Date('2026-06-21T12:00:00Z'),
      toolId: 'web_search',
      workspaceId: 'web-search',
    };
    const close = vi.fn(async () => {});
    const listEntries = vi.fn(async () => [entry]);
    storeFromEnvMock.mockResolvedValue({
      runtimeCache: { listEntries },
      close,
    } as unknown as ZleapStore);

    const response = await GET(actorRequest('http://localhost/api/cache?conversationId=thread-1&agentId=zleap-default'));

    expect(response.status).toBe(200);
    expect(listEntries).toHaveBeenCalledWith({
      conversationId: 'thread-1',
      userId: 'u1',
      agentId: 'zleap-default',
      limit: 100,
    });
    await expect(response.json()).resolves.toEqual({
      entries: [{
        id: 'cache_1',
        kind: 'search_result',
        title: 'web_search: 302.AI',
        summary: '302.AI research summary',
        toolId: 'web_search',
        workspaceId: 'web-search',
        createdAt: '2026-06-21T12:00:00.000Z',
      }],
      persistence: { enabled: true, reachable: true },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

function actorRequest(url: string): Request {
  return new Request(url, {
    headers: {
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
  });
}

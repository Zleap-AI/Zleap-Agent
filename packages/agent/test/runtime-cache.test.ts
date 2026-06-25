import { describe, expect, it, vi } from 'vitest';
import type { RuntimeCacheEntryRecord, RuntimeCacheStore } from '@zleap/core';
import { RuntimeCacheManager } from '../src/runtimeCache.js';

function storeDouble(): RuntimeCacheStore {
  const entries = new Map<string, RuntimeCacheEntryRecord>();
  return {
    saveEntry: vi.fn(async (entry) => {
      entries.set(entry.id, entry);
    }),
    listEntries: vi.fn(async (input = {}) => [...entries.values()].filter((entry) => {
      return (!input.userId || entry.userId === input.userId) &&
        (!input.agentId || entry.agentId === input.agentId) &&
        (!input.threadId || entry.threadId === input.threadId) &&
        (!input.conversationId || entry.conversationId === input.conversationId) &&
        (!input.runId || entry.runId === input.runId) &&
        (!input.workspaceId || entry.workspaceId === input.workspaceId);
    })),
    getEntry: vi.fn(async (input) => {
      const entry = entries.get(input.id);
      if (!entry) return undefined;
      if (input.userId && entry.userId !== input.userId) return undefined;
      if (input.agentId && entry.agentId !== input.agentId) return undefined;
      if (input.threadId && entry.threadId !== input.threadId) return undefined;
      if (input.conversationId && entry.conversationId !== input.conversationId) return undefined;
      return entry;
    }),
    deleteByThread: vi.fn(async (input) => {
      for (const [id, entry] of entries) {
        if (entry.threadId === input.threadId) {
          entries.delete(id);
        }
      }
    }),
  };
}

describe('RuntimeCacheManager', () => {
  it('skips capture when the tool does not declare cache production', async () => {
    const store = storeDouble();
    const manager = new RuntimeCacheManager({ store: { runtimeCache: store } });

    await expect(manager.captureToolResult({
      toolId: 'read',
      toolInput: { path: 'file.md' },
      toolResult: 'content',
    })).resolves.toBeNull();
    expect(store.saveEntry).not.toHaveBeenCalled();
  });

  it('captures successful tool results and lists only the index for the model', async () => {
    const store = storeDouble();
    const manager = new RuntimeCacheManager({
      store: { runtimeCache: store },
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    const entry = await manager.captureToolResult({
      userId: 'u1',
      agentId: 'a1',
      threadId: 't1',
      conversationId: 't1',
      runId: 'r1',
      workspaceId: 'web-search',
      toolCallId: 'call1',
      toolId: 'web_search',
      toolInput: { q: '302.AI' },
      toolResult: { summary: 'Search summary', items: [{ title: '302.AI', url: 'https://302.ai' }] },
      capability: { produces: true, kinds: ['search_result'], capture: 'auto' },
    });

    expect(entry).toEqual(expect.objectContaining({
      kind: 'search_result',
      title: 'web_search: 302.AI',
      summary: 'Search summary',
      content: expect.stringContaining('https://302.ai'),
    }));

    const index = await manager.listForModel({ userId: 'u1', agentId: 'a1', threadId: 't1' });
    expect(index.entries).toEqual([expect.objectContaining({
      id: entry?.id,
      kind: 'search_result',
      title: 'web_search: 302.AI',
      summary: 'Search summary',
      sourceTool: 'web_search',
      sourceWorkspace: 'web-search',
    })]);
    expect(index.entries[0]).not.toHaveProperty('content');
  });

  it('reads full content by id and isolates by scope', async () => {
    const store = storeDouble();
    const manager = new RuntimeCacheManager({ store: { runtimeCache: store } });
    const entry = await manager.captureToolResult({
      userId: 'u1',
      agentId: 'a1',
      threadId: 't1',
      toolId: 'read_webpage',
      toolInput: { url: 'https://example.test' },
      toolResult: 'full webpage body',
      capability: { produces: true, kinds: ['webpage'], capture: 'auto' },
    });

    await expect(manager.readForModel({ userId: 'u1', agentId: 'a1', threadId: 't1' }, entry?.id ?? ''))
      .resolves.toEqual(expect.objectContaining({
        found: true,
        entry: expect.objectContaining({ content: 'full webpage body' }),
      }));
    await expect(manager.readForModel({ userId: 'u2', agentId: 'a1', threadId: 't1' }, entry?.id ?? ''))
      .resolves.toEqual({ found: false, error: 'cache_entry_not_found_or_not_visible' });
  });
});

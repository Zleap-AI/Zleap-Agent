import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import { createStore, type Embedder } from '../src/index.js';

const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe.skipIf(!url)('runtime Cache store (integration)', () => {
  it('saves, scopes, reads, and deletes entries by thread', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) return;

    try {
      const now = new Date();
      const suffix = now.getTime();
      const agentId = `cache_agent_${suffix}`;
      const userId = `cache_user_${suffix}`;
      const threadId = `cache_thread_${suffix}`;

      await store.avatars.saveAvatar({
        id: agentId,
        userId,
        slug: agentId,
        name: 'Cache Agent',
        currentVersion: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await store.threads.createThread({
        id: threadId,
        avatarId: agentId,
        userId,
        status: 'active',
        source: 'test',
      });

      await store.runtimeCache.saveEntry({
        id: `cache_${suffix}`,
        userId,
        agentId,
        threadId,
        conversationId: threadId,
        runId: `run_${suffix}`,
        workspaceId: 'web-search',
        toolCallId: `tool_${suffix}`,
        toolId: 'web_search',
        kind: 'search_result',
        title: '302.AI search',
        summary: 'Search result summary',
        content: 'Full search result content',
        metadata: { q: '302.AI' },
        createdAt: now,
      });

      const entries = await store.runtimeCache.listEntries({ userId, agentId, threadId });
      expect(entries.map((entry) => entry.title)).toEqual(['302.AI search']);
      expect(entries[0]?.content).toBe('Full search result content');

      await expect(store.runtimeCache.getEntry({ id: `cache_${suffix}`, userId, agentId, threadId }))
        .resolves.toEqual(expect.objectContaining({ id: `cache_${suffix}`, content: 'Full search result content' }));
      await expect(store.runtimeCache.getEntry({ id: `cache_${suffix}`, userId: `${userId}_other`, agentId, threadId }))
        .resolves.toBeUndefined();

      await store.runtimeCache.deleteByThread({ threadId, userId, agentId });
      await expect(store.runtimeCache.listEntries({ userId, agentId, threadId })).resolves.toEqual([]);
    } finally {
      await store.close();
    }
  });
});

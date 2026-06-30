import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import { createStore, type CoreReranker, type Embedder } from '../src/index.js';

const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe.skipIf(!url)('core recall (integration)', () => {
  it('recalls across paths, isolates by source, and only reranks in precise mode', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) return;
    try {
      const agentId = `recall_${Date.now()}`;
      const userId = `${agentId}_u`;
      const scope = { agentId, userId, threadId: `${agentId}_t` };
      const source = await store.core.ensureSource({ groupId: 'memory', kind: 'work', scope });

      const billing = await store.core.insertEvent({
        sourceId: source.id,
        memory: 'billing migration kickoff: Discussed the billing migration plan with Zhang San in Beijing.',
        keywords: ['billing', 'migration'],
        contentHash: 'h1',
        embedding: fauxEmbed('billing migration plan zhang san beijing', DIM),
        entities: [
          { type: 'person', name: 'Zhang San' },
          { type: 'topic', name: 'billing migration' },
        ],
      });
      // Shares the "Zhang San" entity → reachable via graph hop from the billing event.
      const standup = await store.core.insertEvent({
        sourceId: source.id,
        memory: 'standup notes: Zhang San reported progress on the dashboard.',
        keywords: ['dashboard'],
        contentHash: 'h2',
        embedding: fauxEmbed('zhang san dashboard progress standup', DIM),
        entities: [{ type: 'person', name: 'Zhang San' }],
      });

      // Different thread → must not surface in this scope.
      const otherScope = { agentId, userId, threadId: `${agentId}_other` };
      const otherSource = await store.core.ensureSource({ groupId: 'memory', kind: 'work', scope: otherScope });
      await store.core.insertEvent({
        sourceId: otherSource.id,
        memory: 'unrelated billing leak: billing migration secret that must not leak across threads',
        contentHash: 'h3',
        embedding: fauxEmbed('billing migration plan zhang san beijing', DIM),
      });

      const [queryVec] = await embed(['billing migration plan']);
      const fast = await store.core.recall({
        groupId: 'memory',
        scope,
        kind: 'work',
        queryText: 'billing migration',
        embedding: queryVec,
        mode: 'fast',
        graphHops: 1,
      });
      const ids = fast.map((h) => h.id);
      expect(ids).toContain(billing.id);
      // Graph hop pulls in the standup via the shared "Zhang San" entity.
      expect(ids).toContain(standup.id);
      // Isolation: the other thread's leak never appears.
      expect(fast.every((h) => h.sourceId === source.id)).toBe(true);
      expect(fast.find((h) => h.id === billing.id)?.paths.length).toBeGreaterThan(0);

      // precise mode invokes the injected reranker; fast mode must not.
      let reranked = false;
      const rerank: CoreReranker = async ({ hits, limit }) => {
        reranked = true;
        return [...hits].reverse().slice(0, limit);
      };
      await store.core.recall({ groupId: 'memory', scope, queryText: 'billing', mode: 'fast', rerank });
      expect(reranked).toBe(false);
      await store.core.recall({ groupId: 'memory', scope, queryText: 'billing', mode: 'precise', rerank });
      expect(reranked).toBe(true);

      await store.core.purgeByAgent({ agentId });
    } finally {
      await store.close();
    }
  });
});

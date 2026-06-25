import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import { agentNoteScopeColumns, type AgentNoteScope } from '@zleap/core';
import { createStore, type Embedder } from '../src/index.js';

const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe('agentNoteScopeColumns', () => {
  it('keys people impressions by user and leaves legacy experiences agent-scoped', () => {
    expect(agentNoteScopeColumns('impression')).toEqual(['userId']);
    expect(agentNoteScopeColumns('experience')).toEqual([]);
  });
});

describe.skipIf(!url)('agent_memory notes (integration)', () => {
  it('writes, reads recent, FIFO-evicts, and follows agent/space/user lifecycle', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) return;
    try {
      const agentId = `note_${Date.now()}`;
      const userId = `${agentId}_user`;
      const spaceId = `${agentId}_space`;
      const impressionScope: AgentNoteScope = { agentId, userId };
      const experienceScope: AgentNoteScope = { agentId, spaceId };

      // Impression scoped by user; legacy note experience is agent-scoped.
      for (let i = 0; i < 3; i += 1) {
        await store.notes.write({ id: `${agentId}_imp_${i}`, kind: 'impression', scope: impressionScope, memory: `imp ${i}: c${i}` });
      }
      const impressions = await store.notes.listRecent({ kind: 'impression', scope: impressionScope });
      expect(impressions).toHaveLength(3);
      expect(impressions[0]?.memory).toBe('imp 2: c2'); // newest first

      // FIFO: with limit 2, the 3rd write evicts the oldest of that scope.
      for (let i = 0; i < 3; i += 1) {
        await store.notes.write({ id: `${agentId}_exp_${i}`, kind: 'experience', scope: experienceScope, memory: `exp ${i}: c${i}` }, 2);
      }
      const experiences = await store.notes.listRecent({ kind: 'experience', scope: experienceScope, limit: 10 });
      expect(experiences.map((n) => n.memory)).toEqual(['exp 2: c2', 'exp 1: c1']);
      expect(experiences.every((n) => !n.spaceId && !n.userId)).toBe(true);

      // Other user's impressions are isolated.
      const otherScope: AgentNoteScope = { agentId, userId: `${agentId}_other` };
      await store.notes.write({ id: `${agentId}_other_imp`, kind: 'impression', scope: otherScope, memory: 'other imp: x' });
      expect(await store.notes.listRecent({ kind: 'impression', scope: impressionScope })).toHaveLength(3);

      // Delete space only affects old space-bound rows; new note experiences are not space-scoped.
      await store.notes.archiveBySpace({ agentId, spaceId });
      expect(await store.notes.listRecent({ kind: 'experience', scope: experienceScope, limit: 10 })).toHaveLength(2);
      expect(await store.notes.listRecent({ kind: 'impression', scope: impressionScope })).toHaveLength(3);

      // Delete user → drop that user's impressions only.
      await store.notes.purgeByUser({ agentId, userId });
      expect(await store.notes.listRecent({ kind: 'impression', scope: impressionScope })).toHaveLength(0);
      expect(await store.notes.listRecent({ kind: 'impression', scope: otherScope })).toHaveLength(1);

      // Delete agent → drop everything for the agent.
      await store.notes.purgeByAgent(agentId);
      expect(await store.notes.listRecent({ kind: 'impression', scope: otherScope })).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});

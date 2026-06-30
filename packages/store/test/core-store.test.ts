import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import { createStore, normalizeEntityName, type Embedder } from '../src/index.js';

const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe('normalizeEntityName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeEntityName('  Zhang   San ')).toBe('zhang san');
    expect(normalizeEntityName('TOPIC')).toBe('topic');
  });
});

describe.skipIf(!url)('core event graph (integration)', () => {
  it('ensures sources, inserts events with entities, reads detail, lists, and cascades on lifecycle', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) return;
    try {
      const agentId = `core_${Date.now()}`;
      const userId = `${agentId}_user`;
      const threadId = `${agentId}_thread`;
      const scope = { agentId, userId, threadId };

      // ensureSource is idempotent for the same scope.
      const source = await store.core.ensureSource({ groupId: 'memory', kind: 'work', scope });
      const again = await store.core.ensureSource({ groupId: 'memory', kind: 'work', scope });
      expect(again.id).toBe(source.id);
      expect(source.agentId).toBe(agentId);
      expect(source.threadId).toBe(threadId);

      const embedding = fauxEmbed('alpha event about zhang san', DIM);
      const event = await store.core.insertEvent({
        sourceId: source.id,
        memory: 'alpha summary: alpha content about zhang san in beijing',
        keywords: ['alpha', 'beijing'],
        messageIds: ['m1', 'm2'],
        contentHash: 'hash-alpha',
        embedding,
        entities: [
          { type: 'person', name: 'Zhang San', role: 'subject' },
          { type: 'location', name: 'Beijing' },
        ],
      });
      expect(event.memory).toBe('alpha summary: alpha content about zhang san in beijing');

      // content_hash idempotency: same hash returns the existing event.
      const dup = await store.core.insertEvent({
        sourceId: source.id,
        memory: 'dup',
        contentHash: 'hash-alpha',
      });
      expect(dup.id).toBe(event.id);

      const detail = await store.core.detail(event.id);
      expect(detail?.source.id).toBe(source.id);
      expect(detail?.entities.map((e) => e.normalizedName).sort()).toEqual(['beijing', 'zhang san']);
      expect(detail?.entities.find((e) => e.type === 'person')?.role).toBe('subject');

      const listed = await store.core.listEvents({ groupId: 'memory', scope, kind: 'work' });
      expect(listed.map((e) => e.id)).toContain(event.id);

      const archived = await store.core.insertEvent({
        sourceId: source.id,
        memory: 'archived evidence: This lower-confidence evidence is retained but not active.',
        contentHash: 'hash-archived',
        status: 'archived',
      });
      expect(archived.status).toBe('archived');
      const listedAfterArchive = await store.core.listEvents({ groupId: 'memory', scope, kind: 'work' });
      expect(listedAfterArchive.map((e) => e.id)).not.toContain(archived.id);
      expect(await store.core.detail(archived.id)).toMatchObject({ id: archived.id, status: 'archived' });

      // Isolation: a different thread's source has no events from this one.
      const otherList = await store.core.listEvents({
        groupId: 'memory',
        scope: { agentId, userId, threadId: `${agentId}_other` },
        kind: 'work',
      });
      expect(otherList).toHaveLength(0);

      // deleteByThread cascades the source + its events/entities.
      await store.core.deleteByThread({ groupId: 'memory', agentId, threadId });
      expect(await store.core.getEvent(event.id)).toBeUndefined();
      expect(await store.core.getSource(source.id)).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

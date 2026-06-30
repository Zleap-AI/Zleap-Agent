import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import {
  contentHash,
  createStore,
  ingestFragment,
  topKeywords,
  type CoreExtractor,
  type CoreEvent,
  type CoreStore,
  type Embedder,
  type ExtractionInput,
} from '../src/index.js';

const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe('core extract helpers', () => {
  it('contentHash is stable, case-insensitive, and trims the joined value', () => {
    expect(contentHash(['Hello', 'World'])).toBe(contentHash(['hello', 'world']));
    expect(contentHash([' wrap '])).toBe(contentHash(['wrap']));
    expect(contentHash(['a'])).not.toBe(contentHash(['b']));
  });

  it('topKeywords drops short/stopwords and ranks by frequency', () => {
    const kw = topKeywords('deploy deploy the service with kubernetes kubernetes kubernetes', 3);
    expect(kw[0]).toBe('kubernetes');
    expect(kw).toContain('deploy');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('with');
  });

  it('requires an LLM extractor to produce events', async () => {
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'work', agentId: 'a', status: 'active' as const, createdAt: new Date(), updatedAt: new Date() }),
      insertEvent: async () => {
        throw new Error('insertEvent should not be called without an extractor');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'work',
      scope: { agentId: 'a' },
      messages: [{ role: 'user', content: 'How do I deploy the billing service?', id: 'm1' }],
    };
    await expect(ingestFragment(input, { core: core as never, embed })).resolves.toEqual([]);
  });

  it('passes related candidates into reconciler and only replaces when action=replace_old', async () => {
    const now = new Date();
    const existing: CoreEvent = {
      id: 'old',
      sourceId: 'src1',
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
      relationId: 'rel-1',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted: CoreEvent[] = [];
    const statuses: Array<[
      string,
      CoreEvent['status'],
      Parameters<CoreStore['setEventStatus']>[2] | undefined,
    ]> = [];
    let recallInput: Parameters<CoreStore['recall']>[0] | undefined;
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      findEventByHash: async () => undefined,
      recall: async (recall: Parameters<CoreStore['recall']>[0]) => {
        recallInput = recall;
        return [{ ...existing, score: 1 / 61, vectorScore: 0.95, paths: ['vector'] }];
      },
      setEventStatus: async (
        id: string,
        status: CoreEvent['status'],
        options?: Parameters<CoreStore['setEventStatus']>[2],
      ) => {
        statuses.push([id, status, options]);
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
    }];

    const relatedInputs: unknown[] = [];
    await ingestFragment(input, {
      core: core as unknown as CoreStore,
      extractor,
      relatedMinScore: 0.92,
      reconciler: async (relatedInput) => {
        relatedInputs.push(relatedInput);
        return { action: 'replace_old', targetId: 'old', reason: 'explicit_update' };
      },
    });
    expect(recallInput).toMatchObject({ graphHops: 1, limit: 5, mode: 'fast' });
    expect(relatedInputs).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ relationId: 'rel-1', supersedesId: 'old' });
    expect(statuses).toEqual([[
      'old',
      'superseded',
      { supersededBy: 'new', supersededAt: inserted[0]?.createdAt },
    ]]);
  });

  it('does not supersede related candidates without a reconciler', async () => {
    const now = new Date();
    const existing: CoreEvent = {
      id: 'old',
      sourceId: 'src1',
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
      relationId: 'rel-1',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted: CoreEvent[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      recall: async () => [{ ...existing, score: 0.95, paths: ['vector'] }],
      setEventStatus: async () => {
        throw new Error('should not supersede without reconciler');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
    }];

    await ingestFragment(input, { core: core as unknown as CoreStore, extractor, relatedMinScore: 0.92 });
    expect(inserted[0]).toMatchObject({ relationId: 'rel-1', supersedesId: undefined, status: 'active' });
  });

  it('falls back to keep_both when reconciler chooses a non-candidate target', async () => {
    const now = new Date();
    const existing: CoreEvent = {
      id: 'old',
      sourceId: 'src1',
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted: CoreEvent[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      recall: async () => [{ ...existing, score: 0.95, paths: ['vector'] }],
      setEventStatus: async () => {
        throw new Error('should not supersede non-candidate target');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
    }];

    await ingestFragment(input, {
      core: core as unknown as CoreStore,
      extractor,
      relatedMinScore: 0.92,
      reconciler: async () => ({ action: 'replace_old', targetId: 'missing' }),
    });
    expect(inserted[0]).toMatchObject({ supersedesId: undefined, status: 'active' });
  });

  it('falls back to keep_both when reconciler fails', async () => {
    const now = new Date();
    const existing: CoreEvent = {
      id: 'old',
      sourceId: 'src1',
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted: CoreEvent[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      recall: async () => [{ ...existing, score: 0.95, paths: ['vector'] }],
      setEventStatus: async () => {
        throw new Error('should not supersede when reconciler fails');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
    }];

    await ingestFragment(input, {
      core: core as unknown as CoreStore,
      extractor,
      relatedMinScore: 0.92,
      reconciler: async () => {
        throw new Error('model failed');
      },
    });
    expect(inserted[0]).toMatchObject({ relationId: 'old', supersedesId: undefined, status: 'active' });
  });

  it('passes only the latest active candidate from a relation chain into reconciler', async () => {
    const older = new Date('2026-06-18T01:00:00.000Z');
    const newer = new Date('2026-06-18T02:00:00.000Z');
    const relatedInputs: unknown[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: older, updatedAt: older }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => ({
        id: 'new',
        sourceId: input.sourceId,
        memory: input.memory,
        keywords: input.keywords ?? [],
        relationId: input.relationId,
        supersedesId: input.supersedesId,
        status: input.status ?? 'active',
        createdAt: newer,
        updatedAt: newer,
      }),
      recall: async () => [
        {
          id: 'old',
          sourceId: 'src1',
      memory: 'Use the deploy checklist before release.',
          keywords: ['deploy', 'checklist'],
          status: 'active' as const,
          createdAt: older,
          updatedAt: older,
          score: 0.99,
          paths: ['vector'],
        },
        {
          id: 'newer-old',
          sourceId: 'src1',
          memory: 'Use the deploy checklist before release.',
          keywords: ['deploy', 'checklist'],
          relationId: 'old',
          status: 'active' as const,
          createdAt: newer,
          updatedAt: newer,
          score: 0.95,
          paths: ['vector'],
        },
      ],
      setEventStatus: async () => {},
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };

    await ingestFragment(input, {
      core: core as unknown as CoreStore,
      extractor: async () => [{
        memory: 'Use the deploy checklist before release.',
        keywords: ['deploy', 'checklist'],
      }],
      relatedMinScore: 0.92,
      reconciler: async (relatedInput) => {
        relatedInputs.push(relatedInput);
        return { action: 'keep_both' };
      },
    });
    const related = (relatedInputs[0] as { related: CoreEvent[] }).related;
    expect(related.map((hit) => hit.id)).toEqual(['newer-old']);
  });

  it('keeps graph-path related candidates even when their weighted score is below the vector threshold', async () => {
    const now = new Date();
    const relatedInputs: unknown[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'work', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => ({
        id: 'new',
        sourceId: input.sourceId,
          memory: input.memory,
        keywords: input.keywords ?? [],
        relationId: input.relationId,
        supersedesId: input.supersedesId,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      }),
      recall: async () => [{
        id: 'graph-hit',
        sourceId: 'src1',
        memory: 'A related event connected through a shared entity.',
        keywords: ['unshared'],
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
        score: 0.15,
        paths: ['graph'],
      }],
      setEventStatus: async () => {},
    };

    await ingestFragment({
      groupId: 'memory',
      kind: 'work',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'A new memory shares an entity.' }],
    }, {
      core: core as unknown as CoreStore,
      extractor: async () => [{
        memory: 'A new memory shares an entity.',
        keywords: ['different'],
      }],
      relatedMinScore: 0.92,
      reconciler: async (relatedInput) => {
        relatedInputs.push(relatedInput);
        return { action: 'keep_both' };
      },
    });

    const related = (relatedInputs[0] as { related: CoreEvent[] }).related;
    expect(related.map((hit) => hit.id)).toEqual(['graph-hit']);
  });

  it('writes keep_old drafts as archived evidence', async () => {
    const now = new Date();
    const existing: CoreEvent = {
      id: 'old',
      sourceId: 'src1',
      memory: 'User primarily uses Java.',
      keywords: ['java', 'language'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted: CoreEvent[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'work', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      findEventByHash: async () => undefined,
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      recall: async () => [{ ...existing, score: 0.95, paths: ['entity'] }],
      setEventStatus: async () => {
        throw new Error('should not supersede keep_old target');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'work',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'User may try Rust soon.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'User may try Rust soon.',
      keywords: ['rust', 'language'],
    }];

    await ingestFragment(input, {
      core: core as unknown as CoreStore,
      extractor,
      relatedMinScore: 0.92,
      reconciler: async () => ({ action: 'keep_old', targetId: 'old' }),
    });
    expect(inserted[0]).toMatchObject({ relationId: 'old', supersedesId: undefined, status: 'archived' });
  });

  it('does not relate medium-similarity events', async () => {
    const now = new Date();
    const inserted: CoreEvent[] = [];
    const core = {
      ensureSource: async () => ({ id: 'src1', groupId: 'memory', kind: 'experience', agentId: 'a', status: 'active' as const, createdAt: now, updatedAt: now }),
      insertEvent: async (input: Parameters<CoreStore['insertEvent']>[0]) => {
        const event: CoreEvent = {
          id: 'new',
          sourceId: input.sourceId,
          memory: input.memory,
          keywords: input.keywords ?? [],
          relationId: input.relationId,
          supersedesId: input.supersedesId,
          status: input.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        };
        inserted.push(event);
        return event;
      },
      findEventByHash: async () => undefined,
      recall: async () => [{
        id: 'old',
        sourceId: 'src1',
        memory: 'A different deploy topic.',
        keywords: ['deploy', 'other'],
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
        score: 0.8,
        paths: ['vector'],
      }],
      setEventStatus: async () => {
        throw new Error('should not supersede medium similarity');
      },
    };
    const input: ExtractionInput = {
      groupId: 'memory',
      kind: 'experience',
      scope: { agentId: 'a' },
      messages: [{ role: 'assistant', content: 'Use the deploy checklist before release.' }],
    };
    const extractor: CoreExtractor = async () => [{
      memory: 'Use the deploy checklist before release.',
      keywords: ['deploy', 'checklist'],
    }];

    await ingestFragment(input, { core: core as unknown as CoreStore, extractor, relatedMinScore: 0.92 });
    expect(inserted[0]?.relationId).toBeUndefined();
    expect(inserted[0]?.supersedesId).toBeUndefined();
  });
});

describe.skipIf(!url)('ingestFragment (integration)', () => {
  it('persists extracted events idempotently and prefers the LLM extractor', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) return;
    try {
      const agentId = `extract_${Date.now()}`;
      const input: ExtractionInput = {
        groupId: 'memory',
        kind: 'work',
        scope: { agentId, userId: `${agentId}_u`, threadId: `${agentId}_t` },
        messages: [
          { role: 'user', content: 'I met Zhang San in Beijing about the billing migration.', id: 'm1' },
          { role: 'assistant', content: 'Noted the billing migration owner.', id: 'm2' },
        ],
      };

      const extractor: CoreExtractor = async () => [
        {
          memory: 'User met Zhang San in Beijing to discuss the billing migration.',
          keywords: ['billing', 'migration'],
          messageIds: ['m1', 'm2'],
          entities: [
            { type: 'person', name: 'Zhang San', role: 'subject' },
            { type: 'location', name: 'Beijing' },
          ],
        },
      ];

      const first = await ingestFragment(input, { core: store.core, embed, extractor });
      expect(first).toHaveLength(1);

      // Re-ingesting the same fragment is idempotent (same content_hash).
      const second = await ingestFragment(input, { core: store.core, embed, extractor });
      expect(second[0].id).toBe(first[0].id);

      const detail = await store.core.detail(first[0].id);
      expect(detail?.entities.map((e) => e.type).sort()).toEqual(['location', 'person']);

      // No extractor → no event write. Event extraction is LLM-only.
      const ruleInput: ExtractionInput = { ...input, scope: { ...input.scope, threadId: `${agentId}_t2` } };
      const ruled = await ingestFragment(ruleInput, { core: store.core, embed });
      expect(ruled).toEqual([]);

      await store.core.purgeByAgent({ agentId });
    } finally {
      await store.close();
    }
  });
});

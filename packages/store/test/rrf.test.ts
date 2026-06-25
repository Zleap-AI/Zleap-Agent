import { describe, expect, it } from 'vitest';
import { mergeRrfRankings } from '../src/core/rrf.js';

describe('mergeRrfRankings', () => {
  it('ranks candidates by reciprocal rank fusion across paths', () => {
    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const firstInVector = { id: 'vector-first', createdAt };
    const multiPath = { id: 'multi-path', createdAt };

    const hits = mergeRrfRankings([
      { item: firstInVector, path: 'vector', rank: 1, rawScore: 0.99 },
      { item: multiPath, path: 'vector', rank: 2, rawScore: 0.2 },
      { item: multiPath, path: 'lexical', rank: 1, rawScore: 0.1 },
    ]);

    expect(hits.map((hit) => hit.item.id)).toEqual(['multi-path', 'vector-first']);
    expect(hits[0]?.score).toBeCloseTo((1 / 62) + (1 / 61), 8);
    expect(hits[1]?.score).toBeCloseTo(1 / 61, 8);
    expect(hits[0]?.paths).toEqual(['vector', 'lexical']);
  });

  it('keeps the best rank per path for duplicate candidates', () => {
    const item = { id: 'same', createdAt: new Date('2026-06-21T00:00:00.000Z') };

    const [hit] = mergeRrfRankings([
      { item, path: 'lexical', rank: 5, rawScore: 0.5 },
      { item, path: 'lexical', rank: 2, rawScore: 0.4 },
    ]);

    expect(hit?.score).toBeCloseTo(1 / 62, 8);
    expect(hit?.pathRanks).toEqual({ lexical: 2 });
    expect(hit?.pathScores).toEqual({ lexical: 0.5 });
  });
});

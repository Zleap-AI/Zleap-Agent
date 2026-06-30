import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSideEffectStateForTests, runSideEffect, sideEffectIdempotencyKey } from '../src/sideEffects.js';

describe('side-effect envelope', () => {
  afterEach(() => {
    resetSideEffectStateForTests();
  });

  it('deduplicates completed operations by idempotency key', async () => {
    let calls = 0;
    const key = sideEffectIdempotencyKey(['tool', { path: 'a.txt', content: 'same' }]);

    const first = await runSideEffect({ queueKey: 'file:a.txt', idempotencyKey: key }, async () => {
      calls += 1;
      return { calls };
    });
    const second = await runSideEffect({ queueKey: 'file:a.txt', idempotencyKey: key }, async () => {
      calls += 1;
      return { calls };
    });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('runs rollback on failure and releases the queue', async () => {
    const rollback = vi.fn(async () => undefined);
    await expect(
      runSideEffect({ queueKey: 'external:publish', rollback }, async () => {
        throw new Error('publish failed');
      }),
    ).rejects.toThrow('publish failed');

    await expect(runSideEffect({ queueKey: 'external:publish' }, async () => 'next')).resolves.toBe('next');
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileDedupStore } from '../src/dedup.js';

describe('FileDedupStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zleap-dedup-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats the first sighting as new and the second as duplicate', () => {
    const store = new FileDedupStore(join(dir, 'seen.json'));
    expect(store.isDuplicate('evt-1')).toBe(false);
    expect(store.isDuplicate('evt-1')).toBe(true);
    expect(store.isDuplicate('evt-2')).toBe(false);
  });

  it('expires entries past the TTL', () => {
    const store = new FileDedupStore(join(dir, 'seen.json'), 1);
    expect(store.isDuplicate('evt-1')).toBe(false);
    // ttl=1ms: a busy-wait beyond the window makes the entry stale.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }
    expect(store.isDuplicate('evt-1')).toBe(false);
  });

  it('evicts the oldest beyond maxSize', () => {
    const store = new FileDedupStore(join(dir, 'seen.json'), 60_000, 2);
    store.isDuplicate('a');
    store.isDuplicate('b');
    store.isDuplicate('c'); // evicts 'a' (oldest)
    expect(store.isDuplicate('b')).toBe(true); // still present (no mutation on hit)
    expect(store.isDuplicate('c')).toBe(true);
    expect(store.isDuplicate('a')).toBe(false); // was evicted
  });

  it('persists and reloads seen ids across instances', async () => {
    const file = join(dir, 'seen.json');
    const first = new FileDedupStore(file);
    first.isDuplicate('evt-9');
    await first.persist();
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
    expect(raw['evt-9']).toBeTypeOf('number');

    const second = new FileDedupStore(file);
    await second.load();
    expect(second.isDuplicate('evt-9')).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createStore bootstrap failures', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('returns null and closes the pool when schema bootstrap fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('CREATE EXTENSION IF NOT EXISTS vector')) {
        throw new Error('extension "vector" is not available');
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const end = vi.fn(async () => undefined);

    vi.resetModules();
    class FailingPool {
      readonly connect = vi.fn(async () => ({ query, release }));
      readonly end = end;
      constructor(_config: unknown) {}
    }
    vi.doMock('pg', () => ({
      default: { Pool: FailingPool },
      Pool: FailingPool,
    }));

    const { createStore } = await import('../src/store.js');
    const store = await createStore({
      connectionString: 'postgres://zleap:zleap@localhost:1/zleap',
      dimension: 64,
      embed: async (texts: string[]) => texts.map(() => []),
    });

    expect(store).toBeNull();
    expect(query.mock.calls.some((call) => String(call[0]).includes('CREATE EXTENSION IF NOT EXISTS vector'))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes('pg_advisory_unlock'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

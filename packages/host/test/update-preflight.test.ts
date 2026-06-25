import { describe, expect, it } from 'vitest';
import {
  assertNoActiveTaskRuns,
  assertRuntimeUpdateAllowed,
} from '../src/update-preflight.js';

describe('update preflight', () => {
  it('rejects runtime downgrades unless explicitly allowed', () => {
    expect(() => assertRuntimeUpdateAllowed(
      { version: '1.2.0', platform: 'mac-arm64', builtAt: '2026-01-01' },
      { version: '1.1.9' },
    )).toThrow(/downgrade/);

    expect(() => assertRuntimeUpdateAllowed(
      { version: '1.2.0', platform: 'mac-arm64', builtAt: '2026-01-01' },
      { version: '1.1.9' },
      { allowDowngrade: true },
    )).not.toThrow();
  });

  it('rejects schema downgrades unless explicitly allowed', () => {
    expect(() => assertRuntimeUpdateAllowed(
      { version: '1.2.0', platform: 'mac-arm64', builtAt: '2026-01-01', schemaVersion: 4 },
      { version: '1.3.0', schemaVersion: 3 },
    )).toThrow(/schema downgrade/);

    expect(() => assertRuntimeUpdateAllowed(
      { version: '1.2.0', platform: 'mac-arm64', builtAt: '2026-01-01', schemaVersion: 4 },
      { version: '1.3.0', schemaVersion: 3 },
      { allowSchemaDowngrade: true },
    )).not.toThrow();
  });

  it('blocks update when scheduled task runs are active', async () => {
    const client = fakeClient([{ status: 'running', count: 2 }]);

    await expect(assertNoActiveTaskRuns({
      databaseUrl: 'postgres://example',
      clientFactory: () => client,
    })).rejects.toThrow(/scheduled tasks are active/);

    expect(client.ended).toBe(true);
  });

  it('allows update when task run table is missing', async () => {
    const client = fakeClient([], Object.assign(new Error('missing table'), { code: '42P01' }));

    await expect(assertNoActiveTaskRuns({
      databaseUrl: 'postgres://example',
      clientFactory: () => client,
    })).resolves.toMatchObject({
      checked: false,
      active: false,
      detail: 'scheduled_task_runs table not found',
    });
  });
});

function fakeClient(rows: Array<Record<string, unknown>>, error?: Error) {
  return {
    ended: false,
    async connect() {
      // connected
    },
    async query() {
      if (error) throw error;
      return { rows };
    },
    async end() {
      this.ended = true;
    },
  };
}

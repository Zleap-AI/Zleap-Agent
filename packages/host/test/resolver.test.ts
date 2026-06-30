import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepoRoot } from '../src/paths.js';
import { resolveServiceEntries } from '../src/resolver.js';

const SAVED_ENV_KEYS = [
  'ZLEAP_HOME',
  'ZLEAP_APP_ROOT',
  'ZLEAP_RUNTIME_ROOT',
  'ZLEAP_REPO_ROOT',
  'ZLEAP_BUNDLED_ROOT',
  'ZLEAP_SKIP_BUILD',
  'ZLEAP_SERVE_MODE',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of SAVED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('@zleap/host resolver', () => {
  it('ignores app metadata entries when resolving services from a dev monorepo', async () => {
    const home = await mkdtemp(join(tmpdir(), 'zleap-home-'));
    try {
      await writeAppMetadata(home, {
        serve: 'node serve.js',
        web: 'node web/packages/web/server.js',
        worker: 'node tasks/dist/worker.js',
        gateway: 'node gateway/dist/worker.js',
      });
      process.env.ZLEAP_HOME = home;

      const repoRoot = resolveRepoRoot();
      const entries = await resolveServiceEntries(repoRoot);

      expect(repoRoot.endsWith('zleap_agent')).toBe(true);
      expect(entries.worker).toBe('node packages/tasks/dist/worker.js');
      expect(entries.gateway).toBe('node packages/gateway/dist/worker.js');
      expect(entries.worker).not.toBe('node tasks/dist/worker.js');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function writeAppMetadata(home: string, entry: Record<string, string>): Promise<void> {
  const metadataPath = join(home, 'app', 'metadata.json');
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(
    metadataPath,
    `${JSON.stringify({ version: '0.1.0', platform: 'test', builtAt: 'test', entry }, null, 2)}\n`,
    'utf8',
  );
}

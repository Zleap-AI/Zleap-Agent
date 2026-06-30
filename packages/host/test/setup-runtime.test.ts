import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureRuntimeInstalled } from '../src/setup-runtime.js';
import { zleapLayout } from '../src/layout.js';

const ENV_KEYS = [
  'ZLEAP_HOME',
  'ZLEAP_APP_ROOT',
  'ZLEAP_RUNTIME_ROOT',
  'ZLEAP_REPO_ROOT',
  'ZLEAP_BUNDLED_ROOT',
] as const;

describe('ensureRuntimeInstalled', () => {
  const previousEnv = new Map<string, string | undefined>();
  let home: string;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), 'zleap-setup-home-'));
    process.env.ZLEAP_HOME = home;
    process.env.ZLEAP_RUNTIME_ROOT = join(home, 'app');
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await rm(home, { recursive: true, force: true });
  });

  it('uses the dev monorepo without downloading when no app root is explicit', async () => {
    const result = await ensureRuntimeInstalled({ downloadIfMissing: false });

    expect(result.source).toBe('dev');
    expect(result.installed).toBe(false);
    expect(result.appRoot.endsWith('zleap_agent')).toBe(true);
  });

  it('records existing canonical runtime state', async () => {
    const layout = zleapLayout();
    process.env.ZLEAP_APP_ROOT = layout.current;
    await writeCompleteRuntime(layout.current);
    await writeMetadata(layout.metadataPath, { version: '0.3.0', platform: 'mac-arm64' });

    const result = await ensureRuntimeInstalled({ method: 'cli', downloadIfMissing: false });

    expect(result.source).toBe('existing');
    expect(result.version).toBe('0.3.0');
    expect(result.platform).toBe('mac-arm64');

    const install = JSON.parse(await readFile(layout.installStatePath, 'utf8')) as { method: string; version: string };
    const runtime = JSON.parse(await readFile(layout.runtimeStatePath, 'utf8')) as { runtimeRoot: string; version: string };
    expect(install).toMatchObject({ method: 'cli', version: '0.3.0' });
    expect(runtime).toMatchObject({ runtimeRoot: layout.current, version: '0.3.0' });
  });

  it('reuses an installed runtime instead of re-downloading the slim payload', async () => {
    const layout = zleapLayout();
    process.env.ZLEAP_APP_ROOT = layout.current;
    await writeCompleteRuntime(layout.current);
    await writeMetadata(layout.metadataPath, { version: '0.5.0', platform: 'win-x64' });

    const payloadDir = await mkdtemp(join(tmpdir(), 'zleap-slim-payload-'));
    try {
      await writeFile(
        join(payloadDir, 'metadata.json'),
        JSON.stringify({ version: '0.5.0', platform: 'win-x64', builtAt: '2026-01-01T00:00:00.000Z' }),
      );
      // Only a download pointer is present (slim desktop bundle). If the skip
      // logic fails it would try to fetch this URL and the test would error.
      await writeFile(join(payloadDir, 'download.json'), JSON.stringify({ url: 'https://invalid.zleap.test/never.tar.gz' }));

      const result = await ensureRuntimeInstalled({ method: 'desktop', payloadDir, downloadIfMissing: true });

      expect(result.source).toBe('existing');
      expect(result.installed).toBe(false);
      expect(result.version).toBe('0.5.0');
    } finally {
      await rm(payloadDir, { recursive: true, force: true });
    }
  });

  it('fails clearly when runtime is missing and download is disabled', async () => {
    const layout = zleapLayout();
    process.env.ZLEAP_APP_ROOT = layout.current;

    await expect(ensureRuntimeInstalled({ downloadIfMissing: false })).rejects.toThrow('Runtime 不完整');
  });

  it('repairs missing runtime through the installer hook', async () => {
    const layout = zleapLayout();
    process.env.ZLEAP_APP_ROOT = layout.current;

    const result = await ensureRuntimeInstalled({
      method: 'cli',
      downloadIfMissing: true,
      installApp: async () => {
        await writeCompleteRuntime(layout.current);
        await writeMetadata(layout.metadataPath, { version: '0.4.0', platform: 'mac-arm64' });
        return { version: '0.4.0', platform: 'mac-arm64', archivePath: '/tmp/zleap-runtime.tgz' };
      },
    });

    expect(result).toMatchObject({
      appRoot: layout.current,
      source: 'download',
      installed: true,
      repaired: true,
      version: '0.4.0',
      platform: 'mac-arm64',
    });
    expect(result.missing?.length).toBeGreaterThan(0);
  });
});

async function writeCompleteRuntime(root: string): Promise<void> {
  const files = [
    'runtime/node_modules/@zleap/host/dist/serve-cli.js',
    'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
    'runtime/node_modules/@zleap/host/dist/control-cli.js',
    'runtime/node_modules/@zleap-ai/cli/dist/index.js',
    'runtime/node_modules/@zleap/store/dist/migrate.js',
    'runtime/node_modules/@zleap/tasks/dist/worker.js',
    'runtime/node_modules/@zleap/gateway/dist/worker.js',
    'web/packages/web/server.js',
    'distribution.json',
    'manifest.json',
    process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node',
  ];
  for (const rel of files) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      rel === 'manifest.json'
        ? JSON.stringify({ features: { node: true, postgres: false, web: true, tasks: true, gateway: true, cli: true } })
        : '{}',
    );
  }
}

async function writeMetadata(path: string, metadata: { version: string; platform: string }): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...metadata, builtAt: '2026-01-01T00:00:00.000Z' })}\n`);
}

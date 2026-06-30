import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/upgrade.js', async () => {
  const actual = await vi.importActual<typeof import('../src/upgrade.js')>('../src/upgrade.js');
  return {
    ...actual,
    swapApp: vi.fn(async () => ({ previousVersion: undefined, newVersion: '0.2.0', restarted: false })),
    readAppMetadata: vi.fn(async () => undefined),
  };
});

describe('seedAppFromBundle', () => {
  let home: string;
  let bundled: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'zleap-seed-home-'));
    bundled = await mkdtemp(join(tmpdir(), 'zleap-seed-bundle-'));
    process.env.ZLEAP_HOME = home;
    process.env.ZLEAP_RUNTIME_ROOT = join(home, 'app');

    const required = [
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
      'node/bin/node',
    ];
    for (const rel of required) {
      const file = join(bundled, rel);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(
        file,
        rel === 'manifest.json'
          ? JSON.stringify({ features: { node: true, postgres: false, web: true, tasks: true, gateway: true, cli: false } })
          : 'x',
      );
    }
    await writeFile(
      join(bundled, 'metadata.json'),
      `${JSON.stringify({ version: '0.2.0', platform: 'mac-arm64', builtAt: '2026-01-01' })}\n`,
    );
  });

  afterEach(async () => {
    delete process.env.ZLEAP_HOME;
    delete process.env.ZLEAP_RUNTIME_ROOT;
    await rm(home, { recursive: true, force: true });
    await rm(bundled, { recursive: true, force: true });
    vi.resetModules();
  });

  it('seeds current when bundle is newer', async () => {
    const { seedAppFromBundle } = await import('../src/seed-app.js');
    const { swapApp } = await import('../src/upgrade.js');
    const result = await seedAppFromBundle(bundled);
    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('seeded-from-bundle');
    expect(swapApp).toHaveBeenCalled();
  });

  it('seeds current when bundle has the same version but a different build', async () => {
    const layout = (await import('../src/layout.js')).zleapLayout();
    await writeCompleteApp(layout.current);
    const { readAppMetadata } = await import('../src/upgrade.js');
    vi.mocked(readAppMetadata).mockResolvedValueOnce({
      version: '0.2.0',
      platform: 'mac-arm64',
      builtAt: '2025-12-31',
    });

    const { seedAppFromBundle } = await import('../src/seed-app.js');
    const { swapApp } = await import('../src/upgrade.js');
    const result = await seedAppFromBundle(bundled);
    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('seeded-from-bundle');
    expect(swapApp).toHaveBeenCalled();
  });

  it('rejects embedded runtime schema downgrade', async () => {
    const layout = (await import('../src/layout.js')).zleapLayout();
    await writeCompleteApp(layout.current);
    await writeFile(
      join(bundled, 'metadata.json'),
      `${JSON.stringify({ version: '0.3.0', platform: 'mac-arm64', builtAt: '2026-01-01', schemaVersion: 1 })}\n`,
    );
    const { readAppMetadata } = await import('../src/upgrade.js');
    vi.mocked(readAppMetadata).mockResolvedValueOnce({
      version: '0.2.0',
      platform: 'mac-arm64',
      builtAt: '2026-01-01',
      schemaVersion: 3,
    });

    const { seedAppFromBundle } = await import('../src/seed-app.js');
    await expect(seedAppFromBundle(bundled)).rejects.toThrow(/schema downgrade/);
  });
});

async function writeCompleteApp(root: string): Promise<void> {
  const required = [
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
    'node/bin/node',
  ];
  for (const rel of required) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      rel === 'manifest.json'
        ? JSON.stringify({ features: { node: true, postgres: false, web: true, tasks: true, gateway: true, cli: true } })
        : 'x',
    );
  }
}

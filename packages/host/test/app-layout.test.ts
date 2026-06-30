import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareVersions, isAppComplete, appChecks } from '../src/app-layout.js';

describe('app-layout', () => {
  it('compareVersions orders semver segments', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('reports missing paths for incomplete app', () => {
    expect(isAppComplete('/tmp/definitely-not-a-app')).toBe(false);
    expect(appChecks('/tmp/definitely-not-a-app').length).toBeGreaterThan(0);
  });

  it('checks desktop and cli targets separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-app-layout-'));
    try {
      await writeCompleteApp(root, { cli: false });
      expect(isAppComplete(root, 'desktop')).toBe(true);
      expect(appChecks(root, 'cli')).toContain('runtime/node_modules/@zleap-ai/cli/dist/index.js');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('@zleap/host paths resolveRuntimeRoot', () => {
  it('prefers ZLEAP_REPO_ROOT over path heuristics', async () => {
    const { resolveRuntimeRoot, resolveRepoRoot } = await import('../src/paths.js');
    const prevRepo = process.env.ZLEAP_REPO_ROOT;
    const prevApp = process.env.ZLEAP_APP_ROOT;
    delete process.env.ZLEAP_APP_ROOT;
    process.env.ZLEAP_REPO_ROOT = '/tmp/zleap-bundle';
    expect(resolveRuntimeRoot()).toBe('/tmp/zleap-bundle');
    expect(resolveRepoRoot()).toBe('/tmp/zleap-bundle');
    if (prevRepo === undefined) delete process.env.ZLEAP_REPO_ROOT;
    else process.env.ZLEAP_REPO_ROOT = prevRepo;
    if (prevApp === undefined) delete process.env.ZLEAP_APP_ROOT;
    else process.env.ZLEAP_APP_ROOT = prevApp;
  });

  it('prefers monorepo runtime over an installed app unless app root is explicit', async () => {
    const { resolveRuntimeRoot } = await import('../src/paths.js');
    const prevHome = process.env.ZLEAP_HOME;
    const prevRepo = process.env.ZLEAP_REPO_ROOT;
    const prevApp = process.env.ZLEAP_APP_ROOT;
    const home = await mkdtemp(join(tmpdir(), 'zleap-home-'));
    const app = join(home, 'app', 'current');
    try {
      await writeCompleteApp(app, { cli: true });
      process.env.ZLEAP_HOME = home;
      delete process.env.ZLEAP_REPO_ROOT;
      delete process.env.ZLEAP_APP_ROOT;

      const root = resolveRuntimeRoot();
      expect(root.endsWith('zleap_agent')).toBe(true);

      process.env.ZLEAP_APP_ROOT = app;
      expect(resolveRuntimeRoot()).toBe(app);
    } finally {
      if (prevHome === undefined) delete process.env.ZLEAP_HOME;
      else process.env.ZLEAP_HOME = prevHome;
      if (prevRepo === undefined) delete process.env.ZLEAP_REPO_ROOT;
      else process.env.ZLEAP_REPO_ROOT = prevRepo;
      if (prevApp === undefined) delete process.env.ZLEAP_APP_ROOT;
      else process.env.ZLEAP_APP_ROOT = prevApp;
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function writeCompleteApp(root: string, features: { cli: boolean }): Promise<void> {
  const files = [
    'runtime/node_modules/@zleap/host/dist/serve-cli.js',
    'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
    'runtime/node_modules/@zleap/host/dist/control-cli.js',
    'runtime/node_modules/@zleap/store/dist/migrate.js',
    'runtime/node_modules/@zleap/tasks/dist/worker.js',
    'runtime/node_modules/@zleap/gateway/dist/worker.js',
    'web/packages/web/server.js',
    'distribution.json',
    'manifest.json',
    process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node',
  ];
  if (features.cli) {
    files.push('runtime/node_modules/@zleap-ai/cli/dist/index.js');
  }
  for (const rel of files) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      rel === 'manifest.json'
        ? JSON.stringify({ features: { node: true, postgres: false, web: true, tasks: true, gateway: true, cli: features.cli } })
        : '{}',
    );
  }
}

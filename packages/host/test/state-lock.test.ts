import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireRuntimeLock } from '../src/lock.js';
import { zleapLayout } from '../src/layout.js';
import { readLauncherState, readRuntimeState, writeLauncherState, writeRuntimeState } from '../src/runtime-state.js';
import { readServeState } from '../src/supervisor.js';

const TEST_HOME = '/tmp/.zleap-runtime-state-lock-test-home';

describe('@zleap/host state and locks', () => {
  beforeEach(async () => {
    process.env.ZLEAP_HOME = TEST_HOME;
    delete process.env.ZLEAP_APP_ROOT;
    delete process.env.ZLEAP_RUNTIME_ROOT;
    delete process.env.ZLEAP_REPO_ROOT;
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  it('writes runtime and launcher state under state dir', async () => {
    const layout = zleapLayout();
    await mkdir(dirname(layout.metadataPath), { recursive: true });
    await writeFile(
      layout.metadataPath,
      `${JSON.stringify({
        version: '1.2.3',
        platform: 'mac-arm64',
        builtAt: '2026-01-01T00:00:00.000Z',
        schemaVersion: 7,
      })}\n`,
      'utf8',
    );
    const runtime = await writeRuntimeState({ version: '1.2.3', platform: 'mac-arm64' });
    const launcher = await writeLauncherState({ lastLauncher: 'cli', installedCliVersion: '1.2.3' });

    expect(runtime).toMatchObject({ home: TEST_HOME, runtimeRoot: layout.current, version: '1.2.3', schemaVersion: 7 });
    expect(await readRuntimeState()).toMatchObject({ version: '1.2.3', platform: 'mac-arm64', schemaVersion: 7 });
    expect(launcher).toMatchObject({ lastLauncher: 'cli', installedCliVersion: '1.2.3' });
    expect(await readLauncherState()).toMatchObject({ lastLauncher: 'cli' });
  });

  it('reclaims stale locks when the owner pid is gone', async () => {
    const lockPath = zleapLayout().serveLockPath;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 999_999_999, owner: 'serve:dev', acquiredAt: new Date().toISOString() })}\n`,
      'utf8',
    );

    const lock = await acquireRuntimeLock(lockPath, { owner: 'serve:test' });
    await lock.release();
  });

  it('acquires locks atomically and rejects concurrent lock holders', async () => {
    const lockPath = zleapLayout().serveLockPath;
    const lock = await acquireRuntimeLock(lockPath, { owner: 'serve:test' });
    await expect(acquireRuntimeLock(lockPath, { owner: 'serve:test' })).rejects.toThrow(/正在进行中/);
    await lock.release();
    const next = await acquireRuntimeLock(lockPath, { owner: 'serve:test' });
    await next.release();
  });

  it('normalizes legacy serve state when reading', async () => {
    const layout = zleapLayout();
    await mkdir(dirname(layout.serveStatePath), { recursive: true });
    await writeFile(
      layout.serveStatePath,
      `${JSON.stringify({
        pid: 123,
        startedAt: '2026-01-01T00:00:00.000Z',
        mode: 'production',
        webPort: '3000',
        webUrl: 'http://127.0.0.1:3000',
        services: [{ name: 'web', pid: 456 }],
      })}\n`,
      'utf8',
    );

    const state = await readServeState();
    expect(state).toMatchObject({
      home: TEST_HOME,
      runtimeRoot: layout.current,
      runtimeVersion: '0.0.0',
      startedBy: 'cli',
      sessionId: 'legacy',
      stopPolicy: 'explicit',
    });
    expect(state?.services[0]).toMatchObject({ name: 'web', pid: 456, status: 'running' });
  });
});

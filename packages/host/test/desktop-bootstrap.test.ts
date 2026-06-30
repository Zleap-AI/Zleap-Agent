import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  appendDesktopLog: vi.fn(),
  ensureRuntimeInstalled: vi.fn(),
  readServeState: vi.fn(),
  startDetachedServe: vi.fn(),
  stopServe: vi.fn(),
  stopWebPortListeners: vi.fn(),
  waitForHealthLive: vi.fn(),
}));

vi.mock('../src/bootstrap-state.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bootstrap-state.js')>('../src/bootstrap-state.js');
  return {
    ...actual,
    appendDesktopLog: mocks.appendDesktopLog,
  };
});

vi.mock('../src/setup-runtime.js', () => ({
  ensureRuntimeInstalled: mocks.ensureRuntimeInstalled,
}));

vi.mock('../src/service/manager.js', () => ({
  startDetachedServe: mocks.startDetachedServe,
  waitForHealthLive: mocks.waitForHealthLive,
}));

vi.mock('../src/supervisor.js', () => ({
  readServeState: mocks.readServeState,
  stopServe: mocks.stopServe,
  stopWebPortListeners: mocks.stopWebPortListeners,
}));

const ENV_KEYS = [
  'ZLEAP_HOME',
  'ZLEAP_APP_ROOT',
  'ZLEAP_RUNTIME_ROOT',
  'ZLEAP_REPO_ROOT',
  'ZLEAP_BUNDLED_ROOT',
  'ZLEAP_DESKTOP',
  'ZLEAP_INSTALL_METHOD',
  'ZLEAP_LAUNCHER_SESSION_ID',
] as const;

describe('runDesktopBootstrap', () => {
  const previousEnv = new Map<string, string | undefined>();
  let home: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), 'zleap-desktop-bootstrap-'));
    process.env.ZLEAP_HOME = home;
    process.env.ZLEAP_RUNTIME_ROOT = join(home, 'app');
    process.env.ZLEAP_LAUNCHER_SESSION_ID = 'desktop-session-1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await rm(home, { recursive: true, force: true });
  });

  it('uses the shared installer and starts runtime as a desktop-owned session', async () => {
    const appRoot = join(home, 'app', 'current');
    mocks.ensureRuntimeInstalled.mockResolvedValue({
      appRoot,
      source: 'existing',
      installed: false,
      repaired: false,
      version: '0.5.0',
      platform: 'mac-arm64',
    });
    mocks.waitForHealthLive.mockResolvedValueOnce(true);
    mocks.startDetachedServe.mockResolvedValue(undefined);

    const { runDesktopBootstrap } = await import('../src/desktop-bootstrap.js');
    const result = await runDesktopBootstrap({ autoUpdate: false });

    expect(result.ok).toBe(true);
    expect(mocks.ensureRuntimeInstalled).toHaveBeenCalledWith({
      method: 'desktop',
      bundledRoot: undefined,
      payloadDir: undefined,
      downloadIfMissing: false,
      onDownloadProgress: expect.any(Function),
    });
    expect(mocks.startDetachedServe).toHaveBeenCalledWith(
      expect.objectContaining({
        startedBy: 'desktop',
        sessionId: 'desktop-session-1',
        stopPolicy: 'onDesktopQuit',
      }),
    );
  });

  it('replaces an orphaned zleap web listener before starting the desktop runtime', async () => {
    const appRoot = join(home, 'app', 'current');
    mocks.ensureRuntimeInstalled.mockResolvedValue({
      appRoot,
      source: 'embedded',
      installed: true,
      repaired: true,
      version: '0.5.0',
      platform: 'mac-arm64',
    });
    mocks.readServeState.mockResolvedValue(undefined);
    mocks.stopWebPortListeners.mockResolvedValue([53552]);
    mocks.waitForHealthLive.mockResolvedValueOnce(true);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/health/live')) {
        return new Response(JSON.stringify({ status: 'ok', service: 'zleap-web' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const { runDesktopBootstrap } = await import('../src/desktop-bootstrap.js');
    const result = await runDesktopBootstrap({ autoUpdate: false });

    expect(result.ok).toBe(true);
    expect(mocks.stopWebPortListeners).toHaveBeenCalledWith(4789);
    expect(mocks.startDetachedServe).toHaveBeenCalled();
  });

  it('stops a recorded service from a different runtime before starting the desktop runtime', async () => {
    const appRoot = join(home, 'app', 'current');
    mocks.ensureRuntimeInstalled.mockResolvedValue({
      appRoot,
      source: 'embedded',
      installed: true,
      repaired: true,
      version: '0.5.0',
      platform: 'mac-arm64',
    });
    mocks.readServeState.mockResolvedValue({
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z',
      mode: 'dev',
      home,
      runtimeRoot: '/old/runtime',
      runtimeVersion: '0.1.0',
      startedBy: 'dev',
      sessionId: 'old',
      stopPolicy: 'explicit',
      webPort: '3000',
      webUrl: 'http://127.0.0.1:3000',
      services: [],
    });
    mocks.stopServe.mockResolvedValue({ stopped: ['supervisor:123'], missing: false });
    mocks.waitForHealthLive.mockResolvedValueOnce(true);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/health/live')) {
        return new Response(JSON.stringify({ status: 'ok', service: 'zleap-web' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const { runDesktopBootstrap } = await import('../src/desktop-bootstrap.js');
    const result = await runDesktopBootstrap({ autoUpdate: false });

    expect(result.ok).toBe(true);
    expect(mocks.stopServe).toHaveBeenCalled();
    expect(mocks.startDetachedServe).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { detectInstallMethod } from '../src/install-method.js';
import { zleapLayout, releasePlatformTag } from '../src/layout.js';
import { buildRuntimeEnv } from '../src/resolver.js';
import { normalizeVersion } from '../src/distribution.js';
import { resolveNodeBin } from '../src/resolver.js';
import { resolveRepoRoot } from '../src/paths.js';

const TEST_HOME = '/tmp/.zleap-runtime-test-home';

describe('@zleap/host layout', () => {
  beforeEach(() => {
    process.env.ZLEAP_HOME = TEST_HOME;
    delete process.env.ZLEAP_APP_ROOT;
    delete process.env.ZLEAP_RUNTIME_ROOT;
    delete process.env.ZLEAP_REPO_ROOT;
    delete process.env.ZLEAP_BUNDLED_ROOT;
    delete process.env.ZLEAP_INSTALL_METHOD;
    delete process.env.ZLEAP_DESKTOP;
    delete process.env.ZLEAP_SKIP_BUILD;
    delete process.env.ZLEAP_SERVE_MODE;
    delete process.env.ZLEAP_WEB_PORT;
    delete process.env.PORT;
  });

  it('exposes canonical paths under ZLEAP_HOME', () => {
    const prev = process.env.ZLEAP_HOME;
    process.env.ZLEAP_HOME = '/tmp/zleap-test-home';
    const layout = zleapLayout();
    expect(layout.stateDir).toBe('/tmp/zleap-test-home/state');
    expect(layout.current).toContain('app/current');
    expect(layout.runtimeStatePath).toContain('runtime.json');
    expect(layout.launcherStatePath).toContain('launcher.json');
    expect(layout.installStatePath).toContain('install.json');
    expect(layout.serveLockPath).toContain('serve.lock');
    if (prev === undefined) delete process.env.ZLEAP_HOME;
    else process.env.ZLEAP_HOME = prev;
  });

  it('detects dev install method in monorepo', () => {
    expect(detectInstallMethod()).toBe('dev');
  });

  it('buildRuntimeEnv includes database url', () => {
    const env = buildRuntimeEnv();
    expect(env.ZLEAP_DATABASE_URL).toContain('postgres://');
  });

  it('keeps the dev web port on 3000 by default', () => {
    const env = buildRuntimeEnv();
    expect(env.ZLEAP_WEB_PORT).toBe('3000');
  });

  it('uses the runtime web port for production serve', () => {
    const env = buildRuntimeEnv({ ZLEAP_SERVE_MODE: 'production' });
    expect(env.ZLEAP_WEB_PORT).toBe('4789');
  });

  it('resolveNodeBin falls back to process execPath', () => {
    const bin = resolveNodeBin('/tmp/not-bundled');
    expect(bin.length).toBeGreaterThan(0);
  });

  it('resolveNodeBin ignores foreign ZLEAP_NODE_BIN in dev monorepo', () => {
    process.env.ZLEAP_NODE_BIN = '/Users/example/.hermes/node/bin/node';
    const bin = resolveNodeBin(resolveRepoRoot());
    expect(bin).toBe(process.execPath);
    delete process.env.ZLEAP_NODE_BIN;
  });

  it('normalizes version tags', () => {
    expect(normalizeVersion('v1.0.0')).toBe('1.0.0');
  });

  it('maps platform tags', () => {
    expect(releasePlatformTag()).toMatch(/^(mac|win|linux)-/);
  });
});

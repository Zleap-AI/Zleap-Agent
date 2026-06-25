import { beforeEach, describe, expect, it } from 'vitest';
import { isBundledInstall, resolveBundledPostgresBin, resolveRepoRoot, zleapHome } from '../src/paths.js';
import { buildServeEnv, webUrl } from '../src/env.js';

const TEST_HOME = '/tmp/.zleap-runtime-test-home';

describe('@zleap/host paths', () => {
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
  });

  it('resolves monorepo root containing packages/host', () => {
    const root = resolveRepoRoot();
    expect(root.endsWith('zleap_agent') || root.includes('packages')).toBe(true);
  });

  it('returns undefined bundled pg when not installed', () => {
    const prev = process.env.ZLEAP_BUNDLED_PG_BIN;
    delete process.env.ZLEAP_BUNDLED_PG_BIN;
    delete process.env.ZLEAP_PG_BIN;
    expect(resolveBundledPostgresBin()).toBeUndefined();
    if (prev) process.env.ZLEAP_BUNDLED_PG_BIN = prev;
  });

  it('builds default serve env with database url', () => {
    const env = buildServeEnv();
    expect(env.ZLEAP_DATABASE_URL).toContain('postgres://');
    expect(webUrl(env)).toBe('http://127.0.0.1:3000');
  });

  it('uses ZLEAP_HOME override', () => {
    expect(zleapHome()).toContain('.zleap');
  });

  it('prefers ZLEAP_REPO_ROOT over path heuristics', () => {
    const prev = process.env.ZLEAP_REPO_ROOT;
    process.env.ZLEAP_REPO_ROOT = '/tmp/zleap-bundle';
    expect(resolveRepoRoot()).toBe('/tmp/zleap-bundle');
    if (prev === undefined) {
      delete process.env.ZLEAP_REPO_ROOT;
    } else {
      process.env.ZLEAP_REPO_ROOT = prev;
    }
  });

  it('detects bundled install layout', () => {
    expect(isBundledInstall('/tmp/not-bundled')).toBe(false);
  });
});

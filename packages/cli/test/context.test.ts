import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelSourceLabel } from '../src/cli/context.js';
import { modelFromEnv } from '@zleap/agent/conversation';

describe('resolveCliContext model priority', () => {
  it('labels model sources in Chinese', () => {
    expect(modelSourceLabel('config')).toContain('config');
    expect(modelSourceLabel('db')).toContain('数据库');
    expect(modelSourceLabel('env')).toContain('环境');
  });

  it('reads model from env fallback', () => {
    const prev = {
      base: process.env.ZLEAP_MODEL_BASE_URL,
      key: process.env.ZLEAP_MODEL_API_KEY,
      name: process.env.ZLEAP_MODEL_NAME,
    };
    process.env.ZLEAP_MODEL_BASE_URL = 'https://test/v1';
    process.env.ZLEAP_MODEL_API_KEY = 'sk-test';
    process.env.ZLEAP_MODEL_NAME = 'test-model';
    try {
      const model = modelFromEnv();
      expect(model?.model).toBe('test-model');
    } finally {
      if (prev.base) process.env.ZLEAP_MODEL_BASE_URL = prev.base;
      else delete process.env.ZLEAP_MODEL_BASE_URL;
      if (prev.key) process.env.ZLEAP_MODEL_API_KEY = prev.key;
      else delete process.env.ZLEAP_MODEL_API_KEY;
      if (prev.name) process.env.ZLEAP_MODEL_NAME = prev.name;
      else delete process.env.ZLEAP_MODEL_NAME;
    }
  });
});

describe('doctor checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZLEAP_DOCTOR_CHECK_MANIFEST;
    delete process.env.ZLEAP_UPDATER_MANIFEST_URL;
    delete process.env.ZLEAP_MANIFEST_PUBLIC_KEY;
    delete process.env.ZLEAP_MANIFEST_PUBLIC_KEY_PATH;
    delete process.env.ZLEAP_REQUIRE_MANIFEST_SIGNATURE;
  });

  it('includes Node.js check', async () => {
    const { collectDoctorChecks } = await import('../src/cli/doctor.js');
    const checks = await collectDoctorChecks();
    expect(checks.some((c) => c.name === 'Node.js' && c.ok)).toBe(true);
  });

  it('skips release manifest network probe in dev mode by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { releaseManifestCheck } = await import('../src/cli/doctor.js');

    const check = await releaseManifestCheck(true);

    expect(check).toMatchObject({ name: 'Release Manifest', ok: true });
    expect(check.detail).toContain('跳过网络探测');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes release manifest when explicitly enabled', async () => {
    process.env.ZLEAP_DOCTOR_CHECK_MANIFEST = '1';
    process.env.ZLEAP_UPDATER_MANIFEST_URL = 'https://release.example/latest.json';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ version: '0.2.0', runtime: { version: '0.3.0', platforms: {} } }),
      { status: 200 },
    ));
    const { releaseManifestCheck } = await import('../src/cli/doctor.js');

    const check = await releaseManifestCheck(true);

    expect(check).toMatchObject({ name: 'Release Manifest', ok: true });
    expect(check.detail).toContain('v0.3.0');
  });
});

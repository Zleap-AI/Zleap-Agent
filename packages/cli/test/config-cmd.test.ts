import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '@zleap/host';
import {
  getConfigValue,
  setConfigValue,
  flattenConfig,
  resolveConfiguredDatabaseUrl,
  resolvePersistence,
} from '@zleap/host';

describe('config helpers', () => {
  it('reads nested config paths', () => {
    const config = { model: { baseUrl: 'https://api.example/v1' } };
    expect(getConfigValue(config, 'model.baseUrl')).toBe('https://api.example/v1');
  });

  it('writes nested config paths', () => {
    const next = setConfigValue({}, 'database.url', 'postgres://localhost/zleap');
    expect(getConfigValue(next, 'database.url')).toBe('postgres://localhost/zleap');
  });

  it('masks secrets in flatten output', () => {
    const rows = flattenConfig({ model: { apiKey: 'sk-secret' } });
    expect(rows.some((r) => r.key === 'model.apiKey' && r.value === '***')).toBe(true);
  });

  it('uses the local runtime database by default without treating it as configured', () => {
    const prevZleap = process.env.ZLEAP_DATABASE_URL;
    const prevDatabase = process.env.DATABASE_URL;
    delete process.env.ZLEAP_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(resolveConfiguredDatabaseUrl({})).toBeUndefined();
      expect(resolvePersistence({}).databaseUrl).toBe(DEFAULT_DATABASE_URL);
    } finally {
      if (prevZleap === undefined) delete process.env.ZLEAP_DATABASE_URL;
      else process.env.ZLEAP_DATABASE_URL = prevZleap;
      if (prevDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabase;
    }
  });
});

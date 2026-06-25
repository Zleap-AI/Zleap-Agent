import { describe, expect, it } from 'vitest';
import { filterSlashCommands } from '../src/commands/registry.js';
import { envKeyForConfigPath, loadConfigWithMeta } from '@zleap/host';

describe('loadConfigWithMeta', () => {
  it('maps config paths to canonical env keys', () => {
    expect(envKeyForConfigPath('model.baseUrl')).toBe('ZLEAP_MODEL_BASE_URL');
    expect(envKeyForConfigPath('database.url')).toBe('ZLEAP_DATABASE_URL');
  });
});

describe('filterSlashCommands while running', () => {
  it('only exposes /abort during an active run', () => {
    expect(filterSlashCommands('/', { running: true }).map((c) => c.name)).toEqual(['/abort']);
    expect(filterSlashCommands('/abort', { running: true }).map((c) => c.name)).toEqual(['/abort']);
    expect(filterSlashCommands('/stop', { running: true })).toEqual([]);
  });
});

describe('loadConfigWithMeta parse errors', () => {
  it('returns parseError field shape', async () => {
    const result = await loadConfigWithMeta();
    expect(result.config).toBeDefined();
    expect(result.parseError === undefined || typeof result.parseError === 'string').toBe(true);
  });
});

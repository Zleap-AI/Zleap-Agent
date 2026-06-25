import { describe, expect, it } from 'vitest';
import { sanitizeMcpConfigForStorage } from '../src/store.js';

describe('sanitizeMcpConfigForStorage', () => {
  it('preserves config.env while stripping other inline secrets', () => {
    const config = {
      command: 'legacy-mcp',
      args: ['--stdio'],
      env: {
        AI302_API_KEY: 'raw-key',
        API_KEY: 'another-key',
      },
      headers: {
        Authorization: 'Bearer raw-token',
        Accept: 'application/json',
      },
      nested: {
        token: 'raw-token',
        keep: 'visible',
        items: [
          { name: 'public', password: 'raw-password' },
          { label: 'safe' },
        ],
      },
    };
    const original = JSON.parse(JSON.stringify(config));

    expect(sanitizeMcpConfigForStorage(config)).toEqual({
      command: 'legacy-mcp',
      args: ['--stdio'],
      env: {
        AI302_API_KEY: 'raw-key',
        API_KEY: 'another-key',
      },
      headers: {
        Accept: 'application/json',
      },
      nested: {
        keep: 'visible',
        items: [{ name: 'public' }, { label: 'safe' }],
      },
    });
    expect(config).toEqual(original);
    const sanitized = JSON.stringify(sanitizeMcpConfigForStorage(config));
    expect(sanitized).toContain('raw-key');
    expect(sanitized).not.toContain('raw-token');
    expect(sanitized).not.toContain('raw-password');
  });

  it('returns undefined when no safe config remains', () => {
    expect(
      sanitizeMcpConfigForStorage({
        env: { MCP_TOKEN: 'only-env' },
      }),
    ).toEqual({ env: { MCP_TOKEN: 'only-env' } });
    expect(
      sanitizeMcpConfigForStorage({
        apiKey: 'raw-key',
        credentials: { id: 'credential-id' },
      }),
    ).toBeUndefined();
  });

  it('ignores invalid config shapes', () => {
    expect(sanitizeMcpConfigForStorage(undefined)).toBeUndefined();
    expect(sanitizeMcpConfigForStorage(null)).toBeUndefined();
    expect(sanitizeMcpConfigForStorage(['--stdio'])).toBeUndefined();
  });
});

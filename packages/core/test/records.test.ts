import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET_VALUE, redactMcpServerRecord, type McpServerRecord } from '../src/index.js';

describe('MCP record redaction', () => {
  it('redacts env and secret-like config fields without mutating the source record', () => {
    const original: McpServerRecord = {
      id: 'linear',
      name: 'Linear',
      transport: 'stdio',
      status: 'active',
      config: {
        command: 'npx',
        env: {
          LINEAR_API_KEY: 'lin_secret',
        },
        headers: {
          authorization: 'Bearer token',
          plain: 'visible',
        },
        nested: {
          refreshToken: 'refresh_secret',
          url: 'https://mcp.example.test',
        },
      },
      secretRefs: [{ provider: 'env', key: 'LINEAR_API_KEY' }],
      createdAt: new Date('2026-06-13T00:00:00.000Z'),
      updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    };

    const redacted = redactMcpServerRecord(original);

    expect(redacted.config).toEqual({
      command: 'npx',
      env: REDACTED_SECRET_VALUE,
      headers: {
        authorization: REDACTED_SECRET_VALUE,
        plain: 'visible',
      },
      nested: {
        refreshToken: REDACTED_SECRET_VALUE,
        url: 'https://mcp.example.test',
      },
    });
    expect(redacted.secretRefs).toEqual([{ provider: 'env', key: 'LINEAR_API_KEY' }]);
    expect(redacted.secretRefs).not.toBe(original.secretRefs);
    expect(original.config).toEqual({
      command: 'npx',
      env: {
        LINEAR_API_KEY: 'lin_secret',
      },
      headers: {
        authorization: 'Bearer token',
        plain: 'visible',
      },
      nested: {
        refreshToken: 'refresh_secret',
        url: 'https://mcp.example.test',
      },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { EnvMcpSecretResolver, resolveMcpSecrets, type McpSecretAuditEvent } from '@zleap/agent';

const server = {
  id: 'linear',
  userId: 'u1',
  tenantId: 't1',
  name: 'Linear',
  transport: 'http' as const,
  config: { url: 'https://mcp.example.test/linear' },
  status: 'active' as const,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  updatedAt: new Date('2026-01-02T03:04:05.000Z'),
};

describe('MCP secret resolution', () => {
  it('resolves env and header secretRefs with redacted audit metadata', () => {
    const audit: McpSecretAuditEvent[] = [];
    const secrets = resolveMcpSecrets(
      {
        ...server,
        secretRefs: [
          { provider: 'env', key: 'LINEAR_MCP_TOKEN', metadata: { header: 'Authorization', prefix: 'Bearer ', version: 'v2' } },
          { provider: 'env', key: 'LINEAR_PROJECT_ID', metadata: { env: 'PROJECT_ID' } },
        ],
      },
      {
        resolver: new EnvMcpSecretResolver({
          LINEAR_MCP_TOKEN: 'real-token',
          LINEAR_PROJECT_ID: 'proj-1',
        }),
        audit: (event) => audit.push(event),
      },
    );

    expect(secrets).toEqual({
      headers: { Authorization: 'Bearer real-token' },
      env: { PROJECT_ID: 'proj-1' },
    });
    expect(audit).toEqual([
      expect.objectContaining({ serverId: 'linear', target: 'header', status: 'resolved', version: 'v2' }),
      expect.objectContaining({ serverId: 'linear', target: 'env', status: 'resolved' }),
    ]);
    expect(JSON.stringify(audit)).not.toContain('real-token');
    expect(JSON.stringify(audit)).not.toContain('LINEAR_MCP_TOKEN');
  });

  it('denies refs outside their owner/server scope and audits unsupported providers', () => {
    const audit: McpSecretAuditEvent[] = [];
    const secrets = resolveMcpSecrets(
      {
        ...server,
        secretRefs: [
          { provider: 'env', key: 'OTHER_USER_TOKEN', metadata: { userId: 'u2' } },
          { provider: 'env', key: 'OTHER_SERVER_TOKEN', metadata: { allowedServerIds: ['github'] } },
          { provider: 'vault', key: 'VAULT_TOKEN' },
          { provider: 'env', key: 'MISSING_TOKEN' },
        ],
      },
      {
        resolver: new EnvMcpSecretResolver({ OTHER_USER_TOKEN: 'secret', OTHER_SERVER_TOKEN: 'secret' }),
        audit: (event) => audit.push(event),
      },
    );

    expect(secrets).toEqual({ env: {}, headers: {} });
    expect(audit.map((event) => event.status)).toEqual(['forbidden', 'forbidden', 'unsupported_provider', 'missing']);
  });
});

import {
  DEFAULT_AVATAR_ID,
  type AvatarRecord,
  type CapabilityDefinitionRecord,
  type McpServerRecord,
  type McpToolDefinitionRecord,
  type SpaceCapabilityBindingRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH, POST } from '../app/api/mcp/servers/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

type TestStore = {
  servers: McpServerRecord[];
  tools: McpToolDefinitionRecord[];
  capabilities: CapabilityDefinitionRecord[];
  store: Partial<ZleapStore> & { close: ReturnType<typeof vi.fn> };
};

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/mcp/servers route secrets', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('requires admin role for server registration', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await POST(actorRequest('POST', { id: 'linear', name: 'Linear', transport: 'stdio' }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(store.servers).toHaveLength(0);
  });

  it('persists inline config.env for local dev convenience', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await POST(adminRequest({
      id: 'linear',
      name: 'Linear',
      transport: 'stdio',
      avatarId: 'operator',
      config: { command: 'linear-mcp', env: { LINEAR_API_KEY: 'real-token' } },
    }));

    await expectStatus(response, 201);
    expect(store.servers).toHaveLength(1);
    expect(store.servers[0]!.config).toEqual({ command: 'linear-mcp', env: { LINEAR_API_KEY: 'real-token' } });
  });

  it('persists non-sensitive config with secretRefs and redacts responses', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await POST(adminRequest({
      id: 'linear',
      name: 'Linear',
      transport: 'stdio',
      avatarId: 'operator',
      config: { command: 'linear-mcp', args: ['--stdio'] },
      secretRefs: [{ provider: 'env', key: 'LINEAR_API_KEY' }],
    }));

    await expectStatus(response, 201);
    const json = (await response.json()) as { server: McpServerRecord };
    expect(json.server.userId).toBe('u1');
    expect(json.server.tenantId).toBe('t1');
    expect(json.server.config).toEqual({ command: 'linear-mcp', args: ['--stdio'] });
    expect(json.server.secretRefs).toEqual([{ provider: 'env', key: 'LINEAR_API_KEY' }]);
    expect(store.servers).toHaveLength(1);
    expect(store.servers[0]!.userId).toBe('u1');
    expect(store.servers[0]!.tenantId).toBe('t1');
    expect(store.servers[0]!.config).toEqual({ command: 'linear-mcp', args: ['--stdio'] });
    expect(store.servers[0]!.secretRefs).toEqual([{ provider: 'env', key: 'LINEAR_API_KEY' }]);
  });

  it('redacts any legacy persisted config.env on list responses', async () => {
    const store = makeStore();
    store.servers.push({
      id: 'legacy',
      userId: 'u1',
      tenantId: 't1',
      name: 'Legacy',
      transport: 'stdio',
      config: { command: 'legacy-mcp', env: { TOKEN: 'stored-token' } },
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    store.servers.push({
      id: 'other-user',
      userId: 'u2',
      tenantId: 't1',
      name: 'Other User',
      transport: 'stdio',
      config: { command: 'other-mcp', env: { TOKEN: 'other-token' } },
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await GET(actorRequest('GET'));

    await expectStatus(response, 200);
    const json = (await response.json()) as { servers: McpServerRecord[] };
    expect(json.servers.map((server) => server.id)).toEqual(['legacy']);
    expect(json.servers[0]!.config).toEqual({ command: 'legacy-mcp', env: '[redacted]' });
  });

  it('updates an owned server while preserving stored env when omitted', async () => {
    const store = makeStore();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    store.servers.push({
      id: 'linear',
      userId: 'u1',
      tenantId: 't1',
      name: 'Linear',
      transport: 'stdio',
      config: { command: 'linear-mcp', env: { LINEAR_API_KEY: 'real-token' } },
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    });
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await PATCH(adminRequest({
      id: 'linear',
      name: 'Linear Updated',
      transport: 'stdio',
      config: { command: 'linear-mcp-updated', args: ['--stdio'] },
    }, 'PATCH'));

    await expectStatus(response, 200);
    expect(store.servers).toHaveLength(1);
    expect(store.servers[0]!.name).toBe('Linear Updated');
    expect(store.servers[0]!.createdAt).toBe(createdAt);
    expect(store.servers[0]!.config).toEqual({
      command: 'linear-mcp-updated',
      args: ['--stdio'],
      env: { LINEAR_API_KEY: 'real-token' },
    });
  });

  it('deletes only an owned server and its MCP capabilities', async () => {
    const store = makeStore();
    const now = new Date('2026-01-01T00:00:00Z');
    store.servers.push(
      {
        id: 'owned',
        userId: 'u1',
        tenantId: 't1',
        name: 'Owned',
        transport: 'http',
        config: { url: 'https://owned.example/mcp' },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'other',
        userId: 'u2',
        tenantId: 't1',
        name: 'Other',
        transport: 'http',
        config: { url: 'https://other.example/mcp' },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    );
    store.tools.push(
      { id: 'owned__search', serverId: 'owned', name: 'search', version: 1, createdAt: now },
      { id: 'other__search', serverId: 'other', name: 'search', version: 1, createdAt: now },
    );
    store.capabilities.push(
      { id: 'owned', type: 'mcp_server', version: 1, origin: 'mcp', createdAt: now },
      { id: 'owned__search', type: 'mcp_tool', version: 1, origin: 'mcp', createdAt: now },
      { id: 'other', type: 'mcp_server', version: 1, origin: 'mcp', createdAt: now },
      { id: 'other__search', type: 'mcp_tool', version: 1, origin: 'mcp', createdAt: now },
    );
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await DELETE(adminRequest({ id: 'owned' }, 'DELETE'));

    await expectStatus(response, 200);
    expect(store.servers.map((server) => server.id)).toEqual(['other']);
    expect(store.tools.map((tool) => tool.id)).toEqual(['other__search']);
    expect(store.capabilities.map((capability) => `${capability.type}:${capability.id}`)).toEqual([
      'mcp_server:other',
      'mcp_tool:other__search',
    ]);
  });
});

function makeStore(): TestStore {
  const servers: McpServerRecord[] = [];
  const tools: McpToolDefinitionRecord[] = [];
  const capabilities: CapabilityDefinitionRecord[] = [];
  const avatars = new Map<string, AvatarRecord>([
    [
      'operator',
      {
        id: 'operator',
        userId: 'u1',
        slug: 'operator',
        name: 'Operator',
        currentVersion: 1,
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ],
  ]);
  const store: TestStore['store'] = {
    transaction: async (operation) => operation(store as ZleapStore),
    avatars: {
      saveAvatar: async (record) => {
        avatars.set(record.id, record);
      },
      saveAvatarVersion: async () => {},
      getAvatar: async (id) => avatars.get(id),
      getAvatarVersion: async () => undefined,
      listAvatars: async () => [...avatars.values()],
    },
    spaces: {
      saveSpace: async () => {},
      saveSpaceVersion: async () => {},
      saveCapability: async (record) => {
        capabilities.push(record);
      },
      bindCapability: async (_record: SpaceCapabilityBindingRecord) => {},
      getSpace: async () => undefined,
      getSpaceVersion: async () => undefined,
      listSpaces: async () => [],
      listCapabilityBindings: async () => [],
      getSpaceSnapshot: async () => ({
        id: 'snapshot',
        avatarId: DEFAULT_AVATAR_ID,
        avatarVersion: 1,
        spaceId: 'main',
        spaceVersion: 1,
        capabilities: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    },
    mcp: {
      saveServer: async (record) => {
        const index = servers.findIndex((server) => server.id === record.id);
        if (index >= 0) {
          servers[index] = record;
        } else {
          servers.push(record);
        }
      },
      getServer: async (id, input = {}) => servers.find((server) => server.id === id && matchesOwner(server, input)),
      listServers: async (input = {}) => servers.filter((server) => matchesOwner(server, input)),
      deleteServer: async (id, input = {}) => {
        if (!servers.some((server) => server.id === id && matchesOwner(server, input))) return;
        const toolIds = new Set(tools.filter((tool) => tool.serverId === id).map((tool) => tool.id));
        for (let index = capabilities.length - 1; index >= 0; index -= 1) {
          const capability = capabilities[index]!;
          if ((capability.type === 'mcp_server' && capability.id === id) || (capability.type === 'mcp_tool' && toolIds.has(capability.id))) {
            capabilities.splice(index, 1);
          }
        }
        for (let index = tools.length - 1; index >= 0; index -= 1) {
          if (tools[index]!.serverId === id) tools.splice(index, 1);
        }
        for (let index = servers.length - 1; index >= 0; index -= 1) {
          if (servers[index]!.id === id && matchesOwner(servers[index]!, input)) servers.splice(index, 1);
        }
      },
      saveTool: async () => {},
      getTool: async () => undefined,
      listTools: async (input = {}) => tools.filter((tool) => !input.serverId || tool.serverId === input.serverId),
      deleteTool: async () => {},
    },
    close: vi.fn(async () => {}),
  };
  return { servers, tools, capabilities, store };
}

function adminRequest(body: unknown, method = 'POST'): Request {
  return actorRequest(method, body, 'admin');
}

function actorRequest(method: string, body?: unknown, role = 'user'): Request {
  return new Request('http://localhost/api/mcp/servers', {
    method,
    headers: {
      'content-type': 'application/json',
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': role,
      'x-zleap-tenant-id': 't1',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

function matchesOwner(server: McpServerRecord, input: { userId?: string; tenantId?: string }): boolean {
  if (input.userId && server.userId !== input.userId) {
    return false;
  }
  if (input.tenantId && server.tenantId !== input.tenantId) {
    return false;
  }
  return true;
}

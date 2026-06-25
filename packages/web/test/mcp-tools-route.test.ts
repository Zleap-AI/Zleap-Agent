import type {
  AvatarRecord,
  McpServerRecord,
  McpToolDefinitionRecord,
  SpaceCapabilityBindingRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/mcp/tools/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

type TestStore = {
  servers: McpServerRecord[];
  tools: McpToolDefinitionRecord[];
  capabilities: unknown[];
  store: Partial<ZleapStore> & { close: ReturnType<typeof vi.fn> };
};

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/mcp/tools route owner scope', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('lists only tools from actor-owned servers', async () => {
    const store = makeStore();
    seedServersAndTools(store);
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await GET(actorRequest('GET'));

    await expectStatus(response, 200);
    const json = (await response.json()) as { tools: McpToolDefinitionRecord[] };
    expect(json.tools.map((tool) => tool.id)).toEqual(['owned:list']);
  });

  it('does not reveal tools when serverId belongs to another actor', async () => {
    const store = makeStore();
    seedServersAndTools(store);
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await GET(actorRequest('GET', undefined, 'user', '?serverId=other'));

    await expectStatus(response, 200);
    const json = (await response.json()) as { tools: McpToolDefinitionRecord[] };
    expect(json.tools).toEqual([]);
  });

  it('requires admin role to register tools', async () => {
    const store = makeStore();
    seedServersAndTools(store);
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await POST(actorRequest('POST', { serverId: 'owned', name: 'create' }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(store.tools.map((tool) => tool.id)).toEqual(['owned:list', 'other:list']);
  });

  it('registers tools only against actor-owned servers', async () => {
    const store = makeStore();
    seedServersAndTools(store);
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const denied = await POST(adminRequest({ serverId: 'other', name: 'create' }));
    await expectStatus(denied, 400);
    await expect(denied.json()).resolves.toMatchObject({ error: 'MCP server not found: other' });
    expect(store.tools.map((tool) => tool.id)).toEqual(['owned:list', 'other:list']);

    const allowed = await POST(adminRequest({ serverId: 'owned', name: 'create', label: 'Create item' }));
    await expectStatus(allowed, 201);
    const json = (await allowed.json()) as { tool: McpToolDefinitionRecord };
    expect(json.tool).toMatchObject({ id: 'owned:create', serverId: 'owned', name: 'create', label: 'Create item' });
    expect(store.tools.map((tool) => tool.id)).toEqual(['owned:list', 'other:list', 'owned:create']);
  });
});

function makeStore(): TestStore {
  const servers: McpServerRecord[] = [];
  const tools: McpToolDefinitionRecord[] = [];
  const capabilities: unknown[] = [];
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
        avatarId: 'operator',
        avatarVersion: 1,
        spaceId: 'main',
        spaceVersion: 1,
        capabilities: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    },
    mcp: {
      saveServer: async (record) => {
        servers.push(record);
      },
      getServer: async (id, input = {}) => servers.find((server) => server.id === id && matchesOwner(server, input)),
      listServers: async (input = {}) => servers.filter((server) => matchesOwner(server, input)),
      deleteServer: async (id, input = {}) => {
        for (let index = servers.length - 1; index >= 0; index -= 1) {
          if (servers[index]!.id === id && matchesOwner(servers[index]!, input)) servers.splice(index, 1);
        }
      },
      saveTool: async (record) => {
        const index = tools.findIndex((tool) => tool.id === record.id && tool.version === record.version);
        if (index >= 0) {
          tools[index] = record;
        } else {
          tools.push(record);
        }
      },
      getTool: async (id, version) =>
        tools.find((tool) => tool.id === id && (version === undefined || tool.version === version)),
      listTools: async (input = {}) => tools.filter((tool) => !input.serverId || tool.serverId === input.serverId),
      deleteTool: async () => {},
    },
    close: vi.fn(async () => {}),
  };
  return { servers, tools, capabilities, store };
}

function seedServersAndTools(store: TestStore): void {
  const now = new Date('2026-01-01T00:00:00Z');
  store.servers.push(
    {
      id: 'owned',
      userId: 'u1',
      tenantId: 't1',
      name: 'Owned',
      transport: 'stdio',
      config: { command: 'owned-mcp' },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'other',
      userId: 'u2',
      tenantId: 't1',
      name: 'Other',
      transport: 'stdio',
      config: { command: 'other-mcp' },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  );
  store.tools.push(
    {
      id: 'owned:list',
      serverId: 'owned',
      name: 'list',
      version: 1,
      createdAt: now,
    },
    {
      id: 'other:list',
      serverId: 'other',
      name: 'list',
      version: 1,
      createdAt: now,
    },
  );
}

function adminRequest(body: unknown): Request {
  return actorRequest('POST', body, 'admin');
}

function actorRequest(method: string, body?: unknown, role = 'user', query = ''): Request {
  return new Request(`http://localhost/api/mcp/tools${query}`, {
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

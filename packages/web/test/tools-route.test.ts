import type { McpServerRecord, McpToolDefinitionRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH } from '../app/api/tools/route';
import { storeFromEnv } from '../lib/server/avatarStore';
import { MAIN_SPACE_ONLY_TOOL_IDS } from '../lib/server/toolSets';
import { readToolState, setToolCacheState, setToolEnabled } from '../lib/server/toolStateStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/toolStateStore', () => ({
  readToolState: vi.fn(),
  setToolEnabled: vi.fn(),
  setToolCacheState: vi.fn(),
}));

type TestStore = {
  servers: McpServerRecord[];
  tools: McpToolDefinitionRecord[];
  store: Partial<ZleapStore> & { close: ReturnType<typeof vi.fn> };
};

const storeFromEnvMock = vi.mocked(storeFromEnv);
const readToolStateMock = vi.mocked(readToolState);
const setToolEnabledMock = vi.mocked(setToolEnabled);
const setToolCacheStateMock = vi.mocked(setToolCacheState);

describe('/api/tools route actor scope', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
    readToolStateMock.mockResolvedValue({ disabledToolSetIds: [], disabledToolIds: [], cacheByToolId: {} });
    setToolEnabledMock.mockResolvedValue({ disabledToolSetIds: [], disabledToolIds: ['dispatch'], cacheByToolId: {} });
    setToolCacheStateMock.mockResolvedValue({
      disabledToolSetIds: [],
      disabledToolIds: [],
      cacheByToolId: { 'owned:list': { produces: true, kinds: ['tool_result'], capture: 'auto' } },
    });
  });

  it('requires an actor before reading tool state or store', async () => {
    const response = await GET(new Request('http://localhost/api/tools'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(readToolStateMock).not.toHaveBeenCalled();
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('lists MCP tools only from actor-owned servers', async () => {
    const store = makeStore();
    seedServersAndTools(store);
    storeFromEnvMock.mockResolvedValue(store.store as ZleapStore);

    const response = await GET(actorRequest('GET'));

    await expectStatus(response, 200);
    const json = (await response.json()) as {
      tools: Array<{ id: string; origin: string; serverId?: string; cache?: { produces: boolean; kinds: string[]; readonly?: boolean } }>;
      toolSets: Array<{ id: string; toolIds: string[] }>;
    };
    expect(json.tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(['web_search', 'read_webpage']));
    expect(json.tools.map((tool) => tool.id)).not.toContain('readMessage');
    expect(json.tools.find((tool) => tool.id === 'web_search')?.cache).toMatchObject({ produces: true, kinds: ['search_result'], readonly: true });
    expect(json.tools.find((tool) => tool.id === 'read_webpage')?.cache).toMatchObject({ produces: true, kinds: ['webpage'], readonly: true });
    expect(json.toolSets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web-search', toolIds: ['web_search', 'read_webpage'] })]));
    const mcpTools = json.tools.filter((tool) => tool.origin === 'mcp');
    expect(mcpTools).toEqual([{ id: 'owned:list', label: 'list', origin: 'mcp', serverId: 'owned', enabled: true }]);
    expect(store.store.close).toHaveBeenCalledOnce();
  });

  it('keeps deprecated task_detail out of the main-space config whitelist', () => {
    expect(MAIN_SPACE_ONLY_TOOL_IDS).toContain('task_manage');
    expect(MAIN_SPACE_ONLY_TOOL_IDS).toContain('readMessage');
    expect(MAIN_SPACE_ONLY_TOOL_IDS).not.toContain('task_detail');
  });

  it('requires admin role to mutate tool state', async () => {
    const response = await PATCH(actorRequest('PATCH', { scope: 'tool', id: 'dispatch', enabled: false }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(setToolEnabledMock).not.toHaveBeenCalled();
  });

  it('allows admins to mutate tool state through the validated contract', async () => {
    const response = await PATCH(actorRequest('PATCH', { scope: 'tool', id: 'dispatch', enabled: false }, 'admin'));

    await expectStatus(response, 200);
    expect(setToolEnabledMock).toHaveBeenCalledWith('tool', 'dispatch', false);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: { disabledToolSetIds: [], disabledToolIds: ['dispatch'], cacheByToolId: {} },
    });
  });

  it('allows admins to configure tool cache through a simple contract', async () => {
    const cache = { produces: true, kinds: ['tool_result'], capture: 'auto' as const };
    const response = await PATCH(actorRequest('PATCH', { scope: 'tool-cache', id: 'owned:list', cache }, 'admin'));

    await expectStatus(response, 200);
    expect(setToolCacheStateMock).toHaveBeenCalledWith('owned:list', cache);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: { disabledToolSetIds: [], disabledToolIds: [], cacheByToolId: { 'owned:list': cache } },
    });
  });
});

function makeStore(): TestStore {
  const servers: McpServerRecord[] = [];
  const tools: McpToolDefinitionRecord[] = [];
  const store: TestStore['store'] = {
    mcp: {
      saveServer: async () => {},
      getServer: async () => undefined,
      listServers: async (input = {}) => servers.filter((server) => matchesOwner(server, input)),
      deleteServer: async () => {},
      saveTool: async () => {},
      getTool: async () => undefined,
      listTools: async (input = {}) => tools.filter((tool) => !input.serverId || tool.serverId === input.serverId),
      deleteTool: async () => {},
    },
    close: vi.fn(async () => {}),
  };
  return { servers, tools, store };
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

function actorRequest(method: string, body?: unknown, role = 'user'): Request {
  return new Request('http://localhost/api/tools', {
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

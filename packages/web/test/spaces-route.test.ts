import {
  type AvatarRecord,
  type AvatarVersionRecord,
  type CapabilityDefinitionRecord,
  type SpaceCapabilityBindingRecord,
  type SpaceCapabilitySnapshot,
  type SpaceRecord,
  type SpaceVersionRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH, POST } from '../app/api/spaces/route';
import { GET as GET_CAPABILITIES, POST as POST_CAPABILITIES } from '../app/api/spaces/capabilities/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

type TestStore = {
  avatars: Map<string, AvatarRecord>;
  avatarVersions: Map<string, AvatarVersionRecord[]>;
  spaces: Map<string, SpaceRecord>;
  spaceVersions: Map<string, SpaceVersionRecord[]>;
  bindings: SpaceCapabilityBindingRecord[];
  capabilities: Map<string, CapabilityDefinitionRecord>;
  store: Partial<ZleapStore> & { close: ReturnType<typeof vi.fn> };
};

const storeFromEnvMock = vi.mocked(storeFromEnv);

describe('/api/spaces route actor contract', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  it('requires an actor before listing spaces', async () => {
    const response = await GET(new Request('http://localhost/api/spaces'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('lists the main space first even when the store returns work spaces first', async () => {
    const testStore = makeStore();
    const now = new Date('2026-01-01T00:00:00Z');
    testStore.spaces.set('early-work', {
      id: 'early-work',
      slug: 'early-work',
      kind: 'work',
      currentVersion: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    testStore.spaceVersions.set('early-work', [
      {
        spaceId: 'early-work',
        version: 1,
        label: 'Early Work',
        createdAt: now,
      },
    ]);
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    const response = await GET(actorRequest('/api/spaces', 'GET'));

    await expectStatus(response, 200);
    const json = (await response.json()) as { spaces: Array<{ canonicalId?: string; id?: string; kind?: string }> };
    expect(json.spaces[0]).toMatchObject({ canonicalId: 'main', kind: 'main' });
    expect(json.spaces.map((space) => space.canonicalId ?? space.id)).toContain('early-work');
  });

  it('lets regular actors create owned spaces', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    const response = await POST(actorRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' }));

    await expectStatus(response, 201);
    expect(latestVersion(testStore, 'research')?.metadata).toMatchObject({
      ownership: {
        ownerUserId: 'u1',
        ownerTenantId: 't1',
        createdByUserId: 'u1',
        createdByRole: 'user',
      },
    });
  });

  it('requires an actor before mutating spaces', async () => {
    const create = await POST(jsonRequest('/api/spaces', 'POST', { id: 'research', label: 'Research' }));
    const patch = await PATCH(jsonRequest('/api/spaces', 'PATCH', { id: 'research', label: 'Research Ops' }));
    const archive = await DELETE(jsonRequest('/api/spaces', 'DELETE', { id: 'research' }));

    await expectStatus(create, 401);
    await expect(create.json()).resolves.toMatchObject({ error: 'actor_required' });
    await expectStatus(patch, 401);
    await expect(patch.json()).resolves.toMatchObject({ error: 'actor_required' });
    await expectStatus(archive, 401);
    await expect(archive.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects non-owners before patching spaces', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);
    await expectStatus(await POST(actorRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' }, 'user', 'u2')), 201);

    const response = await PATCH(actorRequest('/api/spaces', 'PATCH', { id: 'research', label: 'Research Ops' }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
  });

  it('rejects non-owners before archiving spaces', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);
    await expectStatus(await POST(actorRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' }, 'user', 'u2')), 201);

    const response = await DELETE(actorRequest('/api/spaces', 'DELETE', { id: 'research' }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
  });

  it('lets admins create, patch, and archive global spaces through the store', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    const created = await POST(adminRequest('/api/spaces', 'POST', {
      id: 'research',
      kind: 'work',
      label: 'Research',
      modelConfigId: 'model-a',
      autoMountSkills: false,
    }));
    await expectStatus(created, 201);
    expect(testStore.spaces.get('research')).toMatchObject({ id: 'research', slug: 'research', currentVersion: 1, status: 'active' });
    expect(latestVersion(testStore, 'research')).toMatchObject({ label: 'Research', version: 1, modelConfigId: 'model-a' });
    expect(latestVersion(testStore, 'research')?.metadata).toMatchObject({ autoMountSkills: false });

    const patched = await PATCH(adminRequest('/api/spaces', 'PATCH', { id: 'research', label: 'Research Ops', modelConfigId: 'model-b', autoMountSkills: true }));
    await expectStatus(patched, 200);
    expect(testStore.spaces.get('research')).toMatchObject({ currentVersion: 2 });
    expect(latestVersion(testStore, 'research')).toMatchObject({ label: 'Research Ops', version: 2, modelConfigId: 'model-b' });
    expect(latestVersion(testStore, 'research')?.metadata).toMatchObject({ autoMountSkills: true });

    const listed = await GET(adminRequest('/api/spaces', 'GET'));
    await expectStatus(listed, 200);
    const listedJson = (await listed.json()) as { spaces: Array<{ id?: string; autoMountSkills?: boolean }> };
    expect(listedJson.spaces.find((space) => space.id === 'research')).toMatchObject({ autoMountSkills: true });

    const cleared = await PATCH(adminRequest('/api/spaces', 'PATCH', { id: 'research', modelConfigId: null }));
    await expectStatus(cleared, 200);
    expect(testStore.spaces.get('research')).toMatchObject({ currentVersion: 3 });
    expect(latestVersion(testStore, 'research')).toMatchObject({ label: 'Research Ops', version: 3 });
    expect(latestVersion(testStore, 'research')?.modelConfigId).toBeUndefined();

    const deleted = await DELETE(adminRequest('/api/spaces', 'DELETE', { id: 'research' }));
    await expectStatus(deleted, 200);
    expect(testStore.spaces.get('research')).toMatchObject({ status: 'archived' });
  });

  it('lets creator actors manage shared spaces without per-space ownership metadata', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'shared', kind: 'work', label: 'Shared' })), 201);
    const first = latestVersion(testStore, 'shared');
    if (first) {
      first.metadata = {};
    }

    const patched = await PATCH(actorRequest('/api/spaces', 'PATCH', { id: 'shared', label: 'Shared Ops' }, 'creator'));
    await expectStatus(patched, 200);
    expect(latestVersion(testStore, 'shared')).toMatchObject({ label: 'Shared Ops', version: 2 });
  });

  it('lists all spaces for an avatar that has no explicit binding', async () => {
    const testStore = makeStore();
    seedAvatar(testStore, 'general-agent');
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' })), 201);
    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'writer', kind: 'work', label: 'Writer' })), 201);

    const response = await GET(actorRequest('/api/spaces?avatarId=general-agent', 'GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as { spaces: Array<{ id?: string; storageId?: string; canonicalId?: string }> };

    expect(hasListedSpace(json.spaces, 'research')).toBe(true);
    expect(hasListedSpace(json.spaces, 'writer')).toBe(true);
  });

  it('filters listed spaces when an avatar binds explicit space ids', async () => {
    const testStore = makeStore();
    seedAvatar(testStore, 'research-agent', { boundSpaceIds: ['research'] });
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' })), 201);
    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'writer', kind: 'work', label: 'Writer' })), 201);

    const response = await GET(actorRequest('/api/spaces?avatarId=research-agent', 'GET'));
    await expectStatus(response, 200);
    const json = (await response.json()) as { spaces: Array<{ id?: string; storageId?: string; canonicalId?: string }> };

    expect(hasListedSpace(json.spaces, 'research')).toBe(true);
    expect(hasListedSpace(json.spaces, 'writer')).toBe(false);
  });

  it('requires an actor before reading space capabilities', async () => {
    const response = await GET_CAPABILITIES(new Request('http://localhost/api/spaces/capabilities?spaceId=research'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects malformed capability reads before opening the store', async () => {
    const response = await GET_CAPABILITIES(actorRequest('/api/spaces/capabilities', 'GET'));

    await expectStatus(response, 400);
    await expect(response.json()).resolves.toMatchObject({ error: 'spaceId_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('requires an actor before rebinding space capabilities', async () => {
    const response = await POST_CAPABILITIES(jsonRequest('/api/spaces/capabilities', 'POST', {
      spaceId: 'research',
      toolIds: ['read'],
    }));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('rejects non-owners before rebinding space capabilities', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);
    await expectStatus(await POST(actorRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' }, 'user', 'u2')), 201);

    const response = await POST_CAPABILITIES(actorRequest('/api/spaces/capabilities', 'POST', {
      spaceId: 'research',
      toolIds: ['read'],
    }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
  });

  it('lets admins rebind capabilities and actors read the current profile', async () => {
    const testStore = makeStore();
    storeFromEnvMock.mockResolvedValue(testStore.store as ZleapStore);

    await expectStatus(await POST(adminRequest('/api/spaces', 'POST', { id: 'research', kind: 'work', label: 'Research' })), 201);

    const rebound = await POST_CAPABILITIES(adminRequest('/api/spaces/capabilities', 'POST', {
      spaceId: 'research',
      toolIds: ['read'],
    }));
    await expectStatus(rebound, 200);
    expect(testStore.spaces.get('research')).toMatchObject({ currentVersion: 2 });
    expect(testStore.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spaceId: 'research', spaceVersion: 2, capabilityType: 'tool', capabilityId: 'read' }),
      ]),
    );

    const read = await GET_CAPABILITIES(actorRequest('/api/spaces/capabilities?spaceId=research', 'GET'));
    await expectStatus(read, 200);
    const json = (await read.json()) as { space: { id: string; directToolIds: string[]; capabilities: Array<{ id: string }> } };
    expect(json.space).toMatchObject({ id: 'research', directToolIds: ['read'] });
    expect(json.space.capabilities.map((capability) => capability.id)).toContain('read');
  });
});

function makeStore(): TestStore {
  const avatars = new Map<string, AvatarRecord>();
  const avatarVersions = new Map<string, AvatarVersionRecord[]>();
  const spaces = new Map<string, SpaceRecord>();
  const spaceVersions = new Map<string, SpaceVersionRecord[]>();
  const bindings: SpaceCapabilityBindingRecord[] = [];
  const capabilities = new Map<string, CapabilityDefinitionRecord>();
  const store: TestStore['store'] = {
    transaction: async (operation) => operation(store as ZleapStore),
    avatars: {
      saveAvatar: async (record) => {
        avatars.set(record.id, record);
      },
      saveAvatarVersion: async (record) => {
        upsertVersion(avatarVersions, record.avatarId, record.version, record);
      },
      getAvatar: async (id) => avatars.get(id),
      getAvatarVersion: async (avatarId, version) => selectVersion(avatarVersions.get(avatarId), version),
      listAvatars: async (input = {}) => {
        const records = [...avatars.values()].filter((avatar) => !input.status || avatar.status === input.status);
        return input.limit ? records.slice(0, input.limit) : records;
      },
    },
    spaces: {
      saveSpace: async (record) => {
        spaces.set(record.id, record);
      },
      saveSpaceVersion: async (record) => {
        upsertVersion(spaceVersions, record.spaceId, record.version, record);
      },
      saveCapability: async (record) => {
        capabilities.set(`${record.type}:${record.id}:${record.version}`, record);
      },
      bindCapability: async (record) => {
        const index = bindings.findIndex(
          (binding) =>
            binding.spaceId === record.spaceId &&
            binding.spaceVersion === record.spaceVersion &&
            binding.capabilityType === record.capabilityType &&
            binding.capabilityId === record.capabilityId,
        );
        if (index >= 0) {
          bindings[index] = record;
        } else {
          bindings.push(record);
        }
      },
      getSpace: async (id) => spaces.get(id),
      listSpaces: async (input = {}) => {
        const records = [...spaces.values()].filter((space) => !input.status || space.status === input.status);
        return input.limit ? records.slice(0, input.limit) : records;
      },
      getSpaceVersion: async (spaceId, version) => selectVersion(spaceVersions.get(spaceId), version ?? spaces.get(spaceId)?.currentVersion),
      listCapabilityBindings: async ({ spaceId, version }) => {
        const selectedVersion = version ?? spaces.get(spaceId)?.currentVersion;
        return bindings.filter((binding) => binding.spaceId === spaceId && binding.spaceVersion === selectedVersion);
      },
      getSpaceSnapshot: async ({ avatarId, spaceId, version }) => {
        const space = spaces.get(spaceId);
        if (!space) {
          throw new Error(`Space not found: ${spaceId}`);
        }
        const selectedVersion = version ?? space.currentVersion;
        const spaceVersion = selectVersion(spaceVersions.get(spaceId), selectedVersion);
        if (!spaceVersion) {
          throw new Error(`Space version not found: ${spaceId}@${selectedVersion}`);
        }
        return {
          id: `${avatarId}:${spaceId}:${selectedVersion}`,
          avatarId,
          avatarVersion: 1,
          spaceId,
          spaceVersion: selectedVersion,
          modelConfigId: spaceVersion.modelConfigId,
          summaryModelConfigId: spaceVersion.summaryModelConfigId,
          capabilities: bindings
            .filter((binding) => binding.spaceId === spaceId && binding.spaceVersion === selectedVersion && binding.enabled)
            .map((binding) => ({
              type: binding.capabilityType,
              id: binding.capabilityId,
              version: binding.capabilityVersion,
              config: binding.config,
            })),
          createdAt: new Date('2026-01-01T00:00:00Z'),
        } satisfies SpaceCapabilitySnapshot;
      },
    },
    close: vi.fn(async () => {}),
  };
  return { avatars, avatarVersions, spaces, spaceVersions, bindings, capabilities, store };
}

function seedAvatar(testStore: TestStore, id: string, metadata?: Record<string, unknown>): void {
  const now = new Date('2026-01-01T00:00:00Z');
  testStore.avatars.set(id, {
    id,
    slug: id,
    name: id,
    currentVersion: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  testStore.avatarVersions.set(id, [
    {
      avatarId: id,
      version: 1,
      name: id,
      metadata,
      createdAt: now,
    },
  ]);
}

function hasListedSpace(spaces: Array<{ id?: string; storageId?: string; canonicalId?: string }>, id: string): boolean {
  return spaces.some((space) => space.id === id || space.storageId === id || space.canonicalId === id);
}

function actorRequest(path: string, method: string, body?: unknown, role = 'user', userId = 'u1'): Request {
  return jsonRequest(path, method, body, {
    'x-zleap-user-id': userId,
    'x-zleap-actor-role': role,
    'x-zleap-tenant-id': 't1',
  });
}

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function adminRequest(path: string, method: string, body?: unknown): Request {
  return actorRequest(path, method, body, 'admin');
}

function latestVersion(testStore: TestStore, spaceId: string): SpaceVersionRecord | undefined {
  return selectVersion(testStore.spaceVersions.get(spaceId), testStore.spaces.get(spaceId)?.currentVersion);
}

function upsertVersion<T extends { version: number }>(versions: Map<string, T[]>, id: string, version: number, record: T): void {
  const records = versions.get(id) ?? [];
  const index = records.findIndex((candidate) => candidate.version === version);
  if (index >= 0) {
    records[index] = record;
  } else {
    records.push(record);
  }
  versions.set(id, records);
}

function selectVersion<T extends { version: number }>(records: T[] | undefined, version?: number): T | undefined {
  if (!records?.length) return undefined;
  if (version !== undefined) return records.find((record) => record.version === version);
  return [...records].sort((a, b) => b.version - a.version)[0];
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

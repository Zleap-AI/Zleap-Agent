import type { AvatarRecord, AvatarVersionRecord, ModelConfigRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE as DELETE_AVATAR, GET as GET_AVATARS, PATCH as PATCH_AVATAR, POST as POST_AVATAR } from '../app/api/avatar/route';
import { DELETE as DELETE_MODEL, GET as GET_MODELS, PATCH as PATCH_MODEL, POST as POST_MODEL } from '../app/api/models/route';
import { POST as TEST_MODEL } from '../app/api/models/test/route';
import { createModelConfig, createNamedAvatar, listAvatars, resolveAvatar } from '../lib/server/avatarContext';
import { storeFromEnv } from '../lib/server/avatarStore';
import { listFileModelConfigs } from '../lib/server/modelConfigFileStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/modelConfigFileStore', () => ({
  clearFileDefaultModels: vi.fn(),
  deleteFileModelConfig: vi.fn(),
  getFileModelConfig: vi.fn(),
  listFileModelConfigs: vi.fn(),
  replaceFileModelConfigs: vi.fn(),
  saveFileModelConfig: vi.fn(),
  setFileDefaultModel: vi.fn(),
}));

vi.mock('../lib/server/avatarContext', () => ({
  archiveAvatar: vi.fn(async () => {}),
  avatarErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }),
  cleanAvatarId: (id?: string) => id?.trim(),
  createModelConfig: vi.fn(),
  createNamedAvatar: vi.fn(),
  ensureAvatar: vi.fn(async () => {}),
  listAvatars: vi.fn(),
  resolveAvatar: vi.fn(),
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);
const listFileModelConfigsMock = vi.mocked(listFileModelConfigs);
const createModelConfigMock = vi.mocked(createModelConfig);
const resolveAvatarMock = vi.mocked(resolveAvatar);
const listAvatarsMock = vi.mocked(listAvatars);
const createNamedAvatarMock = vi.mocked(createNamedAvatar);

type TestModelStore = Pick<ZleapStore, 'models' | 'close'>;
type TestAvatarStore = Pick<ZleapStore, 'avatars' | 'transaction' | 'close'>;

describe('/api/models route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('requires an actor before listing models from any persistence backend', async () => {
    const response = await GET_MODELS(new Request('http://localhost/api/models'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(listFileModelConfigsMock).not.toHaveBeenCalled();
  });

  it('requires admin before mutating or testing model configs', async () => {
    const created = await POST_MODEL(actorRequest('/api/models', 'POST', { id: 'main', model: 'gpt-test' }));
    const patched = await PATCH_MODEL(actorRequest('/api/models', 'PATCH', { id: 'main', isDefault: true }));
    const deleted = await DELETE_MODEL(actorRequest('/api/models', 'DELETE', { id: 'main' }));
    const tested = await TEST_MODEL(actorRequest('/api/models/test', 'POST', { id: 'main' }));

    await expectStatus(created, 403);
    await expectStatus(patched, 403);
    await expectStatus(deleted, 403);
    await expectStatus(tested, 403);
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('redacts stored API keys when an actor lists models', async () => {
    const store = makeModelStore([
      {
        id: 'main',
        providerId: 'openai-compatible',
        model: 'gpt-test',
        purpose: 'main',
        config: { apiKey: 'secret-key', baseUrl: 'https://llm.local/v1', isDefault: true },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await GET_MODELS(actorRequest('/api/models', 'GET'));

    await expectStatus(response, 200);
    const json = (await response.json()) as { models: Array<{ id: string; config: Record<string, unknown> }> };
    const model = json.models.find((entry) => entry.id === 'main');
    expect(model?.config).toMatchObject({ hasApiKey: true, baseUrl: 'https://llm.local/v1' });
    expect(model?.config).not.toHaveProperty('apiKey');
  });

  it('allows admins to create and patch model configs through the store', async () => {
    const existing = {
      id: 'main',
      providerId: 'openai-compatible',
      model: 'gpt-old',
      purpose: 'main',
      config: { isDefault: true },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } satisfies ModelConfigRecord;
    const store = makeModelStore([existing]);
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);
    createModelConfigMock.mockResolvedValue({ ...existing, model: 'gpt-new' });

    const created = await POST_MODEL(adminRequest('/api/models', 'POST', { id: 'main-2', model: 'gpt-new' }));
    await expectStatus(created, 201);
    expect(createModelConfigMock).toHaveBeenCalledWith(store, expect.objectContaining({ id: 'main-2', model: 'gpt-new' }));

    const patched = await PATCH_MODEL(adminRequest('/api/models', 'PATCH', { id: 'main', model: 'gpt-updated' }));
    await expectStatus(patched, 200);
    expect(store.models.saveModelConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 'main', model: 'gpt-updated' }));

    const deleted = await DELETE_MODEL(adminRequest('/api/models', 'DELETE', { id: 'main' }));
    await expectStatus(deleted, 200);
    expect(store.models.deleteModelConfig).toHaveBeenCalledWith('main');
  });
});

describe('/api/avatar route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an actor before listing avatars', async () => {
    const response = await GET_AVATARS(new Request('http://localhost/api/avatar'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(resolveAvatarMock).not.toHaveBeenCalled();
  });

  it('requires admin before mutating avatars', async () => {
    const created = await POST_AVATAR(actorRequest('/api/avatar', 'POST', { id: 'writer', name: 'Writer' }));
    const patched = await PATCH_AVATAR(actorRequest('/api/avatar', 'PATCH', { id: 'writer', name: 'Writer 2' }));
    const deleted = await DELETE_AVATAR(actorRequest('/api/avatar', 'DELETE', { id: 'writer' }));

    await expectStatus(created, 403);
    await expectStatus(patched, 403);
    await expectStatus(deleted, 403);
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(createNamedAvatarMock).not.toHaveBeenCalled();
  });

  it('allows actors to list and admins to mutate avatars through the store', async () => {
    const avatar: AvatarRecord = {
      id: 'writer',
      slug: 'writer',
      name: 'Writer',
      status: 'active',
      currentVersion: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const version: AvatarVersionRecord = {
      avatarId: 'writer',
      version: 1,
      name: 'Writer',
      persona: 'writes',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const store = makeAvatarStore(avatar, version);
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);
    resolveAvatarMock.mockResolvedValue({ avatar, version });
    listAvatarsMock.mockResolvedValue([{ id: 'writer', name: 'Writer', status: 'active', currentVersion: 1 }]);
    createNamedAvatarMock.mockResolvedValue({ id: 'critic', name: 'Critic', status: 'active', currentVersion: 1 });

    const listed = await GET_AVATARS(actorRequest('/api/avatar', 'GET'));
    await expectStatus(listed, 200);
    await expect(listed.json()).resolves.toMatchObject({ avatars: [{ id: 'writer', name: 'Writer' }] });

    const created = await POST_AVATAR(adminRequest('/api/avatar', 'POST', { id: 'critic', name: 'Critic' }));
    await expectStatus(created, 201);
    expect(createNamedAvatarMock).toHaveBeenCalledWith(store, expect.objectContaining({ id: 'critic', name: 'Critic' }));

    const patched = await PATCH_AVATAR(adminRequest('/api/avatar', 'PATCH', { id: 'writer', name: 'Writer 2' }));
    await expectStatus(patched, 200);
    expect(store.transaction).toHaveBeenCalled();

    const deleted = await DELETE_AVATAR(adminRequest('/api/avatar', 'DELETE', { id: 'writer' }));
    await expectStatus(deleted, 200);
  });
});

function makeModelStore(models: ModelConfigRecord[]): TestModelStore {
  const records = new Map(models.map((model) => [model.id, model]));
  return {
    models: {
      listModelConfigs: vi.fn(async () => [...records.values()]),
      getModelConfig: vi.fn(async (id: string) => records.get(id)),
      saveModelConfig: vi.fn(async (model: ModelConfigRecord) => {
        records.set(model.id, model);
      }),
      deleteModelConfig: vi.fn(async (id: string) => {
        records.delete(id);
      }),
    },
    close: vi.fn(async () => {}),
  };
}

function makeAvatarStore(
  avatar: AvatarRecord,
  version: AvatarVersionRecord,
): TestAvatarStore {
  const store = {
    avatars: {
      getAvatar: vi.fn(async () => avatar),
      getAvatarVersion: vi.fn(async () => version),
      listAvatars: vi.fn(async () => [avatar]),
      saveAvatar: vi.fn(async () => {}),
      saveAvatarVersion: vi.fn(async () => {}),
    },
    transaction: vi.fn(async (operation: (tx: ZleapStore) => Promise<void>) => {
      await operation(store as unknown as ZleapStore);
    }),
    close: vi.fn(async () => {}),
  };
  return store as unknown as TestAvatarStore;
}

function actorRequest(path: string, method: string, body?: unknown, role = 'user'): Request {
  return new Request(`http://localhost${path}`, {
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

function adminRequest(path: string, method: string, body?: unknown): Request {
  return actorRequest(path, method, body, 'admin');
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

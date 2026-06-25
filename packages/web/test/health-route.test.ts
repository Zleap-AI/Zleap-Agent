import type { ZleapStore } from '@zleap/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/health/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);
const previousDatabaseUrl = process.env.ZLEAP_DATABASE_URL;

beforeEach(() => {
  storeFromEnvMock.mockReset();
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.ZLEAP_DATABASE_URL;
  } else {
    process.env.ZLEAP_DATABASE_URL = previousDatabaseUrl;
  }
});

describe('/api/health route', () => {
  it('requires actor identity before checking persistence health', async () => {
    const response = await GET(new Request('http://localhost/api/health'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('reports ok when persistence is not configured', async () => {
    delete process.env.ZLEAP_DATABASE_URL;
    storeFromEnvMock.mockResolvedValue(null);

    const response = await GET(actorRequest());

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      persistence: { enabled: false, reachable: false },
    });
  });

  it('reports degraded when configured persistence is unreachable', async () => {
    process.env.ZLEAP_DATABASE_URL = 'postgres://example';
    storeFromEnvMock.mockResolvedValue(null);

    const response = await GET(actorRequest());

    await expectStatus(response, 503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      persistence: { enabled: true, reachable: false },
    });
  });

  it('reports ok and closes the store when persistence is reachable', async () => {
    process.env.ZLEAP_DATABASE_URL = 'postgres://example';
    const close = vi.fn(async () => {});
    storeFromEnvMock.mockResolvedValue({ close } as unknown as ZleapStore);

    const response = await GET(actorRequest());

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      persistence: { enabled: true, reachable: true },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

function actorRequest(): Request {
  return new Request('http://localhost/api/health', {
    headers: {
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
}

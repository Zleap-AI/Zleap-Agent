import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousStorePath = process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH;

afterEach(() => {
  if (previousStorePath === undefined) {
    delete process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH;
  } else {
    process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH = previousStorePath;
  }
});

describe('/api/preferences/permissions route', () => {
  it('requires an actor before reading permission preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-permission-prefs-'));
    try {
      process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH = join(root, 'prefs.json');
      vi.resetModules();
      const { GET } = await import('../app/api/preferences/permissions/route');

      const response = await GET(new Request('http://localhost/api/preferences/permissions'));

      await expectStatus(response, 401);
      await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists permission preferences by tenant, user, avatar, and space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-permission-prefs-'));
    const prefsPath = join(root, 'prefs.json');
    try {
      process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH = prefsPath;
      vi.resetModules();
      const { GET, PUT } = await import('../app/api/preferences/permissions/route');

      const saved = await PUT(actorRequest('/api/preferences/permissions', 'PUT', {
        avatarId: 'zleap',
        spaceId: 'main',
        mode: 'full_access',
      }));
      await expectStatus(saved, 200);
      await expect(saved.json()).resolves.toMatchObject({ mode: 'full_access', scope: 'account_space' });

      const sameScope = await GET(actorRequest('/api/preferences/permissions?avatarId=zleap&spaceId=main', 'GET'));
      await expectStatus(sameScope, 200);
      await expect(sameScope.json()).resolves.toMatchObject({ mode: 'full_access', scope: 'account_space' });

      const differentSpace = await GET(actorRequest('/api/preferences/permissions?avatarId=zleap&spaceId=basic', 'GET'));
      await expectStatus(differentSpace, 200);
      await expect(differentSpace.json()).resolves.toMatchObject({ mode: 'request_approval', scope: 'account_space' });

      const raw = JSON.parse(await readFile(prefsPath, 'utf8')) as { records?: Record<string, unknown> };
      expect(Object.keys(raw.records ?? {})).toContain('t1:u1:zleap:main');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

async function expectStatus(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
}

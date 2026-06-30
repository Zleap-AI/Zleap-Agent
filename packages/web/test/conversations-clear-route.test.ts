import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE } from '../app/api/conversations/clear/route';

let root: string | undefined;

describe('/api/conversations/clear route', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('removes history folders but keeps unrelated folders', async () => {
    root = await mkdtemp(join(tmpdir(), 'zleap-history-clear-'));
    vi.stubEnv('ZLEAP_FILE_WORKSPACE_ROOT', root);
    stubFactoryResetFiles(root);
    await mkdir(join(root, '2026-06-14', 'agent-harness'), { recursive: true });
    await writeFile(join(root, '2026-06-14', 'agent-harness', 'note.md'), 'history\n');
    await mkdir(join(root, 'conv-old-history'), { recursive: true });
    await mkdir(join(root, 'settings'), { recursive: true });
    await writeFile(join(root, 'settings', 'keep.json'), '{}\n');

    const response = await DELETE(adminRequest());

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      removedCount: 2,
      history: { removedCount: 2 },
      database: { enabled: false, tablesCleared: 0, defaultsSeeded: false },
      local: {
        projectsCleared: true,
        tasksCleared: true,
        permissionPreferencesCleared: true,
        approvalsCleared: true,
        toolStateCleared: true,
        integrationConfigCleared: true,
        modelFileReset: true,
      },
    });
    await expect(access(join(root, '2026-06-14'))).rejects.toThrow();
    await expect(access(join(root, 'conv-old-history'))).rejects.toThrow();
    await expect(access(join(root, 'settings', 'keep.json'))).resolves.toBeUndefined();
    await expect(access(join(root, 'state', 'projects.json'))).rejects.toThrow();
    const modelConfig = await readFile(join(root, 'state', 'web-models.json'), 'utf8');
    expect(modelConfig).toContain('qwen3.6-flash');
    expect(modelConfig).not.toContain('apiKey');
  });
});

function stubFactoryResetFiles(root: string): void {
  vi.stubEnv('ZLEAP_WEB_PROJECTS_PATH', join(root, 'state', 'projects.json'));
  vi.stubEnv('ZLEAP_WEB_TASKS_PATH', join(root, 'state', 'tasks.json'));
  vi.stubEnv('ZLEAP_WEB_PERMISSION_PREFS_PATH', join(root, 'state', 'permission-preferences.json'));
  vi.stubEnv('ZLEAP_APPROVAL_QUEUE_PATH', join(root, 'state', 'approval-queue.json'));
  vi.stubEnv('ZLEAP_WEB_TOOL_STATE_PATH', join(root, 'state', 'tool-state.json'));
  vi.stubEnv('ZLEAP_302_CONFIG_PATH', join(root, 'state', '302.json'));
  vi.stubEnv('ZLEAP_WEB_MODEL_CONFIG_PATH', join(root, 'state', 'web-models.json'));
}

function adminRequest(): Request {
  return new Request('http://localhost/api/conversations/clear', {
    method: 'DELETE',
    headers: {
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'admin',
      'x-zleap-tenant-id': 't1',
    },
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

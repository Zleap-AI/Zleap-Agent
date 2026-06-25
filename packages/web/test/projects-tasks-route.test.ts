import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as BROWSE_PROJECTS } from '../app/api/projects/browse/route';
import { GET as GET_PROJECT_DEFAULTS } from '../app/api/projects/defaults/route';
import { DELETE as DELETE_PROJECT, GET as GET_PROJECTS, PATCH as PATCH_PROJECT, POST as POST_PROJECT } from '../app/api/projects/route';
import { DELETE as DELETE_TASK, GET as GET_TASKS, PATCH as PATCH_TASK, POST as POST_TASK } from '../app/api/tasks/route';
import { POST as RUN_TASK } from '../app/api/tasks/run/route';
import { storeFromEnv } from '../lib/server/avatarStore';
import { projectStore } from '../lib/server/projectStore';
import { withTaskService } from '../lib/server/taskService';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/projectStore', () => ({
  projectStore: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../lib/server/taskService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/server/taskService')>();
  return {
    ...actual,
    withTaskService: vi.fn(),
  };
});

const projectStoreMock = vi.mocked(projectStore);
const storeFromEnvMock = vi.mocked(storeFromEnv);
const withTaskServiceMock = vi.mocked(withTaskService);
const ALLOWED_PROJECT_PATH = join(homedir(), 'zleap-test-project');

describe('/api/projects route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeFromEnvMock.mockResolvedValue(null);
  });

  it('requires an actor before listing projects', async () => {
    const response = await GET_PROJECTS(new Request('http://localhost/api/projects'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(projectStoreMock.list).not.toHaveBeenCalled();
  });

  it('requires an actor before exposing project browse metadata', async () => {
    const browse = await BROWSE_PROJECTS(new Request('http://localhost/api/projects/browse'));
    const defaults = await GET_PROJECT_DEFAULTS(new Request('http://localhost/api/projects/defaults'));

    await expectStatus(browse, 401);
    await expectStatus(defaults, 401);
    await expect(browse.json()).resolves.toMatchObject({ error: 'actor_required' });
    await expect(defaults.json()).resolves.toMatchObject({ error: 'actor_required' });
  });

  it('requires admin role before mutating projects', async () => {
    const created = await POST_PROJECT(actorRequest('/api/projects', 'POST', { id: 'demo', name: 'Demo', path: '/tmp/demo' }));
    const patched = await PATCH_PROJECT(actorRequest('/api/projects', 'PATCH', { id: 'demo', name: 'Demo 2' }));
    const deleted = await DELETE_PROJECT(actorRequest('/api/projects', 'DELETE', { id: 'demo' }));

    await expectStatus(created, 403);
    await expectStatus(patched, 403);
    await expectStatus(deleted, 403);
    await expect(created.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    await expect(patched.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    await expect(deleted.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(projectStoreMock.create).not.toHaveBeenCalled();
    expect(projectStoreMock.update).not.toHaveBeenCalled();
    expect(projectStoreMock.remove).not.toHaveBeenCalled();
  });

  it('opens the skill folder preset from the configured Zleap skills root', async () => {
    const previous = process.env.ZLEAP_WEB_SKILLS_ROOT;
    const root = await mkdtemp(join(process.cwd(), 'zleap-web-skills-'));
    const skillsRoot = join(root, 'Documents', 'Zleap', 'skills');
    try {
      process.env.ZLEAP_WEB_SKILLS_ROOT = skillsRoot;

      const response = await BROWSE_PROJECTS(actorRequest('/api/projects/browse?preset=skills', 'GET'));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toMatchObject({ path: skillsRoot });
    } finally {
      if (previous === undefined) {
        delete process.env.ZLEAP_WEB_SKILLS_ROOT;
      } else {
        process.env.ZLEAP_WEB_SKILLS_ROOT = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows admins to list and mutate projects through the store', async () => {
    const project = {
      id: 'demo',
      name: 'Demo',
      path: ALLOWED_PROJECT_PATH,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    projectStoreMock.list.mockResolvedValue([project]);
    projectStoreMock.create.mockResolvedValue(project);
    projectStoreMock.update.mockResolvedValue({ ...project, name: 'Demo 2' });
    projectStoreMock.remove.mockResolvedValue(undefined);

    const listed = await GET_PROJECTS(actorRequest('/api/projects', 'GET'));
    await expectStatus(listed, 200);
    await expect(listed.json()).resolves.toEqual({ projects: [project] });

    const created = await POST_PROJECT(adminRequest('/api/projects', 'POST', { id: 'demo', name: 'Demo', path: ALLOWED_PROJECT_PATH }));
    await expectStatus(created, 201);
    expect(projectStoreMock.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo', name: 'Demo', path: ALLOWED_PROJECT_PATH }));

    const patched = await PATCH_PROJECT(adminRequest('/api/projects', 'PATCH', { id: 'demo', name: 'Demo 2' }));
    await expectStatus(patched, 200);
    expect(projectStoreMock.update).toHaveBeenCalledWith('demo', expect.objectContaining({ name: 'Demo 2' }));

    const deleted = await DELETE_PROJECT(adminRequest('/api/projects', 'DELETE', { id: 'demo' }));
    await expectStatus(deleted, 200);
    expect(projectStoreMock.remove).toHaveBeenCalledWith('demo');
  });

});

describe('/api/tasks route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an actor before listing tasks', async () => {
    const response = await GET_TASKS(new Request('http://localhost/api/tasks'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(withTaskServiceMock).not.toHaveBeenCalled();
  });

  it('allows actors to list, mutate, and manually run their own tasks through the service', async () => {
    const task = {
      id: 'nightly',
      name: 'Nightly',
      cron: '* * * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'Run',
      enabled: true,
      avatarId: 'zleap-default',
      conversationId: 'conv-1',
      permissionMode: 'request_approval' as const,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const run = {
      id: 'run-1',
      taskId: task.id,
      trigger: 'manual' as const,
      status: 'queued' as const,
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
    };
    const service = {
      listTasks: vi.fn().mockResolvedValue([task]),
      listRuns: vi.fn().mockResolvedValue([run]),
      createTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue({ ...task, enabled: false }),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      runNow: vi.fn().mockResolvedValue({
        task,
        run,
      }),
    };
    withTaskServiceMock.mockImplementation(async (operation) => operation(service as never));

    const listed = await GET_TASKS(actorRequest('/api/tasks', 'GET'));
    await expectStatus(listed, 200);
    await expect(listed.json()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: 'nightly', timezone: 'Asia/Shanghai', runs: [expect.objectContaining({ id: 'run-1', status: 'queued' })] })],
    });

    const created = await POST_TASK(actorRequest('/api/tasks', 'POST', {
      name: 'Nightly',
      cron: '* * * * *',
      prompt: 'Run',
      conversationId: 'conv-2',
      modelId: 'model-1',
      permissionMode: 'full_access',
      targetSpace: 'work',
    }));
    await expectStatus(created, 201);
    expect(service.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tenantId: 't1' }),
      expect.objectContaining({
        name: 'Nightly',
        conversationId: 'conv-2',
        modelConfigId: 'model-1',
        permissionMode: 'full_access',
        targetSpace: 'work',
      }),
      expect.any(Object),
    );

    const patched = await PATCH_TASK(actorRequest('/api/tasks', 'PATCH', {
      id: 'nightly',
      enabled: false,
      projectId: null,
      conversationId: null,
      modelId: null,
      permissionMode: 'request_approval',
      targetSpace: null,
    }));
    await expectStatus(patched, 200);
    expect(service.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tenantId: 't1' }),
      'nightly',
      expect.objectContaining({
        enabled: false,
        projectId: null,
        conversationId: null,
        modelConfigId: null,
        permissionMode: 'request_approval',
        targetSpace: null,
      }),
    );

    const deleted = await DELETE_TASK(actorRequest('/api/tasks', 'DELETE', { id: 'nightly' }));
    await expectStatus(deleted, 200);
    expect(service.deleteTask).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', tenantId: 't1' }), 'nightly');

    const runResponse = await RUN_TASK(actorRequest('/api/tasks/run', 'POST', { id: 'nightly' }));
    await expectStatus(runResponse, 200);
    expect(service.runNow).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', tenantId: 't1' }), 'nightly');
  });

  it('hides built-in scheduled tasks from default task listings but exposes them in all mode', async () => {
    const task = {
      id: 'memory-dream-u1',
      name: 'Memory Dream',
      type: 'memory_dream',
      cron: '0 3 * * *',
      timezone: 'Asia/Shanghai',
      prompt: '',
      payload: { mode: 'lazy' },
      enabled: true,
      avatarId: 'zleap-default',
      conversationId: 'task:memory-dream-u1',
      permissionMode: 'request_approval' as const,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const service = {
      listTasks: vi.fn().mockResolvedValue([task]),
      listRuns: vi.fn().mockResolvedValue([]),
    };
    withTaskServiceMock.mockImplementation(async (operation) => operation(service as never));

    const listed = await GET_TASKS(actorRequest('/api/tasks', 'GET'));

    await expectStatus(listed, 200);
    await expect(listed.json()).resolves.toEqual({ tasks: [] });

    const allListed = await GET_TASKS(actorRequest('/api/tasks?all=1', 'GET'));

    await expectStatus(allListed, 200);
    await expect(allListed.json()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: 'memory-dream-u1', type: 'memory_dream', builtin: true, deletable: false })],
    });
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

function adminRequest(path: string, method: string, body?: unknown): Request {
  return actorRequest(path, method, body, 'admin');
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}

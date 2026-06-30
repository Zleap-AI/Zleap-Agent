import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDefinitionRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_LOCAL_ARTIFACT } from '../app/api/artifacts/local/route';
import { GET as GET_ARTIFACTS } from '../app/api/artifacts/route';
import { DELETE as DELETE_SKILL, GET as GET_SKILLS, PATCH as PATCH_SKILL, POST as POST_SKILL } from '../app/api/skills/route';
import { GET as GET_SKILL_FILE } from '../app/api/skills/[id]/files/route';
import { POST as IMPORT_SKILL } from '../app/api/skills/import/route';
import { GET as MARKETPLACE_DETAIL } from '../app/api/skills/marketplace/detail/route';
import { POST as MARKETPLACE_IMPORT } from '../app/api/skills/marketplace/import/route';
import { GET as MARKETPLACE_SEARCH } from '../app/api/skills/marketplace/search/route';
import { POST as SCAN_SKILLS } from '../app/api/skills/scan/route';
import { createSkill, saveSkillRecord } from '../lib/server/avatarContext';
import { storeFromEnv } from '../lib/server/avatarStore';
import { projectStore } from '../lib/server/projectStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/avatarContext', () => ({
  avatarErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }),
  createSkill: vi.fn(),
  ensureAvatar: vi.fn(async () => {}),
  saveSkillRecord: vi.fn(),
}));

vi.mock('../lib/server/projectStore', () => ({
  projectStore: {
    list: vi.fn(),
  },
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

const storeFromEnvMock = vi.mocked(storeFromEnv);
const createSkillMock = vi.mocked(createSkill);
const saveSkillRecordMock = vi.mocked(saveSkillRecord);
const projectStoreMock = vi.mocked(projectStore);
const execFileMock = vi.mocked(execFile);

type TestSkillStore = Pick<ZleapStore, 'skills' | 'close'> & {
  skills: Pick<ZleapStore['skills'], 'saveSkill'> & {
    getSkill: ReturnType<typeof vi.fn<() => Promise<SkillDefinitionRecord | undefined>>>;
    listSkills: ReturnType<typeof vi.fn<() => Promise<SkillDefinitionRecord[]>>>;
    deleteSkill: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
};

describe('/api/artifacts route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an actor before listing artifacts', async () => {
    const response = await GET_ARTIFACTS(new Request('http://localhost/api/artifacts'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('allows actors to list gallery artifacts without exposing internal task results', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'zleap-artifact-gallery-'));
    const store = makeArtifactStore();
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = root;
      storeFromEnvMock.mockResolvedValue(store as ZleapStore);

      const response = await GET_ARTIFACTS(actorRequest('/api/artifacts', 'GET'));

      await expectStatus(response, 200);
      const json = (await response.json()) as { artifacts: Array<{ id: string }> };
      expect(json.artifacts[0]).toEqual({ id: 'artifact-file', contentUri: 'file:///tmp/report.md' });
      expect(json.artifacts.some((item) => item.id === 'artifact-file')).toBe(true);
      expect(store.listArtifacts).toHaveBeenCalledWith(150);
      expect(store.close).toHaveBeenCalledOnce();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('/api/artifacts/local route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.list.mockResolvedValue([]);
  });

  it('reads a local artifact from the configured conversation workspace root', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'zleap-artifact-root-'));
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = root;
      const file = join(root, 'web-123', 'project_analysis.md');
      await mkdir(join(root, 'web-123'), { recursive: true });
      await writeFile(file, '# 项目分析\n', 'utf8');

      const response = await GET_LOCAL_ARTIFACT(actorRequest(`/api/artifacts/local?path=${encodeURIComponent(file)}`, 'GET'));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toMatchObject({ path: file, content: '# 项目分析\n' });
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a local artifact from a registered project root', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const historyRoot = await mkdtemp(join(tmpdir(), 'zleap-artifact-root-'));
    const projectRoot = await mkdtemp(join(process.cwd(), 'zleap-artifact-project-'));
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = historyRoot;
      projectStoreMock.list.mockResolvedValue([{
        id: 'project-1',
        name: 'Project One',
        path: projectRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
      const file = join(projectRoot, 'project_analysis.md');
      await writeFile(file, '# 项目分析\n', 'utf8');

      const response = await GET_LOCAL_ARTIFACT(actorRequest(`/api/artifacts/local?path=${encodeURIComponent(file)}`, 'GET'));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toMatchObject({ path: file, content: '# 项目分析\n' });
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(historyRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('serves raw image artifacts with an image content type', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'zleap-artifact-root-'));
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = root;
      const file = join(root, 'web-123', 'preview.png');
      await mkdir(join(root, 'web-123'), { recursive: true });
      await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const response = await GET_LOCAL_ARTIFACT(actorRequest(`/api/artifacts/local?path=${encodeURIComponent(file)}&raw=1`, 'GET'));

      await expectStatus(response, 200);
      expect(response.headers.get('content-type')).toBe('image/png');
      await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves raw PDF artifacts with unicode filenames without invalid response headers', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'zleap-artifact-root-'));
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = root;
      const file = join(root, 'web-123', 'GLM-5.2_深度调研报告.pdf');
      const bytes = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
      await mkdir(join(root, 'web-123'), { recursive: true });
      await writeFile(file, bytes);

      const response = await GET_LOCAL_ARTIFACT(actorRequest(`/api/artifacts/local?path=${encodeURIComponent(file)}&raw=1`, 'GET'));

      await expectStatus(response, 200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''GLM-5.2_%E6%B7%B1%E5%BA%A6%E8%B0%83%E7%A0%94%E6%8A%A5%E5%91%8A.pdf");
      await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', bytes.byteLength);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects local artifact paths outside the configured conversation workspace root', async () => {
    const previousRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'zleap-artifact-root-'));
    try {
      process.env.ZLEAP_FILE_WORKSPACE_ROOT = root;
      const response = await GET_LOCAL_ARTIFACT(actorRequest(`/api/artifacts/local?path=${encodeURIComponent('/etc/passwd')}`, 'GET'));

      await expectStatus(response, 403);
      await expect(response.json()).resolves.toMatchObject({ error: 'artifact_path_not_allowed' });
    } finally {
      if (previousRoot === undefined) {
        delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
      } else {
        process.env.ZLEAP_FILE_WORKSPACE_ROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('/api/skills route actor contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.SKILLS_SH_OIDC_TOKEN;
    delete process.env.VERCEL_OIDC_TOKEN;
  });

  it('requires an actor before listing skills', async () => {
    const response = await GET_SKILLS(new Request('http://localhost/api/skills'));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
  });

  it('requires admin before creating skills', async () => {
    const response = await POST_SKILL(actorRequest('/api/skills', 'POST', { id: 'research', label: 'Research' }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_forbidden' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(createSkillMock).not.toHaveBeenCalled();
  });

  it('allows actors to list and admins to create skills through the store', async () => {
    const store = makeSkillStore();
    const skill: SkillDefinitionRecord = {
      id: 'research',
      version: 1,
      origin: 'user',
      label: 'Research',
      toolIds: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    store.skills.listSkills.mockResolvedValue([skill]);
    createSkillMock.mockResolvedValue(skill);

    const listed = await GET_SKILLS(actorRequest('/api/skills', 'GET'));
    await expectStatus(listed, 200);
    await expect(listed.json()).resolves.toMatchObject({ skills: [{ id: 'research', label: 'Research' }] });

    const created = await POST_SKILL(adminRequest('/api/skills', 'POST', { id: 'research', label: 'Research' }));
    await expectStatus(created, 201);
    expect(createSkillMock).toHaveBeenCalledWith(store, expect.objectContaining({ id: 'research', label: 'Research' }));
  });

  it('imports a standard SKILL.md package through the package parser', async () => {
    const store = makeSkillStore();
    const skill: SkillDefinitionRecord = {
      id: 'repo-review',
      version: 1,
      origin: 'user',
      label: 'repo-review',
      description: 'Review a repository.',
      instructions: '# Steps\n',
      body: '# Steps\n',
      toolIds: ['read'],
      sourceType: 'imported',
      trustStatus: 'review_required',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    saveSkillRecordMock.mockResolvedValue(skill);

    const response = await IMPORT_SKILL(adminRequest('/api/skills/import', 'POST', {
      skillMd: '---\nname: repo-review\ndescription: Review a repository.\nallowed-tools:\n  - read\n---\n# Steps\n',
    }));

    await expectStatus(response, 201);
    await expect(response.json()).resolves.toMatchObject({
      skill: { id: 'repo-review', sourceType: 'imported', trustStatus: 'review_required' },
    });
    expect(saveSkillRecordMock).toHaveBeenCalledWith(store, expect.objectContaining({ id: 'repo-review' }), undefined);
  });

  it('updates and deletes skills with admin access', async () => {
    const store = makeSkillStore();
    const existing: SkillDefinitionRecord = {
      id: 'research',
      version: 1,
      origin: 'user',
      label: 'Research',
      toolIds: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    store.skills.getSkill.mockResolvedValue(existing);
    saveSkillRecordMock.mockImplementation(async (_store, record) => record);

    const patched = await PATCH_SKILL(adminRequest('/api/skills', 'PATCH', { id: 'research', label: 'Research v2' }));
    await expectStatus(patched, 200);
    await expect(patched.json()).resolves.toMatchObject({ skill: { id: 'research', label: 'Research v2' } });

    const deleted = await DELETE_SKILL(adminRequest('/api/skills', 'DELETE', { id: 'research' }));
    await expectStatus(deleted, 200);
    expect(store.skills.deleteSkill).toHaveBeenCalledWith('research', undefined);
  });

  it('scans a skill source root and indexes discovered packages', async () => {
    const store = makeSkillStore();
    const sourceRoot = await mkdtemp(join(tmpdir(), 'zleap-skill-source-'));
    try {
      const packageRoot = join(sourceRoot, 'repo-review');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(packageRoot + '/SKILL.md', '---\nname: repo-review\ndescription: Review repos.\n---\n# Steps\n', 'utf8');
      storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
      saveSkillRecordMock.mockImplementation(async (_store, record) => record);

      const response = await SCAN_SKILLS(adminRequest('/api/skills/scan', 'POST', {
        roots: [{ root: sourceRoot, sourceType: 'project' }],
      }));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toMatchObject({
        skills: [{ id: 'repo-review', sourceType: 'project' }],
        errors: [],
      });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('explains that scanning skills needs a database', async () => {
    storeFromEnvMock.mockResolvedValue(null);

    const response = await SCAN_SKILLS(adminRequest('/api/skills/scan', 'POST', {}));

    await expectStatus(response, 503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'database_required',
      message: expect.stringContaining('技能需要数据库'),
    });
  });

  it('reads text files from inside a skill package', async () => {
    const store = makeSkillStore();
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-skill-package-'));
    try {
      await writeFile(join(packageRoot, 'SKILL.md'), '---\nname: repo-review\ndescription: Review repos.\n---\n# Steps\n', 'utf8');
      store.skills.getSkill.mockResolvedValue({
        id: 'repo-review',
        version: 1,
        origin: 'user',
        label: 'repo-review',
        toolIds: [],
        packageRoot,
        files: [{ path: 'SKILL.md', kind: 'skill', size: 64 }],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

      const response = await GET_SKILL_FILE(
        actorRequest('/api/skills/repo-review/files?path=SKILL.md', 'GET'),
        { params: Promise.resolve({ id: 'repo-review' }) },
      );

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toMatchObject({ path: 'SKILL.md', content: expect.stringContaining('# Steps') });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('searches skills.sh marketplace and filters duplicate results', async () => {
    const store = makeSkillStore();
    store.skills.listSkills.mockResolvedValue([
      {
        id: 'local-skill',
        version: 1,
        origin: 'user',
        label: 'Local Skill',
        toolIds: [],
        metadata: { marketplace: { id: 'owner/repo/local-skill' } },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    process.env.SKILLS_SH_OIDC_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/v1/skills/search')) {
        return Response.json({
          data: [
            {
              id: 'owner/repo/duplicate',
              slug: 'duplicate',
              name: 'Duplicate',
              source: 'owner/repo',
              installs: 999,
              sourceType: 'github',
              installUrl: 'https://github.com/owner/repo',
              url: 'https://skills.sh/owner/repo/duplicate',
              isDuplicate: true,
            },
            {
              id: 'owner/repo/local-skill',
              slug: 'local-skill',
              name: 'Local Skill',
              source: 'owner/repo',
              installs: 50,
              sourceType: 'github',
              installUrl: 'https://github.com/owner/repo',
              url: 'https://skills.sh/owner/repo/local-skill',
            },
            {
              id: 'vercel-labs/skills/find-skills',
              slug: 'find-skills',
              name: 'find-skills',
              source: 'vercel-labs/skills',
              installs: 2_000_000,
              sourceType: 'github',
              installUrl: 'https://github.com/vercel-labs/skills',
              url: 'https://skills.sh/vercel-labs/skills/find-skills',
            },
          ],
        });
      }
      return Response.json({ audits: [{ provider: 'Socket', status: 'pass', summary: 'No alerts' }] });
    }));

    const response = await MARKETPLACE_SEARCH(actorRequest('/api/skills/marketplace/search?q=skill', 'GET'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      skills: [
        { id: 'vercel-labs/skills/find-skills', audit: { status: 'pass' } },
        { id: 'owner/repo/local-skill', installed: true },
      ],
    });
  });

  it('searches the skills marketplace through npx skills when no OIDC token is configured', async () => {
    const store = makeSkillStore();
    store.skills.listSkills.mockResolvedValue([]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
    mockSkillsCli((args) => {
      if (args.includes('find') && args.includes('skill')) {
        return {
          stdout: [
            'Install with npx skills add <owner/repo@skill>',
            '',
            'vercel-labs/skills@find-skills 2.1M installs',
            '└ https://skills.sh/vercel-labs/skills/find-skills',
          ].join('\n'),
        };
      }
      return { stdout: '' };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(publicSkillPageHtml(), { status: 200 })));

    const response = await MARKETPLACE_SEARCH(actorRequest('/api/skills/marketplace/search?q=skill', 'GET'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      skills: [
        {
          id: 'vercel-labs/skills/find-skills',
          installs: 2_100_000,
          audit: { status: 'pass' },
        },
      ],
    });
    expect(execFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/npx/),
      ['--yes', 'skills', 'find', 'skill'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns marketplace detail with SKILL.md preview', async () => {
    process.env.SKILLS_SH_OIDC_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/v1/skills/audit/')) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      return Response.json({
        id: 'vercel-labs/skills/find-skills',
        source: 'vercel-labs/skills',
        slug: 'find-skills',
        installs: 12,
        hash: 'hash',
        files: [{ path: 'SKILL.md', contents: '---\nname: find-skills\ndescription: Find skills.\n---\n# Find Skills\n' }],
      });
    }));

    const response = await MARKETPLACE_DETAIL(actorRequest('/api/skills/marketplace/detail?id=vercel-labs/skills/find-skills', 'GET'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      detail: {
        id: 'vercel-labs/skills/find-skills',
        skillMd: expect.stringContaining('# Find Skills'),
        audit: { status: 'unknown' },
      },
    });
  });

  it('returns marketplace detail through npx skills use when no OIDC token is configured', async () => {
    mockSkillsCli((args) => {
      if (args.includes('use') && args.includes('vercel-labs/skills@find-skills')) {
        return {
          stdout: [
            'Use the following SKILL.md as your instructions:',
            '<SKILL.md>',
            '---',
            'name: find-skills',
            'description: Find skills.',
            '---',
            '# Find Skills',
            '</SKILL.md>',
          ].join('\n'),
        };
      }
      return { stdout: '' };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(publicSkillPageHtml(), { status: 200 })));

    const response = await MARKETPLACE_DETAIL(actorRequest('/api/skills/marketplace/detail?id=vercel-labs/skills/find-skills', 'GET'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      detail: {
        id: 'vercel-labs/skills/find-skills',
        skillMd: expect.stringContaining('# Find Skills'),
        audit: { status: 'pass' },
      },
    });
  });

  it('imports marketplace skills with review-only defaults and no space binding', async () => {
    const store = makeSkillStore();
    const root = await mkdtemp(join(tmpdir(), 'zleap-marketplace-skills-'));
    try {
      storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
      saveSkillRecordMock.mockImplementation(async (_store, record) => record);
      process.env.SKILLS_SH_OIDC_TOKEN = 'test-token';
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/api/v1/skills/audit/')) {
          return Response.json({ audits: [{ provider: 'Socket', status: 'warn', summary: 'Review recommended' }] });
        }
        return Response.json({
          id: 'vercel-labs/skills/find-skills',
          source: 'vercel-labs/skills',
          slug: 'find-skills',
          installs: 12,
          hash: 'hash',
          files: [
            {
              path: 'SKILL.md',
              contents: '---\nname: find-skills\ndescription: Find skills.\nallowed-tools:\n  - bash\n---\n# Find Skills\n',
            },
          ],
        });
      }));

      const response = await MARKETPLACE_IMPORT(adminRequest('/api/skills/marketplace/import', 'POST', {
        id: 'vercel-labs/skills/find-skills',
        root,
      }));

      await expectStatus(response, 201);
      await expect(response.json()).resolves.toMatchObject({
        skill: {
          id: 'find-skills',
          sourceType: 'imported',
          trustStatus: 'review_required',
          invocationPolicy: 'explicit_only',
          toolIds: [],
          allowedTools: ['bash'],
        },
      });
      expect(saveSkillRecordMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          id: 'find-skills',
          sourceType: 'imported',
          trustStatus: 'review_required',
          invocationPolicy: 'explicit_only',
          toolIds: [],
          allowedTools: ['bash'],
          metadata: expect.objectContaining({
            marketplace: expect.objectContaining({ id: 'vercel-labs/skills/find-skills' }),
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports marketplace skills through npx skills add when no OIDC token is configured', async () => {
    const store = makeSkillStore();
    const root = await mkdtemp(join(tmpdir(), 'zleap-marketplace-skills-'));
    try {
      storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);
      saveSkillRecordMock.mockImplementation(async (_store, record) => record);
      mockSkillsCli((args, options) => {
        if (args.includes('add') && args.includes('vercel-labs/skills@find-skills')) {
          const cwd = typeof options.cwd === 'string' ? options.cwd : '';
          const installedRoot = join(cwd, '.claude', 'skills', 'find-skills');
          mkdirSync(installedRoot, { recursive: true });
          writeFileSync(
            join(installedRoot, 'SKILL.md'),
            '---\nname: find-skills\ndescription: Find skills.\nallowed-tools:\n  - bash\n---\n# Find Skills\n',
            'utf8',
          );
          return { stdout: 'Installed 1 skill' };
        }
        return { stdout: '' };
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(publicSkillPageHtml(), { status: 200 })));

      const response = await MARKETPLACE_IMPORT(adminRequest('/api/skills/marketplace/import', 'POST', {
        id: 'vercel-labs/skills/find-skills',
        root,
      }));

      await expectStatus(response, 201);
      await expect(response.json()).resolves.toMatchObject({
        skill: {
          id: 'find-skills',
          sourceType: 'imported',
          trustStatus: 'review_required',
          invocationPolicy: 'explicit_only',
          toolIds: [],
          allowedTools: ['bash'],
        },
      });
      expect(saveSkillRecordMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          id: 'find-skills',
          sourceType: 'imported',
          trustStatus: 'review_required',
          invocationPolicy: 'explicit_only',
          toolIds: [],
          allowedTools: ['bash'],
          metadata: expect.objectContaining({
            marketplace: expect.objectContaining({ id: 'vercel-labs/skills/find-skills' }),
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeArtifactStore(): Pick<ZleapStore, 'listArtifacts' | 'close'> {
  return {
    listArtifacts: vi.fn(async () => [
      { id: 'artifact-file', contentUri: 'file:///tmp/report.md' },
      { id: 'task-result' },
    ]),
    close: vi.fn(async () => {}),
  } as unknown as Pick<ZleapStore, 'listArtifacts' | 'close'>;
}

function mockSkillsCli(handler: (
  args: string[],
  options: { cwd?: string },
) => { stdout?: string; stderr?: string }): void {
  execFileMock.mockImplementation(((_command: unknown, args: unknown, options: unknown, callback: unknown) => {
    const cleanArgs = Array.isArray(args) ? args.map(String) : [];
    const cleanOptions = options && typeof options === 'object' ? options as { cwd?: string } : {};
    const cb = typeof callback === 'function' ? callback as (error: Error | null, stdout: string, stderr: string) => void : undefined;
    const result = handler(cleanArgs, cleanOptions);
    queueMicrotask(() => cb?.(null, result.stdout ?? '', result.stderr ?? ''));
    return {} as ReturnType<typeof execFile>;
  }) as never);
}

function publicSkillPageHtml(): string {
  return [
    '<!DOCTYPE html><html><head>',
    '<script type="application/ld+json">',
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'find-skills',
      interactionStatistic: { userInteractionCount: 2_100_000 },
    }),
    '</script>',
    '</head><body>',
    '<div>Security Audits</div>',
    '<a href="/vercel-labs/skills/find-skills/security/socket"><span>Socket</span><span>Pass</span></a>',
    '</body></html>',
  ].join('');
}

function makeSkillStore(): TestSkillStore {
  return {
    skills: {
      listSkills: vi.fn(),
      saveSkill: vi.fn(async () => {}),
      getSkill: vi.fn(async () => undefined),
      deleteSkill: vi.fn(async () => {}),
    },
    close: vi.fn(async () => {}),
  };
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

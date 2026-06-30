import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceFileArtifacts } from '../lib/server/workspaceArtifactScan';

const originalRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
let tempRoot: string | undefined;

afterEach(async () => {
  process.env.ZLEAP_FILE_WORKSPACE_ROOT = originalRoot;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('listWorkspaceFileArtifacts', () => {
  it('reads only source-registered artifacts from conversation workspaces', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-artifacts-'));
    process.env.ZLEAP_FILE_WORKSPACE_ROOT = tempRoot;

    const skillDir = join(tempRoot, 'skills', 'marketplace__openai__skills__pptx');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# PPTX skill');

    const chatDir = join(tempRoot, '2026-06-22', 'chat-test');
    await mkdir(join(chatDir, '.zleap'), { recursive: true });
    await writeFile(join(chatDir, 'report.pptx'), 'pptx bytes');
    await writeFile(join(chatDir, '.zleap', 'artifacts.json'), JSON.stringify([
      { path: join(chatDir, 'report.pptx'), title: 'report.pptx', kind: 'file', source: 'generated', createdAt: '2026-06-22T01:00:00.000Z' },
    ]));

    const artifacts = await listWorkspaceFileArtifacts();

    expect(artifacts.map((artifact) => artifact.title)).toEqual(['report.pptx']);
    expect(JSON.stringify(artifacts)).not.toContain('/skills/');
    expect(artifacts.map((artifact) => artifact.title)).not.toContain('SKILL.md');
  });

  it('does not treat cloned repository files as artifacts without registry entries', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-artifacts-'));
    process.env.ZLEAP_FILE_WORKSPACE_ROOT = tempRoot;

    const repoDir = join(tempRoot, '2026-06-29', 'chat-test', 'SAG');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, 'README.md'), '# cloned repo');
    await writeFile(join(repoDir, 'logo.svg'), '<svg />');

    await expect(listWorkspaceFileArtifacts()).resolves.toEqual([]);
  });

  it('filters imported registry entries from the artifact gallery', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-artifacts-'));
    process.env.ZLEAP_FILE_WORKSPACE_ROOT = tempRoot;

    const chatDir = join(tempRoot, '2026-06-29', 'chat-test');
    await mkdir(join(chatDir, '.zleap'), { recursive: true });
    await writeFile(join(chatDir, 'report.pdf'), '%PDF');
    await writeFile(join(chatDir, 'SAG_README.md'), '# cloned repo');
    await writeFile(join(chatDir, '.zleap', 'artifacts.json'), JSON.stringify([
      { path: join(chatDir, 'SAG_README.md'), title: 'SAG_README.md', kind: 'md', source: 'imported', createdAt: '2026-06-29T01:00:00.000Z' },
      { path: join(chatDir, 'report.pdf'), title: 'report.pdf', kind: 'pdf', source: 'generated', createdAt: '2026-06-29T02:00:00.000Z' },
    ]));

    const artifacts = await listWorkspaceFileArtifacts();

    expect(artifacts.map((artifact) => artifact.title)).toEqual(['report.pdf']);
  });
});

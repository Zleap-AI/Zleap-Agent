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
  it('does not treat local installed skills as generated artifacts', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-artifacts-'));
    process.env.ZLEAP_FILE_WORKSPACE_ROOT = tempRoot;

    const skillDir = join(tempRoot, 'skills', 'marketplace__openai__skills__pptx');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# PPTX skill');

    const chatDir = join(tempRoot, '2026-06-22', 'chat-test');
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, 'report.pptx'), 'pptx bytes');

    const artifacts = await listWorkspaceFileArtifacts();

    expect(artifacts.map((artifact) => artifact.title)).toContain('report.pptx');
    expect(JSON.stringify(artifacts)).not.toContain('/skills/');
    expect(artifacts.map((artifact) => artifact.title)).not.toContain('SKILL.md');
  });
});

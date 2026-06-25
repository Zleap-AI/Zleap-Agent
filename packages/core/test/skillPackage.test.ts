import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applySkillToolPolicy,
  skillDefinitionFromRecord,
} from '../src/index.js';
import {
  parseSkillPackage,
  skillRecordFromPackageManifest,
  SkillPackageError,
} from '../src/skillPackage.js';
import {
  defaultZleapSkillsRoot,
  defaultSkillSourceRoots,
  scanSkillSourceRoot,
} from '../src/skillSources.js';

describe('skill package compatibility', () => {
  it('parses a standard SKILL.md package with Claude and Codex metadata', () => {
    const manifest = parseSkillPackage({
      root: '/repo/.agents/skills/repo-review',
      sourceType: 'project',
      skillMd: [
        '---',
        'name: repo-review',
        'description: Review repository changes and produce risk-ranked findings.',
        'license: MIT',
        'allowed-tools:',
        '  - read',
        '  - grep',
        'disallowed-tools:',
        '  - bash',
        'disable-model-invocation: true',
        'arguments:',
        '  - name: target',
        '    required: true',
        '---',
        '# Review',
        'Read the diff before commenting.',
      ].join('\n'),
      openaiYaml: [
        'interface: markdown',
        'allow_implicit_invocation: false',
        'dependencies:',
        '  commands:',
        '    - git',
      ].join('\n'),
      files: [{ path: 'references/checklist.md', kind: 'reference', size: 12 }],
    });

    expect(manifest).toMatchObject({
      id: 'repo-review',
      sourceName: 'repo-review',
      label: 'repo-review',
      description: 'Review repository changes and produce risk-ranked findings.',
      license: 'MIT',
      allowedTools: ['read', 'grep'],
      disallowedTools: ['bash'],
      invocationPolicy: 'explicit_only',
      trustStatus: 'trusted',
      claudeConfig: {
        'disable-model-invocation': true,
      },
      openaiConfig: {
        interface: 'markdown',
        allow_implicit_invocation: false,
      },
    });
    expect(manifest.files.map((file) => file.path)).toEqual(['agents/openai.yaml', 'references/checklist.md', 'SKILL.md']);
    expect(manifest.schemaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects skills without required frontmatter', () => {
    expect(() => parseSkillPackage({ root: '/tmp/bad', skillMd: '# Missing' })).toThrow(SkillPackageError);
    expect(() =>
      parseSkillPackage({
        root: '/tmp/bad',
        skillMd: ['---', 'name: missing-description', '---', 'Body'].join('\n'),
      }),
    ).toThrow(/description/);
  });

  it('turns a package manifest into the existing runtime skill shape', () => {
    const manifest = parseSkillPackage({
      root: '/repo/.agents/skills/report',
      skillMd: ['---', 'name: report', 'description: Write clear reports.', '---', '# Draft\nUse concise sections.'].join('\n'),
    });
    const record = skillRecordFromPackageManifest(manifest, { origin: 'project', sourceType: 'project' });
    const skill = skillDefinitionFromRecord(record);

    expect(skill).toMatchObject({
      id: 'report',
      procedureId: 'skill:report@1',
      instructions: '# Draft\nUse concise sections.',
      source: { type: 'project', sourceName: 'report' },
      trustStatus: 'trusted',
      invocationPolicy: 'implicit',
      sections: [{ id: 'draft', title: 'Draft', level: 1 }],
    });
  });

  it('scans project-level skill source roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zleap-skills-'));
    const skillDir = join(dir, '.agents', 'skills', 'summarize');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: summarize', 'description: Summarize long research notes.', '---', '# Steps'].join('\n'),
    );
    await writeFile(join(skillDir, 'references', 'style.md'), 'Use short bullets.');

    const roots = defaultSkillSourceRoots({ projectRoot: dir, homeDir: join(dir, 'home') });
    const result = await scanSkillSourceRoot(roots[0]!);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ok: true });
    if (result[0]?.ok) {
      expect(result[0].manifest.id).toBe('summarize');
      expect(result[0].manifest.files.some((file) => file.path === 'references/style.md')).toBe(true);
    }
  });

  it('uses Documents/Zleap for the default Zleap user skill root', () => {
    const home = join(tmpdir(), 'zleap-home');
    const roots = defaultSkillSourceRoots({ homeDir: home });

    expect(defaultZleapSkillsRoot(home)).toBe(join(home, 'Documents', 'Zleap', 'skills'));
    expect(roots).toContainEqual({ root: join(home, 'Documents', 'Zleap', 'skills'), sourceType: 'user' });
    expect(roots).not.toContainEqual({ root: join(home, 'Zleap', 'skills'), sourceType: 'user' });
  });

  it('scans a selected skill package directory directly', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-skill-package-root-'));
    await mkdir(join(packageRoot, 'scripts'), { recursive: true });
    await writeFile(
      join(packageRoot, 'SKILL.md'),
      ['---', 'name: direct-skill', 'description: Import the selected package folder.', '---', '# Steps'].join('\n'),
    );
    await writeFile(join(packageRoot, 'scripts', 'run.sh'), 'echo ok');

    const result = await scanSkillSourceRoot({ root: packageRoot, sourceType: 'user' });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ok: true });
    if (result[0]?.ok) {
      expect(result[0].manifest.id).toBe('direct-skill');
      expect(result[0].manifest.files.some((file) => file.path === 'scripts/run.sh')).toBe(true);
    }
  });

  it('applies skill tool policy as a narrowing filter only', () => {
    const result = applySkillToolPolicy(['read', 'write', 'bash'], [
      { allowedTools: ['read', 'write'], disallowedTools: ['write'] },
    ]);

    expect(result.tools).toEqual(['read']);
    expect(result.blockedTools).toEqual(['bash', 'write']);
  });
});

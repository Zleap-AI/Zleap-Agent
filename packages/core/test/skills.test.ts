import { describe, expect, it } from 'vitest';
import {
  auditSkillSensitivity,
  buildSkillMemoryMetadata,
  indexSkillSections,
  searchSkillManifests,
  skillDefinitionFromRecord,
  SkillRegistry,
  type SkillDefinitionRecord,
} from '../src/index.js';

describe('skill memory manifests', () => {
  it('derives versioned procedure metadata without exposing sensitive matches', () => {
    const instructions = [
      '# Deploy',
      'Run the checked deploy procedure.',
      '',
      '## Rollback',
      'password="SECRET_VALUE_SHOULD_NOT_BE_RETURNED"',
    ].join('\n');
    const metadata = buildSkillMemoryMetadata({ id: 'deploy', version: 3, instructions, tokenBudget: 320 });

    expect(metadata).toMatchObject({
      kind: 'skill_memory',
      lifecycle: 'long_term',
      procedureId: 'skill:deploy@3',
      tokenBudget: 320,
      sensitivity: {
        status: 'review',
        findings: [{ kind: 'secret_like', severity: 'medium', count: 1 }],
      },
    });
    expect(JSON.stringify(metadata)).not.toContain('SECRET_VALUE_SHOULD_NOT_BE_RETURNED');
  });

  it('turns a stored skill version into a searchable long-term manifest', () => {
    const record: SkillDefinitionRecord = {
      id: 'release',
      version: 2,
      origin: 'user',
      label: 'Release Skill',
      description: 'Deploy and rollback checklist',
      instructions: '# Deploy\nRun checks.\n\n## Rollback\nRestore previous build.',
      toolIds: ['bash'],
      metadata: { tokenBudget: 260 },
      createdAt: new Date('2026-06-14T00:00:00Z'),
    };
    const skill = skillDefinitionFromRecord(record);

    expect(skill).toMatchObject({
      id: 'release',
      version: 2,
      procedureId: 'skill:release@2',
      lifecycle: 'long_term',
      tokenBudget: 260,
      sections: [
        { id: 'deploy', title: 'Deploy', level: 1 },
        { id: 'rollback', title: 'Rollback', level: 2 },
      ],
    });
    expect(searchSkillManifests([skill], { query: 'rollback', limit: 5 })).toEqual([skill]);

    const registry = new SkillRegistry();
    registry.register(skill);
    expect(registry.search({ query: 'bash' })).toEqual([skill]);
  });

  it('tokenizes mixed Chinese and English skill queries before scoring', () => {
    const ppt: SkillDefinitionRecord = {
      id: 'pptx',
      version: 1,
      origin: 'user',
      label: 'PPT deck generator',
      description: 'Create editable PowerPoint presentations with python-pptx.',
      instructions: '# PPT\nGenerate a deck.',
      metadata: {},
      createdAt: new Date('2026-06-20T00:00:00Z'),
    };
    const python: SkillDefinitionRecord = {
      id: 'python',
      version: 1,
      origin: 'user',
      label: 'Python helper',
      description: 'Run Python scripts.',
      instructions: '# Python\nRun scripts.',
      metadata: {},
      createdAt: new Date('2026-06-20T00:00:00Z'),
    };

    expect(searchSkillManifests([skillDefinitionFromRecord(python), skillDefinitionFromRecord(ppt)], { query: '做ppt' })
      .map((skill) => skill.id)).toEqual(['pptx']);
    expect(searchSkillManifests([skillDefinitionFromRecord(python), skillDefinitionFromRecord(ppt)], { query: 'python ppt' })
      .map((skill) => skill.id)).toEqual(['pptx', 'python']);
  });

  it('ranks skill search by matched token count and defaults to three results', () => {
    const records = [
      {
        id: 'pptx',
        label: 'PowerPoint deck generator',
        description: 'Create editable ppt presentation with charts.',
      },
      {
        id: 'slides',
        label: 'Presentation helper',
        description: 'Create presentation outlines.',
      },
      {
        id: 'chart',
        label: 'Chart renderer',
        description: 'Create charts from data.',
      },
      {
        id: 'writer',
        label: 'Document writer',
        description: 'Write long-form documents.',
      },
    ].map((record): SkillDefinitionRecord => ({
      ...record,
      version: 1,
      origin: 'user',
      instructions: '# Skill\nUse it.',
      metadata: {},
      createdAt: new Date('2026-06-20T00:00:00Z'),
    }));

    expect(searchSkillManifests(records.map(skillDefinitionFromRecord), { query: 'ppt presentation chart create' })
      .map((skill) => skill.id)).toEqual(['pptx', 'chart', 'slides']);
  });

  it('ignores fenced headings and audits by category only', () => {
    const instructions = '```\n# Hidden\n```\n# Visible\n-----BEGIN PRIVATE KEY-----\nsecret: abcdefghijk';

    expect(indexSkillSections(instructions)).toEqual([{ id: 'visible', title: 'Visible', level: 1 }]);
    expect(auditSkillSensitivity(instructions)).toEqual({
      status: 'review',
      findings: [
        { kind: 'private_key', severity: 'high', count: 1 },
        { kind: 'secret_like', severity: 'medium', count: 1 },
      ],
    });
  });
});

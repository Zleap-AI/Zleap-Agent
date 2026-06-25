import type { SkillDefinitionRecord } from '@zleap/core';

export function skillView(skill: SkillDefinitionRecord) {
  return {
    id: skill.id,
    version: skill.version,
    origin: skill.origin,
    label: skill.label,
    description: skill.description,
    instructions: skill.instructions,
    toolIds: skill.toolIds,
    sourceType: skill.sourceType ?? 'db',
    sourcePath: skill.sourcePath,
    packageRoot: skill.packageRoot,
    sourceName: skill.sourceName,
    frontmatter: skill.frontmatter,
    body: skill.body,
    files: skill.files ?? [],
    openaiConfig: skill.openaiConfig,
    claudeConfig: skill.claudeConfig,
    license: skill.license,
    compatibility: skill.compatibility,
    allowedTools: skill.allowedTools ?? [],
    disallowedTools: skill.disallowedTools ?? [],
    invocationPolicy: skill.invocationPolicy ?? 'implicit',
    trustStatus: skill.trustStatus ?? 'trusted',
    riskAudit: skill.riskAudit,
    schemaHash: skill.schemaHash,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: (skill.updatedAt ?? skill.createdAt).toISOString(),
  };
}

export type SkillView = ReturnType<typeof skillView>;

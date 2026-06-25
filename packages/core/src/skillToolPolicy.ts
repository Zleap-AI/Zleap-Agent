import type { SkillDefinition, ToolDescriptor } from './types.js';

export type SkillToolPolicyResult<T extends string | ToolDescriptor> = {
  tools: T[];
  allowedTools: string[];
  disallowedTools: string[];
  blockedTools: string[];
};

export function applySkillToolPolicy<T extends string | ToolDescriptor>(
  tools: T[],
  skills: Array<Pick<SkillDefinition, 'allowedTools' | 'disallowedTools'>>,
): SkillToolPolicyResult<T> {
  const allowed = unionSkillTools(skills, 'allowedTools');
  const disallowed = unionSkillTools(skills, 'disallowedTools');
  const existingIds = new Set(tools.map(toolId));
  const blockedTools: string[] = [];
  const filtered = tools.filter((tool) => {
    const id = toolId(tool);
    if (disallowed.has(id)) {
      blockedTools.push(id);
      return false;
    }
    if (allowed.size > 0 && !allowed.has(id)) {
      blockedTools.push(id);
      return false;
    }
    return true;
  });

  return {
    tools: filtered,
    allowedTools: [...allowed].filter((id) => existingIds.has(id)),
    disallowedTools: [...disallowed],
    blockedTools: [...new Set(blockedTools)].sort(),
  };
}

function unionSkillTools(
  skills: Array<Pick<SkillDefinition, 'allowedTools' | 'disallowedTools'>>,
  key: 'allowedTools' | 'disallowedTools',
): Set<string> {
  const out = new Set<string>();
  for (const skill of skills) {
    for (const id of skill[key] ?? []) {
      const normalized = id.trim();
      if (normalized) out.add(normalized);
    }
  }
  return out;
}

function toolId(tool: string | ToolDescriptor): string {
  return typeof tool === 'string' ? tool : tool.id;
}

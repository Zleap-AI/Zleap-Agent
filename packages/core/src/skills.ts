import type { SkillDefinitionRecord } from './records.js';
import type { SkillDefinition, SkillSectionIndex, SkillSensitivityAudit, SkillSensitivityFinding } from './types.js';

const DEFAULT_SKILL_TOKEN_BUDGET = 450;
const MAX_SKILL_TOKEN_BUDGET = 32_000;

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  register(definition: SkillDefinition): void {
    this.skills.set(definition.id, definition);
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  search(input: { query: string; limit?: number }): SkillDefinition[] {
    return searchSkillManifests(this.list(), input);
  }
}

export function skillDefinitionFromRecord(record: SkillDefinitionRecord): SkillDefinition {
  const instructions = record.body ?? record.instructions ?? '';
  const metadata = record.metadata ?? {};
  const riskAudit = record.riskAudit ?? normalizeRiskAudit(metadata.riskAudit);
  const sensitivity = riskAudit ? riskAuditToSensitivity(riskAudit) : auditSkillSensitivity(instructions);
  const sections = indexSkillSections(instructions);
  const tokenBudget = skillTokenBudget(record.metadata);
  return {
    id: record.id,
    version: record.version,
    procedureId: skillProcedureId(record.id, record.version),
    label: record.label,
    description: record.description,
    instructions,
    toolIds: record.toolIds,
    sections,
    lifecycle: 'long_term',
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    sensitivity,
    source: {
      type: record.sourceType ?? normalizeSourceType(metadata.sourceType) ?? 'db',
      sourcePath: record.sourcePath,
      packageRoot: record.packageRoot,
      sourceName: record.sourceName,
    },
    frontmatter: record.frontmatter,
    body: record.body,
    files: record.files,
    openaiConfig: record.openaiConfig,
    claudeConfig: record.claudeConfig,
    allowedTools: record.allowedTools,
    disallowedTools: record.disallowedTools,
    invocationPolicy: record.invocationPolicy ?? normalizeInvocationPolicy(metadata.invocationPolicy),
    trustStatus: record.trustStatus ?? normalizeTrustStatus(metadata.trustStatus),
    riskAudit,
    schemaHash: record.schemaHash,
  };
}

export function buildSkillMemoryMetadata(input: {
  id: string;
  version: number;
  instructions?: string;
  tokenBudget?: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const instructions = input.instructions ?? '';
  return {
    ...(input.metadata ?? {}),
    kind: 'skill_memory',
    lifecycle: 'long_term',
    procedureId: skillProcedureId(input.id, input.version),
    tokenBudget: normalizeSkillTokenBudget(input.tokenBudget),
    sections: indexSkillSections(instructions),
    sensitivity: auditSkillSensitivity(instructions),
  };
}

export function skillProcedureId(id: string, version: number | undefined): string {
  return `skill:${id}@${version ?? 'latest'}`;
}

export function searchSkillManifests(
  skills: SkillDefinition[],
  input: { query: string; limit?: number },
): SkillDefinition[] {
  const terms = skillSearchTerms(input.query);
  if (terms.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(input.limit ?? 3, 10));
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, limit)
    .map((item) => item.skill);
}

function skillSearchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+/gi)) {
    const term = match[0].trim();
    if (term.length >= 2) terms.add(term);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const term = match[0].trim();
    if (term.length >= 2) {
      terms.add(term);
      for (let i = 0; i < term.length - 1; i += 1) {
        terms.add(term.slice(i, i + 2));
      }
    }
  }
  return [...terms];
}

export function indexSkillSections(instructions: string): SkillSectionIndex[] {
  const sections: SkillSectionIndex[] = [];
  let lineStart = 0;
  let inFence = false;
  while (lineStart <= instructions.length) {
    const newline = instructions.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? instructions.length : newline;
    const line = instructions.slice(lineStart, lineEnd);
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = /^( {0,3})(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (match) {
        const title = match[3]!.replace(/\s+#+\s*$/, '').trim();
        if (title) {
          sections.push({ id: slugifySkillSection(title), title, level: match[2]!.length });
        }
      }
    }
    if (newline === -1) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return sections;
}

export function auditSkillSensitivity(instructions: string): SkillSensitivityAudit {
  const findings: SkillSensitivityFinding[] = [];
  const checks: Array<{ kind: SkillSensitivityFinding['kind']; severity: SkillSensitivityFinding['severity']; pattern: RegExp }> = [
    { kind: 'private_key', severity: 'high', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { kind: 'credential_url', severity: 'high', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/gi },
    { kind: 'secret_like', severity: 'medium', pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi },
  ];
  for (const check of checks) {
    const count = [...instructions.matchAll(check.pattern)].length;
    if (count > 0) {
      findings.push({ kind: check.kind, severity: check.severity, count });
    }
  }
  return { status: findings.length > 0 ? 'review' : 'clear', findings };
}

export function normalizeSkillTokenBudget(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(50, Math.min(MAX_SKILL_TOKEN_BUDGET, Math.floor(value)))
    : DEFAULT_SKILL_TOKEN_BUDGET;
}

function skillTokenBudget(metadata: Record<string, unknown> | undefined): number | undefined {
  return typeof metadata?.tokenBudget === 'number' && Number.isFinite(metadata.tokenBudget)
    ? normalizeSkillTokenBudget(metadata.tokenBudget)
    : undefined;
}

function scoreSkill(skill: SkillDefinition, terms: string[]): number {
  const haystack = [
    skill.id,
    skill.procedureId,
    skill.label,
    skill.description,
    ...(skill.toolIds ?? []),
    ...(skill.allowedTools ?? []),
    ...(skill.disallowedTools ?? []),
    ...(skill.sections ?? []).map((section) => section.title),
    ...(skill.files ?? []).map((file) => file.path),
    skill.source?.sourceName,
    skill.source?.type,
    skill.invocationPolicy,
    skill.trustStatus,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function slugifySkillSection(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function normalizeSourceType(value: unknown): NonNullable<SkillDefinition['source']>['type'] | undefined {
  return value === 'db' || value === 'project' || value === 'user' || value === 'admin' || value === 'system' || value === 'imported'
    ? value
    : undefined;
}

function normalizeInvocationPolicy(value: unknown): SkillDefinition['invocationPolicy'] | undefined {
  return value === 'implicit' || value === 'explicit_only' || value === 'disabled' ? value : undefined;
}

function normalizeTrustStatus(value: unknown): SkillDefinition['trustStatus'] | undefined {
  return value === 'trusted' || value === 'review_required' || value === 'blocked' ? value : undefined;
}

function normalizeRiskAudit(value: unknown): SkillDefinition['riskAudit'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const audit = value as NonNullable<SkillDefinition['riskAudit']>;
  if (!normalizeTrustStatus(audit.status) || !Array.isArray(audit.findings)) return undefined;
  return audit;
}

function riskAuditToSensitivity(riskAudit: NonNullable<SkillDefinition['riskAudit']>): SkillSensitivityAudit {
  return {
    status: riskAudit.findings.some((finding) => finding.severity === 'medium' || finding.severity === 'high') ? 'review' : 'clear',
    findings: riskAudit.findings
      .filter((finding): finding is typeof finding & { kind: SkillSensitivityFinding['kind']; severity: SkillSensitivityFinding['severity'] } =>
        (finding.kind === 'secret_like' || finding.kind === 'private_key' || finding.kind === 'credential_url') &&
        (finding.severity === 'medium' || finding.severity === 'high'),
      )
      .map((finding) => ({ kind: finding.kind, severity: finding.severity, count: finding.count })),
  };
}

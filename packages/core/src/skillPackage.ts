import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CapabilityOrigin, SkillDefinitionRecord } from './records.js';
import type {
  SkillFrontmatter,
  SkillInvocationPolicy,
  SkillPackageFile,
  SkillRiskAudit,
  SkillRiskFinding,
  SkillSourceType,
  SkillTrustStatus,
} from './types.js';
import { auditSkillSensitivity } from './skills.js';

const SKILL_MD = 'SKILL.md';
const OPENAI_CONFIG_PATH = 'agents/openai.yaml';

const CLAUDE_FRONTMATTER_KEYS = [
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'hooks',
  'paths',
  'shell',
] as const;

export type ParseSkillPackageInput = {
  root: string;
  skillMd: string;
  sourceType?: SkillSourceType;
  sourcePath?: string;
  files?: SkillPackageFile[];
  openaiYaml?: string;
  trustStatus?: SkillTrustStatus;
};

export type SkillPackageManifest = {
  id: string;
  sourceName: string;
  label: string;
  description: string;
  root: string;
  sourcePath?: string;
  skillMdPath: string;
  frontmatter: SkillFrontmatter;
  body: string;
  files: SkillPackageFile[];
  openaiConfig?: Record<string, unknown>;
  claudeConfig?: Record<string, unknown>;
  license?: string;
  compatibility?: unknown;
  allowedTools: string[];
  disallowedTools: string[];
  invocationPolicy: SkillInvocationPolicy;
  trustStatus: SkillTrustStatus;
  riskAudit: SkillRiskAudit;
  schemaHash: string;
};

export class SkillPackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SkillPackageError';
  }
}

export function parseSkillPackage(input: ParseSkillPackageInput): SkillPackageManifest {
  const root = input.root.trim();
  if (!root) {
    throw new SkillPackageError('skill_root_required', 'Skill package root is required.');
  }
  const { frontmatter, body } = splitSkillFrontmatter(input.skillMd);
  const sourceName = requireFrontmatterString(frontmatter, 'name');
  const description = requireFrontmatterString(frontmatter, 'description');
  const id = normalizeSkillId(sourceName || basename(root));
  if (!id) {
    throw new SkillPackageError('skill_name_invalid', `Skill name is not usable as an id: ${sourceName}`);
  }
  const files = normalizeFiles(input.files, input.skillMd, input.openaiYaml);
  const openaiConfig = input.openaiYaml ? parseYamlObject(input.openaiYaml, OPENAI_CONFIG_PATH) : undefined;
  const claudeConfig = extractClaudeConfig(frontmatter);
  const allowedTools = uniqueStrings([
    ...normalizeStringArray(frontmatter['allowed-tools']),
    ...normalizeStringArray(openaiConfig?.allowed_tools),
    ...normalizeStringArray(openaiConfig?.allowedTools),
  ]);
  const disallowedTools = uniqueStrings([
    ...normalizeStringArray(frontmatter['disallowed-tools']),
    ...normalizeStringArray(openaiConfig?.disallowed_tools),
    ...normalizeStringArray(openaiConfig?.disallowedTools),
  ]);
  const riskAudit = auditSkillPackageRisk({ skillMd: input.skillMd, frontmatter, files });
  const inferredTrust = input.trustStatus ?? inferTrustStatus(input.sourceType, riskAudit);
  const schemaHash = hashSkillPackage({
    skillMd: input.skillMd,
    openaiYaml: input.openaiYaml,
    files,
  });

  return {
    id,
    sourceName,
    label: sourceName,
    description,
    root,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    skillMdPath: join(root, SKILL_MD),
    frontmatter,
    body,
    files,
    ...(openaiConfig ? { openaiConfig } : {}),
    ...(Object.keys(claudeConfig).length ? { claudeConfig } : {}),
    ...(typeof frontmatter.license === 'string' ? { license: frontmatter.license } : {}),
    ...(frontmatter.compatibility !== undefined ? { compatibility: frontmatter.compatibility } : {}),
    allowedTools,
    disallowedTools,
    invocationPolicy: inferInvocationPolicy(frontmatter, openaiConfig),
    trustStatus: inferredTrust,
    riskAudit: { ...riskAudit, status: inferredTrust },
    schemaHash,
  };
}

export function skillRecordFromPackageManifest(
  manifest: SkillPackageManifest,
  input: { origin?: CapabilityOrigin; version?: number; createdAt?: Date; sourceType?: SkillSourceType } = {},
): SkillDefinitionRecord {
  const now = input.createdAt ?? new Date();
  return {
    id: manifest.id,
    version: input.version ?? 1,
    origin: input.origin ?? 'user',
    label: manifest.label,
    description: manifest.description,
    instructions: manifest.body,
    toolIds: manifest.allowedTools,
    metadata: { kind: 'skill_package', sourceName: manifest.sourceName },
    sourceType: input.sourceType ?? 'imported',
    sourcePath: manifest.sourcePath,
    packageRoot: manifest.root,
    sourceName: manifest.sourceName,
    frontmatter: manifest.frontmatter,
    body: manifest.body,
    files: manifest.files,
    openaiConfig: manifest.openaiConfig,
    claudeConfig: manifest.claudeConfig,
    license: manifest.license,
    compatibility: manifest.compatibility,
    allowedTools: manifest.allowedTools,
    disallowedTools: manifest.disallowedTools,
    invocationPolicy: manifest.invocationPolicy,
    trustStatus: manifest.trustStatus,
    riskAudit: manifest.riskAudit,
    schemaHash: manifest.schemaHash,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeSkillId(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

function splitSkillFrontmatter(markdown: string): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new SkillPackageError('skill_frontmatter_required', 'SKILL.md must start with YAML frontmatter.');
  }
  const parsed = parseYamlObject(match[1]!, 'SKILL.md frontmatter');
  return { frontmatter: parsed as SkillFrontmatter, body: match[2] ?? '' };
}

function parseYamlObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new SkillPackageError('skill_yaml_invalid', `${label} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new SkillPackageError('skill_yaml_object_required', `${label} must be a YAML object.`);
  }
  return parsed;
}

function requireFrontmatterString(frontmatter: Record<string, unknown>, key: string): string {
  const value = frontmatter[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillPackageError(`skill_${key}_required`, `SKILL.md frontmatter must include a non-empty ${key}.`);
  }
  return value.trim();
}

function extractClaudeConfig(frontmatter: SkillFrontmatter): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of CLAUDE_FRONTMATTER_KEYS) {
    if (frontmatter[key] !== undefined) {
      config[key] = frontmatter[key];
    }
  }
  return config;
}

function inferInvocationPolicy(frontmatter: SkillFrontmatter, openaiConfig: Record<string, unknown> | undefined): SkillInvocationPolicy {
  if (frontmatter.metadata && typeof frontmatter.metadata.invocationPolicy === 'string') {
    const policy = frontmatter.metadata.invocationPolicy;
    if (policy === 'implicit' || policy === 'explicit_only' || policy === 'disabled') {
      return policy;
    }
  }
  if (frontmatter['disable-model-invocation'] === true || openaiConfig?.allow_implicit_invocation === false) {
    return 'explicit_only';
  }
  if (frontmatter['user-invocable'] === false && frontmatter['disable-model-invocation'] === true) {
    return 'disabled';
  }
  return 'implicit';
}

function normalizeFiles(files: SkillPackageFile[] | undefined, skillMd: string, openaiYaml: string | undefined): SkillPackageFile[] {
  const seen = new Set<string>();
  const out: SkillPackageFile[] = [];
  const push = (file: SkillPackageFile) => {
    const path = normalizeRelativePath(file.path);
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ ...file, path, kind: file.kind ?? inferFileKind(path) });
  };
  push({
    path: SKILL_MD,
    kind: 'skill',
    size: Buffer.byteLength(skillMd),
    sha256: sha256(skillMd),
  });
  if (openaiYaml) {
    push({
      path: OPENAI_CONFIG_PATH,
      kind: 'config',
      size: Buffer.byteLength(openaiYaml),
      sha256: sha256(openaiYaml),
    });
  }
  for (const file of files ?? []) {
    push(file);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function inferFileKind(path: string): SkillPackageFile['kind'] {
  if (path === SKILL_MD) return 'skill';
  if (path === OPENAI_CONFIG_PATH || path.startsWith('agents/')) return 'config';
  if (path.startsWith('scripts/')) return 'script';
  if (path.startsWith('references/')) return 'reference';
  if (path.startsWith('assets/')) return 'asset';
  return 'other';
}

function normalizeRelativePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized.includes('../') || normalized.startsWith('..')) {
    return undefined;
  }
  return normalized;
}

function auditSkillPackageRisk(input: {
  skillMd: string;
  frontmatter: SkillFrontmatter;
  files: SkillPackageFile[];
}): SkillRiskAudit {
  const findings: SkillRiskFinding[] = [];
  const sensitivity = auditSkillSensitivity(input.skillMd);
  for (const finding of sensitivity.findings) {
    findings.push({ kind: finding.kind, severity: finding.severity, count: finding.count });
  }
  const shellCount =
    (typeof input.frontmatter.shell === 'string' || Array.isArray(input.frontmatter.shell) ? 1 : 0) +
    [...input.skillMd.matchAll(/^\s*!\s*\S+/gm)].length;
  if (shellCount > 0) {
    findings.push({
      kind: 'shell_preprocessing',
      severity: 'high',
      count: shellCount,
      message: 'Skill declares shell preprocessing; Zleap keeps it disabled until trusted.',
    });
  }
  const executableScripts = input.files.filter((file) => file.kind === 'script' && (file.executable || /\.(sh|bash|zsh|py|js|mjs|ts)$/.test(file.path))).length;
  if (executableScripts > 0) {
    findings.push({ kind: 'executable_script', severity: 'medium', count: executableScripts });
  }
  const networkReferences = [...input.skillMd.matchAll(/\bhttps?:\/\//gi)].length;
  if (networkReferences > 0) {
    findings.push({ kind: 'network_reference', severity: 'low', count: networkReferences });
  }
  const largeFiles = input.files.filter((file) => file.size > 1_000_000).length;
  if (largeFiles > 0) {
    findings.push({ kind: 'large_file', severity: 'medium', count: largeFiles });
  }
  const status: SkillTrustStatus = findings.length > 0 ? 'review_required' : 'trusted';
  return { status, findings };
}

function inferTrustStatus(sourceType: SkillSourceType | undefined, riskAudit: SkillRiskAudit): SkillTrustStatus {
  if (riskAudit.findings.some((finding) => finding.kind === 'path_escape' && finding.severity === 'high')) {
    return 'blocked';
  }
  if (sourceType === 'imported') {
    return 'review_required';
  }
  return riskAudit.status;
}

function hashSkillPackage(input: { skillMd: string; openaiYaml?: string; files: SkillPackageFile[] }): string {
  return sha256(JSON.stringify({
    skillMd: input.skillMd,
    openaiYaml: input.openaiYaml,
    files: input.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
  }));
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

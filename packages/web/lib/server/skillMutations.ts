import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { SkillDefinitionRecord, SkillInvocationPolicy, SkillSourceType, SkillTrustStatus } from '@zleap/core';
import { parseSkillPackage, skillRecordFromPackageManifest } from '@zleap/core/skill-package';
import { listSkillPackageFiles } from '@zleap/core/skill-sources';
import type { ZleapStore } from '@zleap/store';
import { ensureAvatar, saveSkillRecord } from './avatarContext';

export type ImportSkillPackageInput = {
  root?: string;
  skillMd?: string;
  openaiYaml?: string;
  sourceType?: SkillSourceType;
  trustStatus?: SkillTrustStatus;
  bindToSpaceId?: string;
  avatarId?: string;
};

export type UpdateSkillInput = {
  id?: string;
  version?: number;
  label?: string;
  description?: string;
  instructions?: string;
  toolIds?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  invocationPolicy?: SkillInvocationPolicy;
  trustStatus?: SkillTrustStatus;
  bindToSpaceId?: string;
};

export async function importSkillPackage(store: ZleapStore, input: ImportSkillPackageInput): Promise<SkillDefinitionRecord> {
  await ensureAvatar(store, input.avatarId);
  const sourceType = normalizeSourceType(input.sourceType) ?? 'imported';
  const trustStatus = normalizeTrustStatus(input.trustStatus);
  const root = input.root?.trim();

  if (root) {
    const packageRoot = resolve(root);
    const skillMd = await readFile(join(packageRoot, 'SKILL.md'), 'utf8');
    const openaiYaml = await readOptionalUtf8(join(packageRoot, 'agents', 'openai.yaml'));
    const files = await listSkillPackageFiles(packageRoot);
    const manifest = parseSkillPackage({
      root: packageRoot,
      sourcePath: packageRoot,
      sourceType,
      skillMd,
      openaiYaml,
      files,
      trustStatus,
    });
    return saveSkillRecord(store, skillRecordFromPackageManifest(manifest, { origin: 'user', sourceType }), input.bindToSpaceId);
  }

  if (!input.skillMd?.trim()) {
    throw new Error('skill_package_required');
  }

  const manifest = parseSkillPackage({
    root: 'inline-skill',
    sourceType,
    skillMd: input.skillMd,
    openaiYaml: input.openaiYaml,
    trustStatus,
  });
  return saveSkillRecord(store, skillRecordFromPackageManifest(manifest, { origin: 'user', sourceType }), input.bindToSpaceId);
}

export async function updateSkillRecord(store: ZleapStore, input: UpdateSkillInput): Promise<SkillDefinitionRecord> {
  const id = input.id?.trim();
  if (!id) {
    throw new Error('id_required');
  }
  const existing = await store.skills.getSkill(id, input.version);
  if (!existing) {
    throw new Error('skill_not_found');
  }
  const now = new Date();
  const record: SkillDefinitionRecord = {
    ...existing,
    label: input.label?.trim() || existing.label,
    description: input.description === undefined ? existing.description : input.description.trim() || undefined,
    instructions: input.instructions === undefined ? existing.instructions : input.instructions,
    body: input.instructions === undefined ? existing.body : input.instructions,
    toolIds: Array.isArray(input.toolIds) ? cleanStringArray(input.toolIds) : existing.toolIds,
    allowedTools: Array.isArray(input.allowedTools) ? cleanStringArray(input.allowedTools) : existing.allowedTools,
    disallowedTools: Array.isArray(input.disallowedTools) ? cleanStringArray(input.disallowedTools) : existing.disallowedTools,
    invocationPolicy: normalizeInvocationPolicy(input.invocationPolicy) ?? existing.invocationPolicy,
    trustStatus: normalizeTrustStatus(input.trustStatus) ?? existing.trustStatus,
    updatedAt: now,
  };
  return saveSkillRecord(store, record, input.bindToSpaceId);
}

export async function deleteSkillRecord(store: ZleapStore, id: string | undefined, version?: number): Promise<void> {
  const cleanId = id?.trim();
  if (!cleanId) {
    throw new Error('id_required');
  }
  const existing = await store.skills.getSkill(cleanId, version);
  if (!existing) {
    throw new Error('skill_not_found');
  }
  await store.skills.deleteSkill(cleanId, version);
}

export async function readSkillPackageTextFile(skill: SkillDefinitionRecord, path: string | undefined): Promise<{ path: string; content: string }> {
  const packageRoot = skill.packageRoot?.trim();
  const relativePath = normalizeSkillRelativePath(path);
  if (!packageRoot) {
    throw new Error('skill_package_root_required');
  }
  if (!relativePath) {
    throw new Error('skill_file_path_required');
  }
  const file = skill.files?.find((entry) => entry.path === relativePath);
  if (file?.kind === 'asset') {
    throw new Error('skill_file_not_text_readable');
  }
  const root = resolve(packageRoot);
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error('skill_file_path_forbidden');
  }
  return { path: relativePath, content: await readFile(absolute, 'utf8') };
}

export async function writeSkillPackageTextFile(
  store: ZleapStore,
  skill: SkillDefinitionRecord,
  path: string | undefined,
  content: string,
): Promise<{ path: string; content: string; skill: SkillDefinitionRecord }> {
  const packageRoot = skill.packageRoot?.trim();
  const relativePath = normalizeSkillRelativePath(path);
  if (!packageRoot) {
    throw new Error('skill_package_root_required');
  }
  if (!relativePath) {
    throw new Error('skill_file_path_required');
  }
  const file = skill.files?.find((entry) => entry.path === relativePath);
  if (file?.kind === 'asset') {
    throw new Error('skill_file_not_text_writable');
  }
  const root = resolve(packageRoot);
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error('skill_file_path_forbidden');
  }
  await writeFile(absolute, content, 'utf8');
  const files = await listSkillPackageFiles(root);
  const now = new Date();
  const record: SkillDefinitionRecord = {
    ...skill,
    files,
    updatedAt: now,
    ...(relativePath === 'SKILL.md' ? { body: content, instructions: content } : {}),
  };
  const saved = await saveSkillRecord(store, record);
  return { path: relativePath, content, skill: saved };
}

export function normalizeSourceType(value: unknown): SkillSourceType | undefined {
  return value === 'db' || value === 'project' || value === 'user' || value === 'admin' || value === 'system' || value === 'imported'
    ? value
    : undefined;
}

export function normalizeTrustStatus(value: unknown): SkillTrustStatus | undefined {
  return value === 'trusted' || value === 'review_required' || value === 'blocked' ? value : undefined;
}

export function normalizeInvocationPolicy(value: unknown): SkillInvocationPolicy | undefined {
  return value === 'implicit' || value === 'explicit_only' || value === 'disabled' ? value : undefined;
}

function cleanStringArray(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function normalizeSkillRelativePath(path: string | undefined): string | undefined {
  const normalized = path?.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.includes('../') || normalized.startsWith('..')) {
    return undefined;
  }
  return normalized;
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

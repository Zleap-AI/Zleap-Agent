import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { SkillPackageFile, SkillSourceType, SkillTrustStatus } from './types.js';
import { parseSkillPackage, SkillPackageError, type SkillPackageManifest } from './skillPackage.js';

const SKILL_MD = 'SKILL.md';
const OPENAI_CONFIG_PATH = 'agents/openai.yaml';
const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_FILE_BYTES = 5_000_000;

export type SkillSourceRoot = {
  root: string;
  sourceType: SkillSourceType;
};

export type SkillScanOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
  trustStatus?: SkillTrustStatus;
};

export type SkillScanResult =
  | { ok: true; manifest: SkillPackageManifest }
  | { ok: false; root: string; error: { code: string; message: string } };

export function defaultZleapSkillsRoot(homeDir: string = homedir()): string {
  return join(homeDir, 'Documents', 'Zleap', 'skills');
}

export function defaultSkillSourceRoots(input: {
  projectRoot?: string;
  homeDir?: string;
  includeAdmin?: boolean;
  zleapSkillsRoot?: string;
} = {}): SkillSourceRoot[] {
  const roots: SkillSourceRoot[] = [];
  const home = input.homeDir ?? homedir();
  if (input.projectRoot) {
    roots.push(
      { root: join(input.projectRoot, '.agents', 'skills'), sourceType: 'project' },
      { root: join(input.projectRoot, '.claude', 'skills'), sourceType: 'project' },
    );
  }
  roots.push(
    { root: join(home, '.agents', 'skills'), sourceType: 'user' },
    { root: input.zleapSkillsRoot ?? defaultZleapSkillsRoot(home), sourceType: 'user' },
  );
  if (input.includeAdmin) {
    roots.push({ root: '/etc/zleap/skills', sourceType: 'admin' });
  }
  return dedupeRoots(roots);
}

export async function scanSkillSourceRoot(root: SkillSourceRoot, options: SkillScanOptions = {}): Promise<SkillScanResult[]> {
  const resolvedRoot = resolve(root.root);
  const rootPackage = await tryReadSkillPackage(resolvedRoot, root.sourceType, options);
  if (rootPackage) return [rootPackage];

  let entries: Awaited<ReturnType<typeof readDirents>>;
  try {
    entries = await readDirents(resolvedRoot);
  } catch (error) {
    if (isNotFound(error)) return [];
    return [{ ok: false, root: resolvedRoot, error: { code: 'skill_source_unreadable', message: errorMessage(error) } }];
  }

  const results: SkillScanResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const packageRoot = resolve(resolvedRoot, entry.name);
    if (!isWithin(resolvedRoot, packageRoot)) {
      results.push({ ok: false, root: packageRoot, error: { code: 'skill_package_root_escape', message: 'Skill package root escapes source root.' } });
      continue;
    }
    const result = await readSkillPackage(packageRoot, root.sourceType, options);
    results.push(result);
  }
  return results;
}

function readDirents(root: string) {
  return readdir(root, { withFileTypes: true, encoding: 'utf8' });
}

async function tryReadSkillPackage(packageRoot: string, sourceType: SkillSourceType, options: SkillScanOptions): Promise<SkillScanResult | null> {
  let skillMd: string;
  try {
    skillMd = await readFile(join(packageRoot, SKILL_MD), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    return skillPackageError(packageRoot, error);
  }
  return readSkillPackage(packageRoot, sourceType, options, skillMd);
}

async function readSkillPackage(packageRoot: string, sourceType: SkillSourceType, options: SkillScanOptions, preloadedSkillMd?: string): Promise<SkillScanResult> {
  try {
    const skillMd = preloadedSkillMd ?? await readFile(join(packageRoot, SKILL_MD), 'utf8');
    const openaiYaml = await readOptionalUtf8(join(packageRoot, OPENAI_CONFIG_PATH));
    const files = await listSkillPackageFiles(packageRoot, options);
    const manifest = parseSkillPackage({
      root: packageRoot,
      sourcePath: packageRoot,
      sourceType,
      skillMd,
      openaiYaml,
      files,
      trustStatus: options.trustStatus,
    });
    return { ok: true, manifest };
  } catch (error) {
    return skillPackageError(packageRoot, error);
  }
}

function skillPackageError(packageRoot: string, error: unknown): SkillScanResult {
  return {
    ok: false,
    root: packageRoot,
    error: {
      code: error instanceof SkillPackageError ? error.code : 'skill_package_scan_failed',
      message: errorMessage(error),
    },
  };
}

export async function listSkillPackageFiles(root: string, options: SkillScanOptions = {}): Promise<SkillPackageFile[]> {
  const packageRoot = resolve(root);
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, 5_000));
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const files: SkillPackageFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = resolve(dir, entry.name);
      if (!isWithin(packageRoot, fullPath)) {
        files.push({ path: relative(packageRoot, fullPath), kind: 'other', size: 0 });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = normalizeRelativePath(relative(packageRoot, fullPath));
      if (!relativePath) continue;
      const info = await stat(fullPath);
      const file: SkillPackageFile = {
        path: relativePath,
        kind: inferFileKind(relativePath),
        size: info.size,
        executable: Boolean(info.mode & 0o111),
      };
      if (info.size <= maxFileBytes) {
        const bytes = await readFile(fullPath);
        file.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
      files.push(file);
    }
  }

  await walk(packageRoot);
  return files;
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
  if (!normalized || normalized.includes('../') || normalized.startsWith('..')) {
    return undefined;
  }
  return normalized;
}

function dedupeRoots(roots: SkillSourceRoot[]): SkillSourceRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = `${root.sourceType}:${resolve(root.root)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isWithin(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

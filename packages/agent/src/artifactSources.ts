import type { WorkspaceResultArtifact } from '@zleap/core';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

export type ArtifactSourceKind = 'generated' | 'imported' | 'neutral';
export type ArtifactSnapshot = Map<string, { size: number; mtimeMs: number }>;
export type ArtifactCandidate = {
  kind: 'file';
  ref: string;
  description: string;
  source: 'generated' | 'imported';
  toolName: string;
};

export type ArtifactRegistryItem = {
  path: string;
  title?: string;
  kind?: string;
  source?: 'generated' | 'explicit' | 'imported';
  createdAt?: string;
};

export const ARTIFACT_REGISTRY_PATH = '.zleap/artifacts.json';

const GENERATED_FILE_TOOLS = new Set(['write', 'edit', 'append', 'write_file', 'edit_file']);
const ARTIFACT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.pdf', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const SCAN_EXCLUDES = new Set(['.git', '.next', '.zleap', 'build', 'dist', 'node_modules']);
const IMPORT_COMMAND_RE = /\b(?:git\s+clone|gh\s+repo\s+clone|curl\b|wget\b|unzip\b|tar\s+(?:-[A-Za-z]*x[A-Za-z]*|x[A-Za-z]*|--extract)|bsdtar\b|7z\s+x|python(?:3)?\s+-m\s+zipfile\s+-e)\b/i;
const GENERATED_BASH_RE = /\b(?:python(?:3)?|node|pnpm|npm|bun|deno|make|printf)\b|>>?/i;

export function classifyArtifactSource(toolName: string, input: unknown): ArtifactSourceKind {
  if (GENERATED_FILE_TOOLS.has(toolName)) return 'generated';
  if (toolName !== 'bash') return 'neutral';
  const command = parseBashCommand(input);
  if (!command) return 'neutral';
  if (IMPORT_COMMAND_RE.test(command)) return 'imported';
  if (GENERATED_BASH_RE.test(command)) return 'generated';
  return 'neutral';
}

export function parseBashCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function parseToolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).path;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function scanArtifactFiles(workspaceRoot: string): Promise<ArtifactSnapshot> {
  const snapshot: ArtifactSnapshot = new Map();
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    if (visited >= 5_000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= 5_000) return;
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDES.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const file = join(dir, entry.name);
      if (!isArtifactLikeFile(file, workspaceRoot)) continue;
      try {
        const info = await stat(file);
        snapshot.set(file, { size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // File changed between readdir and stat; ignore this scan race.
      }
    }
  };
  await walk(workspaceRoot);
  return snapshot;
}

export function isArtifactLikeFile(path: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, path);
  if (!rel || rel.startsWith('..')) return false;
  return ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase());
}

export function diffArtifactSnapshots(before: ArtifactSnapshot, after: ArtifactSnapshot): string[] {
  const changed: string[] = [];
  for (const [file, info] of after) {
    const previous = before.get(file);
    if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
      changed.push(file);
    }
  }
  return changed;
}

export function candidatesFromChangedFiles(files: string[], source: 'generated' | 'imported', toolName: string): ArtifactCandidate[] {
  return files.map((file) => ({
    kind: 'file',
    ref: file,
    description: basename(file),
    source,
    toolName,
  }));
}

export async function writeArtifactRegistry(workspaceRoot: string | undefined, artifacts: WorkspaceResultArtifact[]): Promise<void> {
  if (!workspaceRoot) return;
  const generated = artifacts.filter((item) => item.source !== 'imported' && item.ref && !/^https?:\/\//i.test(item.ref));
  if (!generated.length) return;

  const registryFile = join(workspaceRoot, ARTIFACT_REGISTRY_PATH);
  const existing = await readArtifactRegistryFile(registryFile);
  const byPath = new Map(existing.map((item) => [item.path, item]));
  const now = new Date().toISOString();
  for (const item of generated) {
    byPath.set(item.ref, {
      path: item.ref,
      title: item.description ?? basename(item.ref),
      kind: item.kind,
      source: item.source ?? 'generated',
      createdAt: byPath.get(item.ref)?.createdAt ?? now,
    });
  }

  await mkdir(join(workspaceRoot, '.zleap'), { recursive: true });
  await writeFile(registryFile, `${JSON.stringify([...byPath.values()], null, 2)}\n`, 'utf8');
}

async function readArtifactRegistryFile(path: string): Promise<ArtifactRegistryItem[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ArtifactRegistryItem[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const pathValue = typeof record.path === 'string' ? record.path.trim() : '';
      if (!pathValue) return [];
      const source = record.source === 'generated' || record.source === 'explicit' || record.source === 'imported'
        ? record.source
        : undefined;
      return [{
        path: pathValue,
        ...(typeof record.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
        ...(typeof record.kind === 'string' && record.kind.trim() ? { kind: record.kind.trim() } : {}),
        ...(source ? { source } : {}),
        ...(typeof record.createdAt === 'string' && record.createdAt.trim() ? { createdAt: record.createdAt.trim() } : {}),
      }];
    });
  } catch {
    return [];
  }
}

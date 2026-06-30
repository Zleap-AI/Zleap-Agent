import { DEFAULT_FILE_WORKSPACE_ROOT } from '@zleap/core';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const ARTIFACT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.pdf', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const SKIP_FILENAMES = new Set(['agents.md', 'readme.md', 'package.json', 'pnpm-lock.yaml', 'components.json', 'skills-lock.json']);
const OUTPUT_SUBDIRS = new Set(['outputs', 'artifacts', 'deliverables']);
const CONVERSATION_DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type GalleryArtifactItem = {
  id: string;
  title?: string;
  summary?: string;
  kind?: string;
  status?: string;
  contentUri?: string;
  createdAt?: string;
};

type ScannedFile = { path: string; mtimeMs: number };

/** Scan agent-produced files in conversation workspaces for the artifact gallery. */
export async function listWorkspaceFileArtifacts(limit = 150): Promise<GalleryArtifactItem[]> {
  const root = resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT);
  const files: ScannedFile[] = [];
  await collectConversationOutputs(root, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.slice(0, limit).map((file) => {
    const name = basename(file.path);
    const ext = extname(name).toLowerCase();
    return {
      id: `file:${file.path}`,
      title: name,
      summary: file.path,
      kind: ext.replace(/^\./, '') || 'file',
      status: 'local',
      contentUri: `file://${file.path}`,
      createdAt: new Date(file.mtimeMs).toISOString(),
    };
  });
}

async function collectConversationOutputs(baseRoot: string, out: ScannedFile[]): Promise<void> {
  let dateEntries;
  try {
    dateEntries = await readdir(baseRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory() || dateEntry.name.startsWith('.') || !CONVERSATION_DATE_DIR_PATTERN.test(dateEntry.name)) continue;
    const datePath = join(baseRoot, dateEntry.name);
    let convEntries;
    try {
      convEntries = await readdir(datePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const convEntry of convEntries) {
      if (!convEntry.isDirectory() || convEntry.name.startsWith('.')) continue;
      const convPath = join(datePath, convEntry.name);
      await collectFilesInDir(convPath, out, false);
      for (const sub of OUTPUT_SUBDIRS) {
        await collectFilesInDir(join(convPath, sub), out, true);
      }
    }
  }
}

async function collectFilesInDir(dir: string, out: ScannedFile[], recursive: boolean): Promise<void> {
  if (out.length > 500) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await collectFilesInDir(full, out, true);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!ARTIFACT_EXTENSIONS.has(ext)) continue;
    if (SKIP_FILENAMES.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('tsconfig')) continue;
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    out.push({ path: full, mtimeMs: info.mtimeMs });
  }
}

export function mergeGalleryArtifacts(
  durable: GalleryArtifactItem[],
  workspaceFiles: GalleryArtifactItem[],
): GalleryArtifactItem[] {
  const seen = new Set<string>();
  const merged: GalleryArtifactItem[] = [];
  for (const item of [...durable, ...workspaceFiles]) {
    const key = item.contentUri ?? item.summary ?? item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

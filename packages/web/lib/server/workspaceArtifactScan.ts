import { DEFAULT_FILE_WORKSPACE_ROOT } from '@zleap/core';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const ARTIFACT_REGISTRY = join('.zleap', 'artifacts.json');
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

type RegisteredFile = { path: string; title?: string; kind?: string; createdAt?: string };
type ArtifactRegistryItem = {
  path?: unknown;
  title?: unknown;
  kind?: unknown;
  source?: unknown;
  createdAt?: unknown;
};

/** Read agent-produced files registered by runtime in conversation workspaces. */
export async function listWorkspaceFileArtifacts(limit = 150): Promise<GalleryArtifactItem[]> {
  const root = resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT);
  const files: RegisteredFile[] = [];
  await collectConversationRegistries(root, files);
  files.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));

  return files.slice(0, limit).map((file) => {
    const name = file.title || basename(file.path);
    const ext = extname(name).toLowerCase();
    return {
      id: `file:${file.path}`,
      title: name,
      summary: file.path,
      kind: file.kind || ext.replace(/^\./, '') || 'file',
      status: 'local',
      contentUri: `file://${file.path}`,
      ...(file.createdAt ? { createdAt: file.createdAt } : {}),
    };
  });
}

async function collectConversationRegistries(baseRoot: string, out: RegisteredFile[]): Promise<void> {
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
      out.push(...await readRegistryFiles(convPath));
    }
  }
}

async function readRegistryFiles(conversationPath: string): Promise<RegisteredFile[]> {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(conversationPath, ARTIFACT_REGISTRY), 'utf8')) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): RegisteredFile[] => {
    const record = item && typeof item === 'object' ? (item as ArtifactRegistryItem) : undefined;
    const rawPath = typeof record?.path === 'string' ? record.path.trim() : '';
    if (!rawPath || record?.source === 'imported') return [];
    const path = resolve(conversationPath, rawPath);
    return [{
      path,
      ...(typeof record?.title === 'string' && record.title.trim() ? { title: record.title.trim() } : {}),
      ...(typeof record?.kind === 'string' && record.kind.trim() ? { kind: record.kind.trim() } : {}),
      ...(typeof record?.createdAt === 'string' && record.createdAt.trim() ? { createdAt: record.createdAt.trim() } : {}),
    }];
  });
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
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

import { isDiffResult } from './diff';
import { tryParseJson } from './toolPayload';
import type { ArtifactView, Reference } from './types';

const FILE_MUTATION_TOOL = /^(write|edit)_file$/;
const DIFF_HEADER = /^(Created|Updated)\s+(.+)\s+\((\+\d+(?: -\d+)?)\)$/;
const ACTION_HEADER = /^(Created|Updated)\s+(.+)$/;

export function artifactFromToolResult(input: {
  id: number;
  name: string;
  result: string;
  spaceId: string | null;
  workspaceRoot?: string;
}): ArtifactView | null {
  const result = input.result.trimEnd();
  const isDiff = isDiffResult(result);
  const isMutation = FILE_MUTATION_TOOL.test(input.name) || isDiff;
  if (!isMutation || !result) {
    return null;
  }

  const header = result.split('\n', 1)[0]?.trim() || input.name;
  const parsed = parseMutationHeader(header);
  const path = resolveArtifactPath(parsed?.path, input.workspaceRoot);
  const title = path ? basename(path) : header;
  const action = parsed ? `${parsed.action}${parsed.stats ? ` (${parsed.stats})` : ''}` : header;

  return {
    id: input.id,
    spaceId: input.spaceId ?? 'session',
    kind: isDiff ? 'diff' : 'file',
    title,
    detail: `${action} · via ${input.name}`,
    ...(path ? { path } : {}),
    preview: result,
  };
}

export function artifactViewKey(artifact: ArtifactView): string {
  const path = normalizedArtifactPath(artifact.path);
  return path ? `path:${path}` : artifact.href ? `href:${artifact.href}` : `title:${artifact.spaceId}:${artifact.title}`;
}

export function upsertArtifactView(artifacts: ArtifactView[], artifact: ArtifactView, currentRunStart = artifacts.length): ArtifactView[] {
  const index = artifacts.findIndex((item) => sameArtifactView(item, artifact));
  if (index < 0) {
    return [...artifacts, artifact];
  }
  if (index < currentRunStart) {
    return [...artifacts.slice(0, index), ...artifacts.slice(index + 1), artifact];
  }
  const existing = artifacts[index]!;
  const merged = mergeArtifactView(existing, artifact);
  return artifacts.map((item, itemIndex) => (itemIndex === index ? merged : item));
}

export function dedupeArtifactViews(artifacts: ArtifactView[]): ArtifactView[] {
  const result: ArtifactView[] = [];
  for (const artifact of artifacts) {
    const index = result.findIndex((item) => sameArtifactView(item, artifact));
    if (index < 0) {
      result.push(artifact);
      continue;
    }
    result[index] = mergeArtifactView(result[index]!, artifact);
  }
  return result;
}

/** Map exitWorkspace.artifacts refs into console/chat artifact cards. */
export function artifactsFromExitWorkspace(
  args: string,
  spaceId: string | null,
  nextId: () => number,
  workspaceRoot?: string,
): ArtifactView[] {
  const parsed = tryParseJson(args);
  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const artifacts = (parsed as Record<string, unknown>).artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }

  const views: ArtifactView[] = [];
  for (const item of artifacts) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const ref = typeof record.ref === 'string' ? record.ref : undefined;
    const description = typeof record.description === 'string' ? record.description.trim() : undefined;
    const kind = typeof record.kind === 'string' ? record.kind : 'file';
    const href = ref && /^https?:\/\//i.test(ref) ? ref : undefined;
    const path = href ? undefined : resolveArtifactPath(refToLocalPath(ref) ?? ref, workspaceRoot);
    const title = description || (path ? basename(path) : ref ? basename(ref) : 'workspace artifact');

    views.push({
      id: nextId(),
      spaceId: spaceId ?? 'session',
      kind: href ? 'url' : 'file',
      title,
      detail: `exitWorkspace · ${kind}`,
      ...(path ? { path } : {}),
      ...(href ? { href } : {}),
    });
  }
  return views;
}

export function artifactsFromReferences(
  references: readonly Reference[] | undefined,
  spaceId: string | null,
  nextId: () => number,
  workspaceRoot?: string,
): ArtifactView[] {
  if (!Array.isArray(references)) {
    return [];
  }
  const views: ArtifactView[] = [];
  for (const ref of references) {
    if (!ref || typeof ref !== 'object') continue;
    const path = ref.kind === 'file' ? resolveArtifactPath(ref.path, workspaceRoot) : undefined;
    const href = ref.kind === 'url' ? ref.url?.trim() : undefined;
    if (!path && !href) continue;
    const title = ref.title?.trim() || basename(path || href || 'workspace artifact');
    views.push({
      id: nextId(),
      spaceId: spaceId ?? 'session',
      kind: href ? 'url' : 'file',
      title,
      detail: `workspace result · ${ref.kind}`,
      ...(path ? { path } : {}),
      ...(href ? { href } : {}),
      ...(ref.lines ? { lines: ref.lines } : {}),
    });
  }
  return views;
}

export function refToLocalPath(ref?: string): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(ref).pathname);
    } catch {
      return ref.replace(/^file:\/\//, '');
    }
  }
  if (ref.startsWith('/')) return ref;
  return undefined;
}

export function artifactPathFromTitle(title: string): string | undefined {
  return parseMutationHeader(title)?.path ?? refToLocalPath(title);
}

export function resolveArtifactPath(path: string | undefined, workspaceRoot?: string): string | undefined {
  const normalized = normalizedArtifactPath(path);
  if (!normalized) return undefined;
  if (isAbsoluteArtifactPath(normalized)) return normalized;
  const root = normalizedArtifactPath(workspaceRoot);
  if (!root || !isAbsoluteArtifactPath(root)) return normalized;
  return `${root.replace(/\/+$/, '')}/${stripRelativePrefix(normalized).replace(/^\/+/, '')}`;
}

function parseMutationHeader(header: string): { action: string; path: string; stats?: string } | null {
  const diffMatch = DIFF_HEADER.exec(header);
  if (diffMatch) {
    return {
      action: diffMatch[1]!,
      path: diffMatch[2]!,
      stats: diffMatch[3]!,
    };
  }

  const actionMatch = ACTION_HEADER.exec(header);
  if (!actionMatch) {
    return null;
  }
  return {
    action: actionMatch[1]!,
    path: actionMatch[2]!,
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function mergeArtifactView(existing: ArtifactView, artifact: ArtifactView): ArtifactView {
  return {
    ...existing,
    ...artifact,
    id: existing.id,
    path: richerArtifactPath(existing.path, artifact.path),
    href: artifact.href ?? existing.href,
    preview: artifact.preview ?? existing.preview,
  };
}

function sameArtifactView(a: ArtifactView, b: ArtifactView): boolean {
  if (a.href || b.href) {
    return Boolean(a.href && b.href && a.href === b.href);
  }
  const aPath = normalizedArtifactPath(a.path);
  const bPath = normalizedArtifactPath(b.path);
  if (aPath && bPath && sameArtifactPath(aPath, bPath)) {
    return true;
  }
  if (a.spaceId !== b.spaceId) {
    return false;
  }
  const aName = artifactFileName(a);
  const bName = artifactFileName(b);
  if (!aName || aName !== bName) {
    return false;
  }
  return !aPath || !bPath || !isQualifiedArtifactPath(aPath) || !isQualifiedArtifactPath(bPath);
}

function sameArtifactPath(a: string, b: string): boolean {
  if (a === b) return true;
  const aClean = stripRelativePrefix(a);
  const bClean = stripRelativePrefix(b);
  if (aClean === bClean) return true;
  if (isAbsoluteArtifactPath(aClean) && !isAbsoluteArtifactPath(bClean)) {
    return aClean.endsWith(`/${bClean}`);
  }
  if (isAbsoluteArtifactPath(bClean) && !isAbsoluteArtifactPath(aClean)) {
    return bClean.endsWith(`/${aClean}`);
  }
  return false;
}

function artifactFileName(artifact: ArtifactView): string {
  return basename(normalizedArtifactPath(artifact.path) ?? artifact.title);
}

function richerArtifactPath(a?: string, b?: string): string | undefined {
  const aPath = normalizedArtifactPath(a);
  const bPath = normalizedArtifactPath(b);
  if (!aPath) return bPath;
  if (!bPath) return aPath;
  if (isAbsoluteArtifactPath(bPath) && !isAbsoluteArtifactPath(aPath)) return bPath;
  if (isAbsoluteArtifactPath(aPath) && !isAbsoluteArtifactPath(bPath)) return aPath;
  return bPath.length >= aPath.length ? bPath : aPath;
}

function normalizedArtifactPath(path?: string): string | undefined {
  const local = refToLocalPath(path) ?? path;
  const trimmed = local?.trim().replace(/\\/g, '/');
  return trimmed || undefined;
}

function stripRelativePrefix(path: string): string {
  return path.replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function isQualifiedArtifactPath(path: string): boolean {
  return path.includes('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function isAbsoluteArtifactPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

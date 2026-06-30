import { DEFAULT_FILE_WORKSPACE_ROOT } from '@zleap/core';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { projectStore } from '../../../../lib/server/projectStore';
import { resolveBrowsePath } from '../../../../lib/server/projectPaths';
import { artifactContentType, artifactPreviewKind, artifactPreviewNeedsText } from '../../../../lib/artifactPreview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RAW_BYTES = 25 * 1024 * 1024;

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const url = new URL(req.url);
  const rawPath = url.searchParams.get('path');
  if (!rawPath) {
    return Response.json({ error: 'path_required' }, { status: 400 });
  }

  const target = resolve(rawPath);
  const roots = await allowedArtifactRoots();
  if (!roots.some((root) => isInsideRoot(target, root))) {
    return Response.json({ error: 'artifact_path_not_allowed' }, { status: 403 });
  }

  const info = await stat(target).catch((error: unknown) => {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (!info || !info.isFile()) {
    return Response.json({ error: 'artifact_not_found' }, { status: 404 });
  }

  const raw = url.searchParams.get('raw') === '1';
  const needsText = artifactPreviewNeedsText(target);
  const maxBytes = raw || !needsText ? maxRawArtifactBytes() : maxArtifactBytes();
  if (info.size > maxBytes) {
    return Response.json({ error: 'artifact_too_large', maxBytes, size: info.size }, { status: 413 });
  }

  if (raw) {
    const bytes = await readFile(target);
    return new Response(bytes, {
      headers: {
        'content-type': artifactContentType(target),
        'content-length': String(bytes.byteLength),
        'content-disposition': contentDispositionHeader(basename(target)),
      },
    });
  }
  if (!needsText) {
    return Response.json({ path: target, content: '', size: info.size, previewKind: artifactPreviewKind(target) });
  }
  const content = await readFile(target, 'utf8');
  return Response.json({ path: target, content, size: info.size, previewKind: artifactPreviewKind(target) });
}

function isInsideRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

async function allowedArtifactRoots(): Promise<string[]> {
  const roots = [resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT)];
  const projects = await projectStore.list().catch(() => []);
  for (const project of projects) {
    try {
      roots.push(resolveBrowsePath(project.path));
    } catch {
      // Ignore stale or no-longer-allowed project records; they should not
      // widen artifact access.
    }
  }
  return [...new Set(roots)];
}

function maxArtifactBytes(): number {
  const raw = Number(process.env.ZLEAP_ARTIFACT_PREVIEW_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function maxRawArtifactBytes(): number {
  const raw = Number(process.env.ZLEAP_ARTIFACT_RAW_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RAW_BYTES;
}

function contentDispositionHeader(filename: string): string {
  const fallback = asciiFallbackFilename(filename);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function asciiFallbackFilename(filename: string): string {
  const cleaned = filename
    .replace(/["\\]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  return cleaned || 'artifact';
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

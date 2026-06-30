import { DEFAULT_FILE_WORKSPACE_ROOT } from '@zleap/core';
import { stat, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { listWorkspaceFileArtifacts, mergeGalleryArtifacts } from '../../../lib/server/workspaceArtifactScan';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import { projectStore } from '../../../lib/server/projectStore';
import { resolveBrowsePath } from '../../../lib/server/projectPaths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recently produced artifacts (read-only gallery for the Artifact page). */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  try {
    const durable = store
      ? (await store.listArtifacts(150))
          .filter((artifact) => Boolean(artifact.contentUri))
          .map((artifact) => ({
            id: artifact.id,
            title: artifact.title,
            summary: artifact.summary,
            kind: artifact.kind,
            status: artifact.status,
            contentUri: artifact.contentUri,
            createdAt: artifact.createdAt?.toISOString?.() ?? undefined,
          }))
      : [];
    const workspaceFiles = await listWorkspaceFileArtifacts(150);
    const artifacts = mergeGalleryArtifacts(durable, workspaceFiles);
    return Response.json({ artifacts, persistence: { enabled: Boolean(store), reachable: true } });
  } catch (error) {
    return Response.json({ artifacts: [], error: error instanceof Error ? error.message : String(error) });
  } finally {
    await store?.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json().catch(() => ({}))) as { path?: string; contentUri?: string };
    const rawPath = body.path ?? artifactPathFromUri(body.contentUri);
    if (!rawPath) {
      return Response.json({ error: 'artifact_path_required' }, { status: 400 });
    }
    const target = resolve(rawPath);
    const roots = await allowedArtifactRoots();
    if (!roots.some((root) => isInsideRoot(target, root))) {
      return Response.json({ error: 'artifact_path_not_allowed' }, { status: 403 });
    }
    const info = await stat(target).catch((error: unknown) => {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
      if (code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info || !info.isFile()) {
      return Response.json({ error: 'artifact_not_found' }, { status: 404 });
    }
    await unlink(target);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function artifactPathFromUri(uri?: string): string | undefined {
  const value = uri?.trim();
  if (!value) return undefined;
  if (!value.startsWith('file://')) return undefined;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//, '');
  }
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
      // Ignore stale project records.
    }
  }
  return [...new Set(roots)];
}

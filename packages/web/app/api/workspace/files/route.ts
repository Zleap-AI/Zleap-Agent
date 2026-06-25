import type { ActorContext } from '@zleap/core';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { conversationSource, readConversationWorkspace, type ConversationSource } from '../../../../lib/server/conversationWorkspace';
import { resolveBrowsePath } from '../../../../lib/server/projectPaths';
import { projectStore } from '../../../../lib/server/projectStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 500;

type WorkspaceFileEntry = {
  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'other';
  size?: number;
  modifiedAt?: string;
};

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const url = new URL(req.url);
  const projectId = clean(url.searchParams.get('projectId'));
  const conversationId = clean(url.searchParams.get('conversationId'));
  const source = conversationSource(url.searchParams.get('source'));
  const store = conversationId ? await storeFromEnv() : null;

  try {
    if (conversationId && !store) {
      throw new Error('persistence_unavailable');
    }
    const target = await resolveWorkspaceTarget({
      actor,
      store,
      projectId,
      conversationId,
      source,
      path: clean(url.searchParams.get('path')),
    });
    await mkdir(target.root, { recursive: true });

    const info = await stat(target.path);
    if (!info.isDirectory()) {
      return Response.json({ error: 'not_a_directory' }, { status: 400 });
    }

    const rawEntries = await readdir(target.path, { withFileTypes: true });
    const entries = (
      await Promise.all(
        rawEntries
          .filter((entry) => !entry.name.startsWith('.'))
          .slice(0, MAX_ENTRIES)
          .map(async (entry): Promise<WorkspaceFileEntry> => {
            const fullPath = join(target.path, entry.name);
            const itemInfo = await stat(fullPath).catch(() => undefined);
            const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
            return {
              name: entry.name,
              path: fullPath,
              relativePath: relativeToRoot(target.root, fullPath),
              kind,
              ...(kind === 'file' && itemInfo ? { size: itemInfo.size } : {}),
              ...(itemInfo ? { modifiedAt: itemInfo.mtime.toISOString() } : {}),
            };
          }),
      )
    ).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : b.kind === 'directory' ? 1 : 0;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const parent = parentInsideRoot(target.root, target.path);
    return Response.json({
      mode: target.mode,
      root: target.root,
      path: target.path,
      parent,
      title: target.title,
      entries,
      truncated: rawEntries.length > MAX_ENTRIES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = statusForError(message);
    return Response.json({ error: message }, { status });
  } finally {
    await store?.close().catch(() => {});
  }
}

async function resolveWorkspaceTarget(input: {
  actor: ActorContext;
  store: Awaited<ReturnType<typeof storeFromEnv>>;
  projectId?: string;
  conversationId?: string;
  source?: ConversationSource;
  path?: string;
}): Promise<{ mode: 'project' | 'conversation'; root: string; path: string; title: string }> {
  if (input.conversationId) {
    if (!input.store) throw new Error('persistence_unavailable');
    const workspace = await readConversationWorkspace(input.store, input.actor, {
      conversationId: input.conversationId,
      source: input.source,
    });
    const path = resolveTargetPath(workspace.workspaceRoot, input.path);
    return {
      mode: workspace.workspaceKind === 'project' ? 'project' : 'conversation',
      root: workspace.workspaceRoot,
      path,
      title: workspace.title,
    };
  }

  if (input.projectId) {
    const project = (await projectStore.list()).find((item) => item.id === input.projectId);
    if (!project) throw new Error('project_not_found');
    const root = resolveBrowsePath(project.path);
    const path = resolveTargetPath(root, input.path);
    return { mode: 'project', root, path, title: project.name };
  }

  throw new Error('workspace_target_required');
}

function resolveTargetPath(root: string, rawPath: string | undefined): string {
  const target = rawPath ? resolve(rawPath) : root;
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('workspace_path_not_allowed');
  }
  return target;
}

function parentInsideRoot(root: string, path: string): string | null {
  const parent = resolve(dirname(path));
  if (parent === path) return null;
  if (parent !== root && !parent.startsWith(root + sep)) return null;
  return parent;
}

function relativeToRoot(root: string, path: string): string {
  const relative = path === root ? '' : path.slice(root.length + 1);
  return relative || '.';
}

function clean(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function statusForError(message: string): number {
  if (message === 'persistence_unavailable') return 503;
  if (message === 'conversation_workspace_uninitialized') return 409;
  if (message === 'project_not_found' || message === 'conversation_not_found') return 404;
  if (message.endsWith('_not_allowed')) return 403;
  return 400;
}

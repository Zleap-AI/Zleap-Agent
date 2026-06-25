import type { CapabilityType } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse, ensureAvatar, listSpaceProfiles, updateSpace } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { requireSpaceManager } from '../../../../lib/server/spaceAccessPolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const spaceId = url.searchParams.get('spaceId');
  if (!spaceId) {
    return Response.json({ error: 'spaceId_required' }, { status: 400 });
  }
  const store = await storeFromEnv();
  try {
    const spaces = await listSpaceProfiles(store);
    const space = spaces.find((candidate) => candidate.id === spaceId || candidate.storageId === spaceId);
    if (!space) {
      return Response.json({ error: 'space_not_found' }, { status: 404 });
    }
    return Response.json({ space });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      avatarId?: string;
      spaceId?: string;
      toolSetIds?: string[];
      toolIds?: string[];
      capabilities?: Array<{ type?: string; id?: string; version?: number; config?: Record<string, unknown> }>;
    };
    if (!body.spaceId?.trim()) {
      return Response.json({ error: 'spaceId_required' }, { status: 400 });
    }
    const spaceId = body.spaceId.trim();
    const forbidden = await requireSpaceManager(store, spaceId, actor);
    if (forbidden) return forbidden;
    const capabilities = (body.capabilities ?? []).map((capability) => {
      if (!capability.type || !capability.id) {
        throw new Error('capabilities require type and id');
      }
      return {
        type: capability.type as CapabilityType,
        id: capability.id,
        version: capability.version,
        config: capability.config,
      };
    });
    await ensureAvatar(store, body.avatarId);
    await updateSpace(store, spaceId, { rebind: true, toolSetIds: body.toolSetIds, toolIds: body.toolIds, capabilities });
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

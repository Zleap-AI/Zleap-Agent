import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { archiveAvatar, avatarErrorResponse, cleanAvatarId, createNamedAvatar, listAvatars, resolveAvatar } from '../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Avatars = persona masks plus UI preferences; space records stay global. */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const avatarId = cleanAvatarId(url.searchParams.get('avatarId') ?? undefined);
  const store = await storeFromEnv();
  try {
    await resolveAvatar(store, avatarId); // validates id + seeds default
    const avatars = await listAvatars(store, avatarId);
    return Response.json({ avatars, avatarId, persistence: { enabled: Boolean(process.env.ZLEAP_DATABASE_URL), reachable: Boolean(store) } });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

/**
 * Update an existing avatar's persona / name / metadata (e.g. emoji + stickers)
 * by writing a new avatar version. Web-bypass write straight through the store
 * (core stays SDK-free per docs/core.md §7).
 */
export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as { id?: string; name?: string; persona?: string; metadata?: Record<string, unknown> };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const avatar = await store.avatars.getAvatar(id);
    if (!avatar) {
      return Response.json({ error: 'avatar_not_found' }, { status: 404 });
    }
    const current = await store.avatars.getAvatarVersion(id);
    const now = new Date();
    const nextVersion = avatar.currentVersion + 1;
    await store.transaction(async (tx) => {
      await tx.avatars.saveAvatar({ ...avatar, name: body.name?.trim() || avatar.name, currentVersion: nextVersion, updatedAt: now });
      await tx.avatars.saveAvatarVersion({
        avatarId: id,
        version: nextVersion,
        name: body.name?.trim() || current?.name || avatar.name,
        description: current?.description,
        persona: body.persona ?? current?.persona,
        modelConfigId: current?.modelConfigId,
        metadata: { ...(current?.metadata ?? {}), ...(body.metadata ?? {}) },
        createdAt: now,
      });
    });
    const resolved = await resolveAvatar(store, id);
    return Response.json({ avatar: { id: resolved.avatar.id, name: resolved.avatar.name, persona: resolved.version.persona, metadata: resolved.version.metadata } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      description?: string;
      persona?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.id?.trim() || !body.name?.trim()) {
      return Response.json({ error: 'id_and_name_required' }, { status: 400 });
    }
    const profile = await createNamedAvatar(store, {
      id: body.id.trim(),
      name: body.name.trim(),
      description: body.description,
      persona: body.persona,
      metadata: body.metadata,
    });
    return Response.json({ profile }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await archiveAvatar(store, id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

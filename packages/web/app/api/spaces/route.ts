import { type CapabilityType, type SpaceKind } from '@zleap/core';
import { buildWorkspaceDetailsFromAvatarProfile } from '@zleap/agent/workspaces';
import { filterSpacesForAvatarBinding } from '../../../lib/avatarSpaceBindings';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { archiveSpace, avatarErrorResponse, createSpace, ensureAvatar, listSpaceProfiles, resolveAvatar, updateSpace } from '../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import { requireSpaceManager, spaceOwnershipMetadata } from '../../../lib/server/spaceAccessPolicy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List global spaces; when avatarId is provided, apply that avatar's UI binding preference. */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const rawAvatarId = url.searchParams.get('avatarId');
  const store = await storeFromEnv();
  try {
    const allSpaces = await listSpaceProfiles(store);
    const avatarMetadata = rawAvatarId !== null && store ? (await resolveAvatar(store, rawAvatarId)).version.metadata : undefined;
    const spaces = filterSpacesForAvatarBinding(allSpaces, avatarMetadata);
    // MCP tools are mounted as `mcp_tool` capability bindings, not builtin
    // toolIds — surface them per space so the editor can show/round-trip them.
    const details = buildWorkspaceDetailsFromAvatarProfile({ spaces }).map((detail) => {
      const profile = spaces.find((s) => s.storageId === detail.storageId || s.id === detail.canonicalId);
      const mcpToolIds = (profile?.capabilities ?? []).filter((c) => c.type === 'mcp_tool').map((c) => c.id);
      return { ...detail, mcpToolIds };
    });
    return Response.json({ spaces: details });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

/** Create a space. Spaces are global (docs/core.md §3); the SDK still takes an
 *  avatar until its persona-only refactor lands, so we pass a default here. */
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
      id?: string;
      kind?: string;
      label?: string;
      description?: string;
      routingCard?: string;
      instructions?: string;
      modelConfigId?: string | null;
      icon?: string;
      accent?: string;
      toolSetIds?: string[];
      toolIds?: string[];
      autoMountSkills?: boolean;
      capabilities?: Array<{ type?: string; id?: string; version?: number; config?: Record<string, unknown> }>;
    };
    if (!body.id?.trim() || !body.label?.trim()) {
      return Response.json({ error: 'id_and_label_required' }, { status: 400 });
    }
    if (body.kind && body.kind !== 'main' && body.kind !== 'work') {
      return Response.json({ error: 'invalid_space_kind' }, { status: 400 });
    }
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
    await createSpace(store, {
      id: body.id.trim(),
      kind: body.kind as SpaceKind | undefined,
      label: body.label.trim(),
      description: body.description,
      routingCard: body.routingCard,
      instructions: body.instructions,
      modelConfigId: cleanModelConfigId(body.modelConfigId) ?? undefined,
      icon: body.icon,
      accent: body.accent,
      toolSetIds: body.toolSetIds,
      toolIds: body.toolIds,
      autoMountSkills: body.autoMountSkills,
      capabilities,
      metadata: spaceOwnershipMetadata(actor),
    });
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

/**
 * Update a space's metadata (label / routing / description / instructions) by
 * writing a new space version. Web-bypass write straight through the store; the
 * mount list is edited separately via /api/spaces/capabilities.
 */
export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      label?: string;
      description?: string;
      routingCard?: string;
      instructions?: string;
      modelConfigId?: string | null;
      icon?: string;
      accent?: string;
      autoMountSkills?: boolean;
    };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const forbidden = await requireSpaceManager(store, id, actor);
    if (forbidden) return forbidden;
    await updateSpace(store, id, {
      label: body.label,
      description: body.description,
      routingCard: body.routingCard,
      instructions: body.instructions,
      modelConfigId: cleanModelConfigId(body.modelConfigId),
      icon: body.icon,
      accent: body.accent,
      autoMountSkills: body.autoMountSkills,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

function cleanModelConfigId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const clean = value.trim();
  return clean || null;
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
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
    const forbidden = await requireSpaceManager(store, id, actor);
    if (forbidden) return forbidden;
    await archiveSpace(store, id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

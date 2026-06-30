import { toCanonicalSpaceId, type ActorContext } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';

type SpaceOwnership = {
  ownerUserId?: string;
  ownerTenantId?: string;
  createdByUserId?: string;
  createdByRole?: string;
  policyVersion?: number;
};

export function spaceOwnershipMetadata(actor: ActorContext): Record<string, unknown> {
  return {
    ownership: {
      ownerUserId: actor.userId,
      ...(actor.tenantId ? { ownerTenantId: actor.tenantId } : {}),
      createdByUserId: actor.userId,
      createdByRole: actor.role,
      policyVersion: 1,
    } satisfies SpaceOwnership,
  };
}

export async function requireSpaceManager(
  store: ZleapStore,
  rawSpaceId: string,
  actor: ActorContext,
): Promise<Response | undefined> {
  if (actor.role === 'admin' || actor.role === 'creator') {
    return undefined;
  }
  const spaceId = toCanonicalSpaceId(rawSpaceId);
  const space = await store.spaces.getSpace(spaceId);
  if (!space) {
    return Response.json({ error: 'space_not_found' }, { status: 404 });
  }
  const version = await store.spaces.getSpaceVersion(space.id, space.currentVersion);
  if (!version) {
    return Response.json({ error: 'space_version_not_found' }, { status: 404 });
  }
  if (ownsSpace(actor, version.metadata)) {
    return undefined;
  }
  return Response.json({ error: 'actor_forbidden' }, { status: 403 });
}

function ownsSpace(actor: ActorContext, metadata: Record<string, unknown> | undefined): boolean {
  const ownership = readOwnership(metadata);
  if (!ownership?.ownerUserId || ownership.ownerUserId !== actor.userId) {
    return false;
  }
  return !ownership.ownerTenantId || ownership.ownerTenantId === actor.tenantId;
}

function readOwnership(metadata: Record<string, unknown> | undefined): SpaceOwnership | undefined {
  const nested = metadata?.ownership;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as SpaceOwnership;
  }
  if (typeof metadata?.ownerUserId === 'string') {
    return metadata as SpaceOwnership;
  }
  return undefined;
}

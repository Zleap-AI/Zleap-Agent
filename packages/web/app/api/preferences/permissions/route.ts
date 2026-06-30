import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { readPermissionPreference, savePermissionPreference } from '../../../../lib/server/permissionPreferenceStore';
import { normalizePermissionMode } from '../../../../lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const mode = await readPermissionPreference({
    userId: actor.userId,
    tenantId: actor.tenantId,
    avatarId: bounded(url.searchParams.get('avatarId')),
    spaceId: bounded(url.searchParams.get('spaceId')),
  });
  return Response.json({ mode, scope: 'account_space' });
}

export async function PUT(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const mode = await savePermissionPreference(
    {
      userId: actor.userId,
      tenantId: actor.tenantId,
      avatarId: bounded(body.avatarId),
      spaceId: bounded(body.spaceId),
    },
    normalizePermissionMode(body.mode),
  );
  return Response.json({ mode, scope: 'account_space' });
}

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 120 ? value.trim() : undefined;
}

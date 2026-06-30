import { isActorResponse, requireHttpActor } from '../../../../../../lib/server/actor';
import { avatarErrorResponse, discoverServerTools } from '../../../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Re-run tool discovery against an existing MCP server (the "refresh tools"
 *  action): connect → tools/list → upsert + reconcile the cached catalog. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const serverId = id?.trim();
    if (!serverId) {
      return Response.json({ error: 'server_id_required' }, { status: 400 });
    }
    const discovery = await discoverServerTools(store, serverId, { userId: actor.userId, tenantId: actor.tenantId });
    return Response.json({ discovery });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

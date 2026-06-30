import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { factoryResetWebData } from '../../../../lib/server/factoryReset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  try {
    const result = await factoryResetWebData();
    return Response.json({ ok: true, removedCount: result.history.removedCount, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

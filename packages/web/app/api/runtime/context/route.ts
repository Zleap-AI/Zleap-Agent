import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { getLocalRuntimeContext } from '../../../../lib/server/localRuntimeContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  return Response.json(await getLocalRuntimeContext());
}

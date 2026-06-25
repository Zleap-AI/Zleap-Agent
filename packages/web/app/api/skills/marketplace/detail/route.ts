import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { SkillMarketplaceError, getSkillDetail } from '../../../../../lib/server/skillMarketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const id = new URL(req.url).searchParams.get('id')?.trim() ?? '';
  try {
    return Response.json({ detail: await getSkillDetail(id) });
  } catch (error) {
    return marketplaceErrorResponse(error);
  }
}

function marketplaceErrorResponse(error: unknown): Response {
  if (error instanceof SkillMarketplaceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

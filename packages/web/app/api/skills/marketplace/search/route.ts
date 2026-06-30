import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { storeFromEnv } from '../../../../../lib/server/avatarStore';
import { SkillMarketplaceError, searchSkills } from '../../../../../lib/server/skillMarketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  const limit = Number(url.searchParams.get('limit') ?? 10);
  const store = await storeFromEnv();
  try {
    const result = await searchSkills({
      query,
      limit: Number.isFinite(limit) ? limit : undefined,
      store,
    });
    return Response.json(result);
  } catch (error) {
    return marketplaceErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

function marketplaceErrorResponse(error: unknown): Response {
  if (error instanceof SkillMarketplaceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

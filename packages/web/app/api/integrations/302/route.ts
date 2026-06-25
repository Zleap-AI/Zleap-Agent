import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { read302IntegrationConfig, resolve302ApiKey, save302IntegrationConfig } from '../../../../lib/server/integration302Config';
import { upsertDefault302ModelConfigs } from '../../../../lib/server/modelPresets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const config = await read302IntegrationConfig();
  return Response.json({ configured: Boolean(resolve302ApiKey(config)) });
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  try {
    const body = (await req.json().catch(() => ({}))) as { apiKey?: string };
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return Response.json({ error: 'api_key_required' }, { status: 400 });
    }
    await save302IntegrationConfig({ apiKey });
    await upsertDefault302ModelConfigs(store, { apiKey });
    return Response.json({ ok: true, configured: true });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

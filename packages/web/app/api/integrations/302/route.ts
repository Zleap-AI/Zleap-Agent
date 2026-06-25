import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import {
  DEFAULT_302_API_BASE_URL,
  DEFAULT_302_MODEL_BASE_URL,
  read302IntegrationConfig,
  resolve302ApiBaseUrl,
  resolve302ApiKey,
  resolve302ModelBaseUrl,
  save302IntegrationConfig,
} from '../../../../lib/server/integration302Config';
import { upsertDefault302ModelConfigs } from '../../../../lib/server/modelPresets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const config = await read302IntegrationConfig();
  return Response.json({
    configured: Boolean(resolve302ApiKey(config)),
    apiBaseUrl: resolve302ApiBaseUrl(config),
    modelBaseUrl: resolve302ModelBaseUrl(config),
  });
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      apiKey?: string;
      apiBaseUrl?: string;
      modelBaseUrl?: string;
    };
    const current = await read302IntegrationConfig();
    const apiKey = body.apiKey?.trim();
    const hasEffectiveKey = Boolean(apiKey || resolve302ApiKey(current));
    if (!hasEffectiveKey) {
      return Response.json({ error: 'api_key_required' }, { status: 400 });
    }
    const saved = await save302IntegrationConfig({
      ...(apiKey ? { apiKey } : {}),
      apiBaseUrl: body.apiBaseUrl?.trim() || current.apiBaseUrl || DEFAULT_302_API_BASE_URL,
      modelBaseUrl: body.modelBaseUrl?.trim() || current.modelBaseUrl || DEFAULT_302_MODEL_BASE_URL,
    });
    await upsertDefault302ModelConfigs(store, { apiKey: saved.apiKey, modelBaseUrl: saved.modelBaseUrl });
    return Response.json({
      ok: true,
      configured: Boolean(resolve302ApiKey(saved)),
      apiBaseUrl: resolve302ApiBaseUrl(saved),
      modelBaseUrl: resolve302ModelBaseUrl(saved),
    });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

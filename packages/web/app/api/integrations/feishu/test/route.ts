import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../../lib/server/avatarContext';
import { getSharedStore } from '../../../../../lib/server/sharedStore';
import { resolveTestCredentials, testFeishuCredentials } from '../../../../../lib/server/feishuIntegration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Validate Feishu credentials. Uses the values in the request body when present
 * (so the form can test before saving) and otherwise falls back to the stored
 * config — letting an admin re-verify a saved integration.
 */
export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await getSharedStore();
  if (!store) return Response.json({ error: 'database_required' }, { status: 503 });
  try {
    const body = (await req.json().catch(() => ({}))) as { appId?: string; appSecret?: string; domain?: string };
    const creds = await resolveTestCredentials(store, body);
    if (!creds) {
      return Response.json({ ok: false, error: 'credentials_required' }, { status: 400 });
    }
    return Response.json(await testFeishuCredentials(creds));
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

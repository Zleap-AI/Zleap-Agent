import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { getSharedStore } from '../../../../lib/server/sharedStore';
import {
  deleteWeChatIntegration,
  readWeChatIntegration,
  saveWeChatIntegration,
  type WeChatIntegrationInput,
} from '../../../../lib/server/wechatIntegration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { error: 'database_required' } as const;

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  try {
    return Response.json(await readWeChatIntegration(store));
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  try {
    const body = (await req.json().catch(() => ({}))) as WeChatIntegrationInput;
    const result = await saveWeChatIntegration(store, body);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ ok: true, ...(await readWeChatIntegration(store)) });
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  try {
    await deleteWeChatIntegration(store);
    return Response.json({ ok: true });
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

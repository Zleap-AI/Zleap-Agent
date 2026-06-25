import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { getSharedStore } from '../../../../lib/server/sharedStore';
import {
  deleteFeishuIntegration,
  readFeishuIntegration,
  saveFeishuIntegration,
  type FeishuIntegrationInput,
} from '../../../../lib/server/feishuIntegration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { error: 'database_required' } as const;

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  try {
    return Response.json(await readFeishuIntegration(store));
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
    const body = (await req.json().catch(() => ({}))) as FeishuIntegrationInput;
    const result = await saveFeishuIntegration(store, body);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ ok: true, ...(await readFeishuIntegration(store)) });
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
    await deleteFeishuIntegration(store);
    return Response.json({ ok: true });
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

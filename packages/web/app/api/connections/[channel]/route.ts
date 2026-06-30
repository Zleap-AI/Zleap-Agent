import { ConnectionsService, type ConnectionCommandType } from '@zleap/agent/conversation';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { getSharedStore } from '../../../../lib/server/sharedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { error: 'database_required' } as const;
/** Channels that expose a unified connection lifecycle. */
const CHANNELS = new Set(['feishu', 'wechat', 'feishu-cli']);

function isCommand(value: unknown): value is ConnectionCommandType {
  return value === 'connect' || value === 'refresh' || value === 'logout';
}

type Ctx = { params: Promise<{ channel: string }> };

/** Unified connection state for the channel (web/CLI render this verbatim). */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const { channel } = await ctx.params;
  if (!CHANNELS.has(channel)) return Response.json({ error: 'unknown_channel' }, { status: 404 });
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  try {
    return Response.json(await new ConnectionsService(store.integrations).getState(channel));
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

/**
 * Issue a connect/refresh/logout command. The running gateway control plane
 * picks it up and drives the channel's adapter (regenerate QR, re-issue device
 * code, reconnect WS) without a process restart.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const { channel } = await ctx.params;
  if (!CHANNELS.has(channel)) return Response.json({ error: 'unknown_channel' }, { status: 404 });
  const store = await getSharedStore();
  if (!store) return Response.json(NO_STORE, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (!isCommand(body.action)) return Response.json({ error: 'bad_action' }, { status: 400 });
  try {
    const service = new ConnectionsService(store.integrations);
    await service.requestCommand(channel, body.action);
    return Response.json({ ok: true, ...(await service.getState(channel)) });
  } catch (error) {
    return avatarErrorResponse(error);
  }
}

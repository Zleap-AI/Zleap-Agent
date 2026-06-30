import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { storeFromEnv } from '../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId')?.trim();
  if (!conversationId) {
    return Response.json({ error: 'conversation_id_required' }, { status: 400 });
  }
  const agentId = url.searchParams.get('agentId')?.trim() || DEFAULT_AVATAR_ID;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ entries: [], persistence: { enabled: false, reachable: false } });
  }
  try {
    const entries = await store.runtimeCache.listEntries({
      conversationId,
      userId: actor.userId,
      agentId,
      limit: 100,
    });
    return Response.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        toolId: entry.toolId,
        workspaceId: entry.workspaceId,
        createdAt: entry.createdAt.toISOString(),
      })),
      persistence: { enabled: true, reachable: true },
    });
  } finally {
    await store.close().catch(() => {});
  }
}

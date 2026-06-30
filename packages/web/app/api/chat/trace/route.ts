import {
  DEFAULT_AVATAR_ID,
  hasActorPermission,
  type LedgerEventRecord,
  type SessionEntryRecord,
} from '@zleap/core';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { toPublicChatTraceEntry } from '../../../../lib/server/chatTraceProjection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENTRY_TYPES = new Set<SessionEntryRecord['type']>([
  'message',
  'tool_call',
  'tool_result',
  'artifact',
  'compaction',
  'branch_summary',
  'model_change',
  'capability_snapshot',
  'custom',
]);

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const url = new URL(req.url);
  const avatarId = nonEmpty(url.searchParams.get('avatarId')) ?? DEFAULT_AVATAR_ID;
  const conversationId = nonEmpty(url.searchParams.get('conversationId'));
  const explicitSessionId = nonEmpty(url.searchParams.get('sessionId'));
  const projectionKind = nonEmpty(url.searchParams.get('projectionKind'));
  const typeResult = parseEntryType(url.searchParams.get('type'));
  if (typeResult instanceof Response) return typeResult;
  const limit = parseLimit(url.searchParams.get('limit'));
  const raw = parseBoolean(url.searchParams.get('raw'));
  if (raw && (actor.role !== 'admin' || !hasActorPermission(actor, 'debug:trace:raw'))) {
    return Response.json({ error: 'actor_forbidden' }, { status: 403 });
  }

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  try {
    const owner = { userId: actor.userId, tenantId: actor.tenantId };
    const session = explicitSessionId
      ? await store.sessions.getSession(explicitSessionId, owner)
      : undefined;
    if (explicitSessionId && (!session || session.avatarId !== avatarId)) {
      return Response.json({ error: 'session_not_found' }, { status: 404 });
    }
    const thread = session
      ? await store.threads.getThread(session.threadId, owner)
      : conversationId
        ? await store.threads.getThread(`web:${sanitizeConversationId(conversationId)}`, owner)
        : (await store.threads.listThreads({ avatarId, ...owner, limit: 1 }))[0];

    if (!thread || thread.avatarId !== avatarId) {
      return Response.json({ error: 'thread_not_found' }, { status: 404 });
    }

    const sessionId = session?.id ?? thread.mainSessionId ?? `${thread.id}:main`;
    const entries = await store.sessions.listEntries({
      sessionId,
      ...owner,
      type: typeResult,
      projectionKind,
      limit,
    });
    const ledgerEvents: LedgerEventRecord[] = raw
      ? await store.ledger.listEvents({
          threadId: thread.id,
          sessionId,
          ...owner,
          limit: limit ?? 500,
        })
      : [];
    const metadata = thread.metadata as { conversationId?: unknown } | undefined;
    const responseConversationId = typeof metadata?.conversationId === 'string' ? metadata.conversationId : conversationId ?? thread.id;
    if (raw) {
      const now = new Date();
      await store.ledger.saveEvent({
        id: `chat_trace_raw_read:${thread.id}:${sessionId}:${now.getTime()}`,
        threadId: thread.id,
        sessionId,
        userId: actor.userId,
        tenantId: actor.tenantId,
        type: 'chat_trace_raw_read',
        data: {
          avatarId,
          conversationId: responseConversationId,
          sessionKind: session?.kind ?? 'main',
          spaceId: session?.spaceId,
          filters: {
            type: typeResult,
            projectionKind,
            limit,
          },
          entryCount: entries.length,
        },
        createdAt: now,
      });
    }
    return Response.json({
      conversationId: responseConversationId,
      threadId: thread.id,
      sessionId,
      sessionKind: session?.kind ?? 'main',
      spaceId: session?.spaceId,
      entries: raw ? entries : entries.map(toPublicChatTraceEntry),
      ...(raw ? { ledgerEvents } : {}),
    });
  } finally {
    await store.close().catch(() => {});
  }
}

function parseEntryType(value: string | null): SessionEntryRecord['type'] | undefined | Response {
  const type = nonEmpty(value);
  if (!type) return undefined;
  if (!ENTRY_TYPES.has(type as SessionEntryRecord['type'])) {
    return Response.json({ error: 'invalid_entry_type', type }, { status: 400 });
  }
  return type as SessionEntryRecord['type'];
}

function parseLimit(value: string | null): number | undefined {
  const raw = nonEmpty(value);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.min(parsed, 1000));
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | null): boolean {
  const raw = nonEmpty(value)?.toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function sanitizeConversationId(value: string): string {
  return value.trim().replace(/[^\w:.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

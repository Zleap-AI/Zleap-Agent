import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { resolveLiveApproval } from '../../../../lib/server/liveApprovals';

const APPROVAL_ID_MAX_CHARS = 200;
const APPROVAL_TOOL_NAME_MAX_CHARS = 120;
const APPROVAL_PREVIEW_MAX_CHARS = 5000;

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) {
    return actor;
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const conversationId = boundedString(body.conversationId, APPROVAL_ID_MAX_CHARS);
  const approvalId = boundedString(body.approvalId, APPROVAL_ID_MAX_CHARS);
  const toolName = boundedString(body.toolName, APPROVAL_TOOL_NAME_MAX_CHARS);
  const preview = body.preview === undefined ? undefined : boundedString(body.preview, APPROVAL_PREVIEW_MAX_CHARS);
  if (!approvalId || !toolName || typeof body.approved !== 'boolean') {
    return Response.json({ error: 'invalid_approval_decision' }, { status: 400 });
  }
  if (body.preview !== undefined && !preview) {
    return Response.json({ error: 'invalid_approval_decision' }, { status: 400 });
  }

  const status = await resolveLiveApproval({
    actor,
    conversationId,
    approvalId,
    toolName,
    approved: body.approved,
    ...(preview ? { preview } : {}),
  });
  if (status === 'not_found') {
    return Response.json({ error: 'approval_not_found' }, { status: 404 });
  }
  if (status === 'mismatch') {
    return Response.json({ error: 'approval_mismatch' }, { status: 409 });
  }
  return Response.json({ ok: true });
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) {
    return undefined;
  }
  return trimmed;
}

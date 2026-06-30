import type { ChatDelta, Engine } from './engine';
import { webApiFetch } from './api';
import { requestToDisplayAttachments, type ChatImageRequestAttachment } from './chatAttachments';

type ApprovalDecision = {
  approvalId: string;
  toolName: string;
  approved: boolean;
  preview?: string;
};

type ChatImageAttachmentApiPayload = Omit<ChatImageRequestAttachment, 'thumbnailDataUrl' | 'previewDataUrl'>;

/**
 * Real engine: POSTs the conversation to `/api/chat`, which runs the agent's
 * `ChatEngine.reply` and streams `ChatDelta` events back as SSE. Same `Engine`
 * signature as `mockEngine`, so swapping is a one-line change in `page.tsx`.
 *
 * HITL approvals are live: `/api/chat` emits `needs_approval` and waits; this
 * client asks the user, POSTs the decision, then keeps reading the same stream.
 */
export const sseEngine: Engine = async function* sseEngine(history, signal, opts) {
  // History is server-owned (loaded from the store by conversationId), same as
  // the CLI/gateway path, so the client only sends this turn's new user message.
  const lastUser = [...history].reverse().find((turn) => turn.role === 'user');
  const attachments = chatImageAttachmentApiPayloads(opts.attachments ?? []);
  const displayAttachments = requestToDisplayAttachments(opts.attachments ?? []);
  const hasAttachments = attachments.length > 0;
  let response: Response;
  try {
    response = await webApiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: lastUser || hasAttachments ? [{ role: 'user', text: lastUser?.text ?? '' }] : [],
        attachments,
        ...(displayAttachments.length ? { displayAttachments } : {}),
        conversationId: opts.conversationId,
        avatarId: opts.avatarId,
        projectId: opts.projectId ?? null,
        modelId: opts.modelId,
        permissionMode: opts.permissionMode,
        targetSpace: opts.targetSpace,
        runMode: opts.runMode,
        skillId: opts.skillId,
        skillLabel: opts.skillLabel,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    yield { type: 'error', message: error instanceof Error ? error.message : 'Network error' };
    return;
  }

  if (!response.ok || !response.body) {
    yield { type: 'error', message: `Request failed: HTTP ${response.status} ${response.statusText}`.trim() };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handledApprovals = new Set<string>();

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return; // aborted / connection closed
    }
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const json = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!json || json === '[DONE]') continue;
      let delta: ChatDelta;
      try {
        delta = JSON.parse(json) as ChatDelta;
      } catch {
        // skip malformed frame
        continue;
      }
      if (delta.type === 'needs_approval') {
        const key = approvalKey(delta);
        if (!handledApprovals.has(key)) {
          handledApprovals.add(key);
          const approved = await opts.confirm({
            approvalId: delta.approvalId,
            name: delta.name,
            args: delta.args,
            ...(delta.preview ? { preview: delta.preview } : {}),
          });
          try {
            await postApprovalDecision(
              {
                approvalId: delta.approvalId,
                toolName: delta.name,
                approved,
                ...(delta.preview ? { preview: delta.preview } : {}),
              },
              opts.conversationId,
              signal,
            );
          } catch (error) {
            yield approvalFailureDelta(delta, error);
            return;
          }
          continue;
        }
      }
      yield delta;
    }
  }

  buffer += decoder.decode();
  const json = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (json && json !== '[DONE]') {
    let delta: ChatDelta;
    try {
      delta = JSON.parse(json) as ChatDelta;
    } catch {
      // skip malformed trailing frame
      return;
    }
    if (delta.type === 'needs_approval') {
      const key = approvalKey(delta);
      if (handledApprovals.has(key)) {
        yield delta;
        return;
      }
      handledApprovals.add(key);
      const approved = await opts.confirm({
        approvalId: delta.approvalId,
        name: delta.name,
        args: delta.args,
        ...(delta.preview ? { preview: delta.preview } : {}),
      });
      try {
        await postApprovalDecision(
          {
            approvalId: delta.approvalId,
            toolName: delta.name,
            approved,
            ...(delta.preview ? { preview: delta.preview } : {}),
          },
          opts.conversationId,
          signal,
        );
      } catch (error) {
        yield approvalFailureDelta(delta, error);
      }
      return;
    }
    yield delta;
  }
};

function chatImageAttachmentApiPayloads(attachments: readonly ChatImageRequestAttachment[]): ChatImageAttachmentApiPayload[] {
  return attachments.map(({ thumbnailDataUrl: _thumbnailDataUrl, previewDataUrl: _previewDataUrl, ...attachment }) => attachment);
}

async function postApprovalDecision(decision: ApprovalDecision, conversationId: string | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const response = await webApiFetch('/api/chat/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, ...decision }),
    signal,
  }).catch(() => undefined);
  if (!response?.ok) {
    const status = response?.status;
    if (status === 404) throw new ApprovalPostError('expired', '审批已失效或超时');
    if (status === 409) throw new ApprovalPostError('retry', '审批内容已变化,请重试');
    throw new ApprovalPostError('retry', `审批提交失败: HTTP ${status ?? 'network'}`);
  }
}

class ApprovalPostError extends Error {
  constructor(readonly status: 'expired' | 'retry', message: string) {
    super(message);
    this.name = 'ApprovalPostError';
  }
}

function approvalFailureDelta(delta: Extract<ChatDelta, { type: 'needs_approval' }>, error: unknown): ChatDelta {
  const status = error instanceof ApprovalPostError ? error.status : 'retry';
  return {
    type: 'approval_status',
    approvalId: delta.approvalId,
    name: delta.name,
    args: delta.args,
    ...(delta.preview ? { preview: delta.preview } : {}),
    status,
    message: error instanceof Error ? error.message : String(error),
  };
}

function approvalKey(delta: Extract<ChatDelta, { type: 'needs_approval' }>): string {
  return [delta.approvalId, delta.name, delta.preview ?? ''].join('\0');
}

import type { Message } from '@zleap/ai';
import { mainSessionIdOf, type ActorContext, type SessionEntryRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { buildConversationFromEntries, filterSessionEntriesByVisibility } from '../session-history.js';

export type LoadHistoryParams = {
  /** Channel the conversation belongs to (e.g. 'feishu', 'web'). */
  channel: string;
  /** Stable per-channel conversation id. */
  conversationId: string;
  /** Owner scope for store reads; also enforces row-level ownership. */
  actor?: ActorContext;
  /** Optional cap on the number of underlying entries to read. */
  limit?: number;
  /**
   * Include tool-call/result traces in the rebuilt history so the model sees the
   * tools earlier turns used. Defaults to true. When false, only user/assistant
   * text turns are returned (the legacy `buildConversation` behavior).
   */
  includeTools?: boolean;
};

/** Max characters kept from a single tool's input/result when annotating history. */
const TOOL_TRACE_MAX_CHARS = 600;

/**
 * Server-owned history loader. Rebuilds the prior user/assistant turns of a
 * conversation directly from the durable store, keyed by the conversation
 * identity `(channel, conversationId)` -> `${channel}:${conversationId}:main`.
 *
 * This is the gateway/task counterpart of the CLI's `resumeLastThread`: a
 * generic "load history by conversationId" capability the trigger layer can use
 * when there is no client to replay the transcript.
 *
 * Tool traces are included by default (`includeTools`) as provider-legal
 * assistant tool-call plus tool-result pairs. Results are shortened and point
 * the model to `readMessage({ id })` for full recovery.
 */
export async function loadHistory(store: ZleapStore, params: LoadHistoryParams): Promise<Message[]> {
  const { channel, conversationId, actor, limit, includeTools = true } = params;
  const owner = actor ? { userId: actor.userId, tenantId: actor.tenantId } : {};
  const sessionId = mainSessionIdOf(channel, conversationId);
  const entries = await store.sessions.listEntries({
    sessionId,
    ...owner,
    ...(limit ? { limit } : {}),
  });

  if (!includeTools) {
    const conversation = buildConversationFromEntries(entries);
    const messages: Message[] = [];
    for (const entry of conversation) {
      const text = entry.content?.trim();
      if (!text) {
        continue;
      }
      if (entry.role === 'user') {
        messages.push({ role: 'user', content: text });
      } else if (entry.role === 'assistant') {
        pushAssistantText(messages, text);
      }
    }
    return messages;
  }

  return sessionEntriesToModelMessages(filterSessionEntriesByVisibility(entries));
}

export function sessionEntriesToModelMessages(entries: SessionEntryRecord[]): Message[] {
  const messages: Message[] = [];
  const pendingToolCalls = new Map<string, SessionEntryRecord>();

  for (const entry of entries) {
    if (entry.type === 'message') {
      pushTextEntry(messages, entry);
      continue;
    }
    if (entry.type === 'tool_call') {
      const toolCallId = stableToolCallId(entry);
      if (!toolCallId) {
        pushAssistantText(messages, historicalToolNote(entry, 'Tool call had no usable toolCallId and was not replayed as a provider tool call.'));
        continue;
      }
      pendingToolCalls.set(toolCallId, entry);
      continue;
    }
    if (entry.type === 'tool_result') {
      const toolCallId = stableToolCallId(entry);
      const call = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
      if (call && toolCallId) {
        messages.push(toolCallMessageFromEntry(call, toolCallId));
        messages.push(toolResultMessageFromEntry(entry, toolCallId));
        pendingToolCalls.delete(toolCallId);
        continue;
      }
      if (toolCallId) {
        messages.push(syntheticToolCallMessageFromResult(entry, toolCallId));
        messages.push(toolResultMessageFromEntry(entry, toolCallId));
        continue;
      }
      pushAssistantText(messages, historicalToolNote(entry, 'Tool result had no usable toolCallId and was not replayed as a provider tool result.'));
    }
  }

  for (const call of pendingToolCalls.values()) {
    pushAssistantText(messages, historicalToolNote(call, 'Tool call had no recorded result and was not replayed as a provider tool call.'));
  }
  return messages;
}

function pushTextEntry(messages: Message[], entry: SessionEntryRecord): void {
  const text = entry.content?.trim();
  if (!text) {
    return;
  }
  if (entry.role === 'user') {
    messages.push({ role: 'user', content: text });
  } else if (entry.role === 'assistant') {
    pushAssistantText(messages, text);
  }
}

/**
 * Append assistant text, merging into the previous assistant message when it is
 * the latest one. This keeps tool annotations within their owning assistant turn
 * (preserving user/assistant alternation) instead of emitting consecutive
 * assistant messages that some providers reject.
 */
function pushAssistantText(messages: Message[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    last.content = [...last.content, { type: 'text', text }];
    return;
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
}

function toolCallMessageFromEntry(entry: SessionEntryRecord, toolCallId: string): Message {
  const data = entryData(entry);
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: toolCallId,
      name: entryToolName(entry),
      arguments: shrinkJsonForHistory(data?.input ?? parseMaybeJson(entry.content)),
    }],
  };
}

function syntheticToolCallMessageFromResult(entry: SessionEntryRecord, toolCallId: string): Message {
  const data = entryData(entry);
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: toolCallId,
      name: entryToolName(entry),
      arguments: shrinkJsonForHistory(data?.input ?? {}),
    }],
  };
}

function toolResultMessageFromEntry(entry: SessionEntryRecord, toolCallId: string): Message {
  const payload = historicalToolResultPayload(entry, toolCallId);
  return {
    role: 'toolResult',
    toolCallId,
    toolName: payload.toolName,
    content: JSON.stringify(payload),
    isError: payload.isError,
  };
}

function historicalToolResultPayload(entry: SessionEntryRecord, toolCallId: string): {
  type: 'historical_tool_result';
  id: string;
  toolName: string;
  toolCallId: string;
  isError: boolean;
  truncated: boolean;
  preview: string;
  recovery: string;
} {
  const raw = entry.content?.trim() || safeStringify(entryData(entry)?.result);
  const trimmed = raw.trim();
  const preview = truncate(trimmed, TOOL_TRACE_MAX_CHARS);
  return {
    type: 'historical_tool_result',
    id: entry.id,
    toolName: entryToolName(entry),
    toolCallId,
    isError: entryIsError(entry),
    truncated: preview !== trimmed,
    preview,
    recovery: 'Use readMessage with this id to recover the full historical entry.',
  };
}

function entryData(entry: SessionEntryRecord): Record<string, unknown> | undefined {
  return entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : undefined;
}

function stableToolCallId(entry: SessionEntryRecord): string | undefined {
  if (entry.toolCallId?.trim()) {
    return entry.toolCallId.trim();
  }
  const value = entryData(entry)?.toolCallId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function entryToolName(entry: SessionEntryRecord): string {
  const data = entryData(entry);
  return stringField(data, 'toolName') ?? stringField(data, 'toolId') ?? 'tool';
}

function entryIsError(entry: SessionEntryRecord): boolean {
  const data = entryData(entry);
  return Boolean(data?.isError) || Boolean(data?.error);
}

function parseMaybeJson(value: string | undefined): unknown {
  if (!value?.trim()) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function shrinkJsonForHistory(value: unknown): unknown {
  const raw = safeStringify(value);
  if (raw.length <= TOOL_TRACE_MAX_CHARS) {
    return value;
  }
  return {
    __truncated: true,
    preview: truncate(raw, TOOL_TRACE_MAX_CHARS),
    recovery: 'Use readMessage with the related history id to recover full historical arguments if needed.',
  };
}

function historicalToolNote(entry: SessionEntryRecord, reason: string): string {
  return `[historical tool trace omitted] id=${entry.id} tool=${entryToolName(entry)} reason=${reason} recovery=Use readMessage with this id if full details are needed.`;
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

import type { ActorContext } from './actor.js';

/**
 * L1 trigger layer contract. Every trigger surface (web, cli, scheduled tasks,
 * IM gateways) normalizes its native input into this single envelope before it
 * reaches the L2 conversation layer. It replaces the previous ad-hoc spread of
 * `source` / `conversationId` / `actor` arguments.
 */
export type InboundChannel = 'web' | 'cli' | 'api' | 'feishu' | (string & {});

export type InboundKind = 'user' | 'schedule' | 'im';

export type InboundImageAttachment = {
  id: string;
  kind: 'image';
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  /** Base64 payload without the data URL prefix. */
  data: string;
};

export type InboundDisplayImageAttachment = {
  id: string;
  kind: 'image';
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  /** Display-safe thumbnail only. Do not use this as model input. */
  thumbnailDataUrl: string;
  /** Larger display-safe preview. Do not use this as model input. */
  previewDataUrl: string;
};

export type InboundMessage = {
  /** Channel the message originated from. Part of the conversation identity. */
  channel: InboundChannel;
  /** Stable per-channel conversation id (e.g. Feishu chat_id). */
  conversationId: string;
  /** Trigger type, drives default history policy. */
  kind: InboundKind;
  /** The single new user message text. */
  text: string;
  /** Current-turn attachments. Durable history loaders should not replay full bytes unless explicitly designed to. */
  attachments?: InboundImageAttachment[];
  /** Display metadata for durable UI history. This is never sent to the model. */
  displayAttachments?: InboundDisplayImageAttachment[];
  /** Resolved actor for memory/permission isolation. */
  actor?: ActorContext;
  /** Platform reply context (e.g. Feishu message_id to reply to). */
  replyTo?: string;
  metadata?: Record<string, unknown>;
};

/**
 * History loading policy for the L2 conversation layer.
 * - `store`: server loads prior turns by conversationId (IM / CLI target state)
 * - `none`: run without any prior history (scheduled tasks, cleanest)
 * - `caller`: the trigger supplies the full transcript (legacy web client-owned
 *   history). Transitional; prefer `store`. When set, the caller's `messages`
 *   are used as-is and the new turn is NOT appended again.
 */
export type HistorySource = 'store' | 'none' | 'caller';

/** Result of an outbound platform send. */
export type SendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

/** Conversation identity = (channel, conversationId) -> thread. */
export function threadIdOf(channel: string, conversationId: string): string {
  return `${channel}:${conversationId}`;
}

/** Main session id derived from the conversation identity. */
export function mainSessionIdOf(channel: string, conversationId: string): string {
  return `${threadIdOf(channel, conversationId)}:main`;
}

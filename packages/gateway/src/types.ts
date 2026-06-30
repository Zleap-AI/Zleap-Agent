import type { SendResult } from '@zleap/core';

export type ChatType = 'p2p' | 'group' | 'unknown';

/** Normalized inbound platform message (adapter -> runner). */
export type PlatformMessageEvent = {
  /** Channel id, e.g. 'feishu'. */
  channel: string;
  /** Stable per-channel conversation id (Feishu chat_id). */
  conversationId: string;
  chatType: ChatType;
  /** Extracted plain text of the message. */
  text: string;
  /** Platform sender id (Feishu open_id). */
  userId?: string;
  /** Platform tenant id (Feishu tenant_key) for multi-tenant memory/permission scoping. */
  tenantId?: string;
  /** Platform message id (used for reply context + dedup fallback). */
  messageId?: string;
  /** Platform event id (preferred dedup key). */
  eventId?: string;
  /** Whether the bot was @-mentioned (drives group gating). */
  mentionsBot?: boolean;
  raw?: unknown;
};

/** Outbound delivery target. Structurally compatible with the L2 sender. */
export type OutboundTarget = {
  channel: string;
  conversationId: string;
  replyTo?: string;
};

export type MessageHandler = (event: PlatformMessageEvent) => Promise<void>;

/** A platform adapter: translates platform events <-> the normalized contract. */
export interface PlatformAdapter {
  readonly channel: string;
  setMessageHandler(handler: MessageHandler): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(target: OutboundTarget, content: string): Promise<SendResult>;
  /** Best-effort inbound acknowledgement (e.g. a reaction emoji). */
  ack?(event: PlatformMessageEvent): Promise<void>;
  /**
   * Restart the interactive login without a full detach: regenerate a QR
   * (WeChat), re-issue an OAuth device code (Feishu CLI), or reconnect the WS
   * (Feishu node-sdk). Driven by a `refresh` control command.
   */
  reauth?(): Promise<void>;
  /** Drop stored credentials and return to a disconnected state. */
  logout?(): Promise<void>;
}

export type GatewayLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

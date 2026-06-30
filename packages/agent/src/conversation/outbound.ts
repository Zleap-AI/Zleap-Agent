import type { SendResult } from '@zleap/core';

export type OutboundTarget = {
  channel: string;
  conversationId: string;
  /** Optional platform reply context (e.g. a message id to reply under). */
  replyTo?: string;
};

/**
 * A channel-specific outbound sender. Sending only needs the platform REST
 * client, so it never contends with an inbound WebSocket lock. Both the gateway
 * process and (optionally) the task worker can register one.
 */
export type OutboundSender = (target: OutboundTarget, content: string) => Promise<SendResult>;

export class OutboundSenderRegistry {
  private readonly senders = new Map<string, OutboundSender>();

  register(channel: string, sender: OutboundSender): void {
    this.senders.set(channel, sender);
  }

  /** Drop a channel's sender (e.g. when the gateway detaches an adapter). */
  unregister(channel: string): void {
    this.senders.delete(channel);
  }

  get(channel: string): OutboundSender | undefined {
    return this.senders.get(channel);
  }

  has(channel: string): boolean {
    return this.senders.has(channel);
  }
}

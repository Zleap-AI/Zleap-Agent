import type { SendResult } from '@zleap/core';
import type { MessageHandler, OutboundTarget, PlatformAdapter, PlatformMessageEvent } from '../types.js';

/** Outbound size limits, mirrored from hermes feish.py. */
export const MAX_MESSAGE_LENGTH = 8000;
export const SPLIT_THRESHOLD = 4000;
export const SEND_ATTEMPTS = 3;

/**
 * Shared adapter scaffolding. Concrete platform adapters implement the raw
 * connect/disconnect/send/ack; the base provides retry, code-block-aware
 * splitting, and message-handler plumbing for free.
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly channel: string;
  protected handler: MessageHandler | undefined;

  setMessageHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(target: OutboundTarget, content: string): Promise<SendResult>;

  /** Dispatch a normalized event to the registered handler (best-effort). */
  protected async dispatch(event: PlatformMessageEvent): Promise<void> {
    if (!this.handler) {
      return;
    }
    await this.handler(event);
  }

  /** Split a long message at safe boundaries, never inside a fenced code block. */
  protected splitMessage(content: string, threshold = SPLIT_THRESHOLD): string[] {
    if (content.length <= threshold) {
      return [content];
    }
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > threshold) {
      let cut = safeCut(remaining, threshold);
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) {
      chunks.push(remaining);
    }
    return chunks;
  }

  /** Run an async send with exponential backoff. */
  protected async withRetry<T>(fn: () => Promise<T>, attempts = SEND_ATTEMPTS): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (i < attempts - 1) {
          await delay(2 ** i * 200);
        }
      }
    }
    throw lastError;
  }
}

/**
 * Pick a cut point at/under `threshold` that does not break a fenced code block:
 * if the prefix has an odd number of ``` fences, back up to the last fence start.
 * Falls back to the last newline, then a hard cut.
 */
function safeCut(text: string, threshold: number): number {
  const window = text.slice(0, threshold);
  const fences = window.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) {
    const lastFence = window.lastIndexOf('```');
    if (lastFence > 0) {
      return lastFence;
    }
  }
  const lastNewline = window.lastIndexOf('\n');
  return lastNewline > threshold * 0.5 ? lastNewline + 1 : threshold;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

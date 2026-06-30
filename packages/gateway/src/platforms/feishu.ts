import * as Lark from '@larksuiteoapi/node-sdk';
import type { SendResult } from '@zleap/core';
import type { ChannelStatePublisher } from '@zleap/agent/conversation';
import type { FeishuConfig } from '../config.js';
import type { FileDedupStore } from '../dedup.js';
import type { GatewayLogger, OutboundTarget, PlatformMessageEvent } from '../types.js';
import { BasePlatformAdapter } from './base.js';
import { acceptGroupMessage, extractText, mentionsBot } from './feishu/normalize.js';

export const FEISHU_CHANNEL = 'feishu';
/** Reaction used to acknowledge receipt (mirrors hermes). */
const ACK_EMOJI = 'OK';
/** Markdown hint: headings, bold, lists, code, links, blockquote, tables. */
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|\*\*|`|\[[^\]]+\]\([^)]+\)/;

type FeishuAdapterOptions = {
  dedup?: FileDedupStore;
  logger?: GatewayLogger;
  /** Publishes the unified connection state the web/CLI render. */
  publishState?: ChannelStatePublisher;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type LarkEvent = any;

export class FeishuAdapter extends BasePlatformAdapter {
  readonly channel = FEISHU_CHANNEL;
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private readonly dedup?: FileDedupStore;
  private readonly logger?: GatewayLogger;
  private readonly publishState?: ChannelStatePublisher;

  constructor(private readonly config: FeishuConfig, options: FeishuAdapterOptions = {}) {
    super();
    this.dedup = options.dedup;
    this.logger = options.logger;
    this.publishState = options.publishState;
    this.client = this.buildClient();
    this.wsClient = this.buildWsClient();
  }

  private get larkBase() {
    const domain = this.config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    return { appId: this.config.appId, appSecret: this.config.appSecret, domain };
  }

  private buildClient(): Lark.Client {
    // Default to warn; set FEISHU_SDK_LOG_LEVEL=debug to surface the SDK's raw
    // socket/frame logs when diagnosing "no events arriving" issues.
    return new Lark.Client({ ...this.larkBase, loggerLevel: resolveLarkLogLevel(process.env.FEISHU_SDK_LOG_LEVEL) });
  }

  private buildWsClient(): Lark.WSClient {
    return new Lark.WSClient({ ...this.larkBase, loggerLevel: resolveLarkLogLevel(process.env.FEISHU_SDK_LOG_LEVEL) });
  }

  async connect(): Promise<void> {
    await this.dedup?.load();
    await this.startWs();
  }

  private async startWs(): Promise<void> {
    await this.publish({ phase: 'connecting' });
    const dispatcher = new Lark.EventDispatcher({
      ...(this.config.encryptKey ? { encryptKey: this.config.encryptKey } : {}),
      ...(this.config.verificationToken ? { verificationToken: this.config.verificationToken } : {}),
    }).register({
      'im.message.receive_v1': async (data: LarkEvent) => {
        await this.onMessage(data).catch((error) => {
          this.logger?.error('feishu inbound handler failed', { error: errorMessage(error) });
        });
      },
    });
    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      await this.publish({ phase: 'connected' });
      this.logger?.info('feishu adapter connected', { domain: this.config.domain });
    } catch (error) {
      await this.publish({ phase: 'error', error: errorMessage(error) });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.dedup?.persist();
    // The WSClient manages its own socket lifecycle; there is no public stop in
    // the SDK, so process exit tears the connection down.
  }

  /** Reconnect the long-lived event WebSocket (no interactive login for node-sdk). */
  async reauth(): Promise<void> {
    this.client = this.buildClient();
    this.wsClient = this.buildWsClient();
    await this.startWs();
  }

  private async publish(patch: { phase: 'connecting' | 'connected' | 'error'; error?: string }): Promise<void> {
    if (!this.publishState) {
      return;
    }
    await this.publishState(patch).catch(() => undefined);
  }

  async ack(event: PlatformMessageEvent): Promise<void> {
    if (!event.messageId) {
      return;
    }
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: event.messageId },
        data: { reaction_type: { emoji_type: ACK_EMOJI } },
      });
    } catch {
      // Reactions are best-effort; never block the reply on an ACK failure.
    }
  }

  async send(target: OutboundTarget, content: string): Promise<SendResult> {
    const text = content.trim();
    if (!text) {
      return { ok: true };
    }
    const chunks = this.splitMessage(text);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const result = await this.sendChunk(target.conversationId, chunk);
      if (!result.ok) {
        return result;
      }
      lastId = result.messageId;
    }
    return { ok: true, ...(lastId ? { messageId: lastId } : {}) };
  }

  private async sendChunk(chatId: string, text: string): Promise<SendResult> {
    const rich = MARKDOWN_HINT.test(text);
    if (rich) {
      try {
        return await this.withRetry(() => this.createMessage(chatId, 'interactive', cardContent(text)));
      } catch (error) {
        this.logger?.warn('feishu card send failed, falling back to text', { error: errorMessage(error) });
      }
    }
    try {
      return await this.withRetry(() => this.createMessage(chatId, 'text', JSON.stringify({ text })));
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private async createMessage(chatId: string, msgType: string, content: string): Promise<SendResult> {
    const res: LarkEvent = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content },
    });
    const code = res?.code;
    if (typeof code === 'number' && code !== 0) {
      throw new Error(`feishu_send_code_${code}:${res?.msg ?? ''}`);
    }
    return { ok: true, ...(res?.data?.message_id ? { messageId: res.data.message_id } : {}) };
  }

  private async onMessage(data: LarkEvent): Promise<void> {
    const message = data?.message;
    const chatId: string | undefined = message?.chat_id;
    const messageId: string | undefined = message?.message_id;
    this.logger?.info('feishu message received', {
      chatType: message?.chat_type,
      messageType: message?.message_type,
      ...(chatId ? { chatId } : {}),
      ...(messageId ? { messageId } : {}),
      senderType: data?.sender?.sender_type,
    });
    if (!chatId || !messageId) {
      this.logger?.warn('feishu message dropped: missing chat_id/message_id');
      return;
    }
    const eventId: string | undefined = data?.event_id ?? data?.header?.event_id;
    const dedupKey = eventId ?? messageId;
    if (this.dedup?.isDuplicate(dedupKey)) {
      this.logger?.info('feishu message dropped: duplicate', { dedupKey });
      return;
    }

    const senderOpenId: string | undefined = data?.sender?.sender_id?.open_id;
    const senderType: string | undefined = data?.sender?.sender_type;
    if (this.isFromBot(senderOpenId, senderType)) {
      this.logger?.info('feishu message dropped: from bot/app', { senderType });
      return;
    }

    const chatType = message?.chat_type === 'p2p' ? 'p2p' : message?.chat_type === 'group' ? 'group' : 'unknown';
    const mentioned = mentionsBot(message, { botOpenId: this.config.botOpenId, botName: this.config.botName });
    const text = extractText(message);
    const tenantId: string | undefined = data?.header?.tenant_key;

    const event: PlatformMessageEvent = {
      channel: this.channel,
      conversationId: chatId,
      chatType,
      text,
      ...(senderOpenId ? { userId: senderOpenId } : {}),
      ...(tenantId ? { tenantId } : {}),
      messageId,
      ...(eventId ? { eventId } : {}),
      mentionsBot: mentioned,
      raw: data,
    };

    if (
      chatType === 'group' &&
      !acceptGroupMessage(event, { groupPolicy: this.config.groupPolicy, allowedUsers: this.config.allowedUsers })
    ) {
      this.logger?.info('feishu message dropped: group not accepted', {
        groupPolicy: this.config.groupPolicy,
        mentionsBot: mentioned,
      });
      return;
    }
    if (!text.trim()) {
      this.logger?.info('feishu message dropped: empty/unsupported content', {
        messageType: message?.message_type,
      });
      return;
    }
    this.logger?.info('feishu message dispatching', { chatType, chars: text.length });
    await this.dispatch(event);
  }

  private isFromBot(senderOpenId?: string, senderType?: string): boolean {
    if (senderType && senderType !== 'user') {
      return true;
    }
    return Boolean(this.config.botOpenId && senderOpenId === this.config.botOpenId);
  }
}

function cardContent(text: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: text }],
  });
}

function resolveLarkLogLevel(raw: string | undefined): Lark.LoggerLevel {
  switch (raw?.trim().toLowerCase()) {
    case 'trace':
      return Lark.LoggerLevel.trace;
    case 'debug':
      return Lark.LoggerLevel.debug;
    case 'info':
      return Lark.LoggerLevel.info;
    case 'error':
      return Lark.LoggerLevel.error;
    case 'warn':
    default:
      return Lark.LoggerLevel.warn;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

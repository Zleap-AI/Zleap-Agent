import QRCode from 'qrcode';
import type { SendResult } from '@zleap/core';
import type { ChannelStatePublisher } from '@zleap/agent/conversation';
import type { WeChatConfig } from '../../config.js';
import type { FileDedupStore } from '../../dedup.js';
import type { ChatType, GatewayLogger, OutboundTarget, PlatformMessageEvent } from '../../types.js';
import { BasePlatformAdapter } from '../base.js';
import {
  ILinkClient,
  ILinkError,
  WX_MESSAGE_TYPE_USER,
  extractText,
  messageDedupKey,
  type QrCodeResult,
  type WeixinMessage,
} from './ilink.js';
import { MemoryWeChatSessionStore, type WeChatSessionStore } from './session.js';

export const WECHAT_CHANNEL = 'wechat';

/** Backoff bounds for the long-poll loop when getupdates fails transiently. */
const POLL_BACKOFF_MIN_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;
/** Delay between QR scan-status polls. */
const QR_POLL_INTERVAL_MS = 2_000;
/** Typing keepalive while the agent runs (prevents context_token expiry on long replies). */
const TYPING_KEEPALIVE_MS = 5_000;

type WeChatAdapterOptions = {
  sessionStore?: WeChatSessionStore;
  client?: ILinkClient;
  dedup?: FileDedupStore;
  logger?: GatewayLogger;
  /** Publishes the unified connection state the web/CLI render. */
  publishState?: ChannelStatePublisher;
};

/** Cached reply routing for one inbound message (keyed by messageId / replyTo). */
type ReplyContext = {
  toUserId: string;
  groupId?: string;
  contextToken?: string;
  typingTicket?: string;
  keepaliveTimer?: ReturnType<typeof setInterval>;
};

/**
 * WeChat adapter over Tencent's iLink Bot protocol. Symmetric with the Feishu
 * adapter: a scan-to-login handshake replaces the WSClient handshake, then a
 * long-poll loop pulls inbound messages and replies are POSTed back. Group chats
 * are native (`group_id`) and map to the shared group-conversation owner model.
 */
export class WeChatAdapter extends BasePlatformAdapter {
  readonly channel = WECHAT_CHANNEL;
  private readonly client: ILinkClient;
  private readonly sessionStore: WeChatSessionStore;
  private readonly dedup?: FileDedupStore;
  private readonly logger?: GatewayLogger;
  private readonly publishState?: ChannelStatePublisher;
  private readonly replyContext = new Map<string, ReplyContext>();

  private running = false;
  private updatesBuf = '';
  private pollTask: Promise<void> | undefined;
  /** In-memory signal (set by reauth/logout) to drop the token and re-scan. */
  private reloginRequested = false;

  constructor(private readonly config: WeChatConfig, options: WeChatAdapterOptions = {}) {
    super();
    this.sessionStore = options.sessionStore ?? new MemoryWeChatSessionStore();
    this.client =
      options.client ??
      new ILinkClient({
        baseUrl: config.baseUrl,
        botType: config.botType,
        channelVersion: config.channelVersion,
      });
    this.dedup = options.dedup;
    this.logger = options.logger;
    this.publishState = options.publishState;
  }

  async connect(): Promise<void> {
    await this.dedup?.load();
    // Mark running before login so the scan-status poll loop is active.
    this.running = true;
    const session = await this.sessionStore.load();
    this.updatesBuf = session.updatesBuf ?? '';
    if (session.botToken) {
      this.client.setBaseUrl(session.baseUrl);
      this.client.setBotToken(session.botToken);
      await this.publish({ phase: 'connected' });
      this.logger?.info('wechat adapter restored session', { baseUrl: session.baseUrl });
    }
    // No token (or a future relogin) → the loop runs the scan handshake first.
    this.pollTask = this.pollLoop();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    await this.pollTask?.catch(() => undefined);
    await this.sessionStore.save({ updatesBuf: this.updatesBuf }).catch(() => undefined);
    await this.dedup?.persist();
  }

  /** Drop the current token and force a fresh QR (refresh / switch account). */
  async reauth(): Promise<void> {
    this.reloginRequested = true;
    this.client.setBotToken(undefined);
    // Keep the current QR visible in the web panel until refreshQr publishes the
    // replacement — publishing `connecting` here wipes prompt from the DB row.
  }

  /** Clear stored credentials, then re-run the scan handshake. */
  async logout(): Promise<void> {
    await this.sessionStore.clear().catch(() => undefined);
    this.updatesBuf = '';
    await this.reauth();
  }

  async ack(event: PlatformMessageEvent): Promise<void> {
    const ctx = this.lookupContext(event);
    const toUserId = ctx?.toUserId ?? event.userId;
    if (!toUserId || !ctx?.typingTicket) {
      return;
    }
    try {
      await this.client.sendTyping({
        ilinkUserId: toUserId,
        typingTicket: ctx.typingTicket,
        status: 1,
      });
      if (ctx.keepaliveTimer) {
        clearInterval(ctx.keepaliveTimer);
      }
      const key = contextKey(event);
      ctx.keepaliveTimer = setInterval(() => {
        void this.client
          .sendTyping({ ilinkUserId: toUserId, typingTicket: ctx.typingTicket!, status: 1 })
          .catch(() => undefined);
      }, TYPING_KEEPALIVE_MS);
      ctx.keepaliveTimer.unref?.();
      this.replyContext.set(key, ctx);
    } catch {
      // Typing indicator is best-effort; never block the reply on it.
    }
  }

  async send(target: OutboundTarget, content: string): Promise<SendResult> {
    const text = content.trim();
    if (!text) {
      return { ok: true };
    }
    const key = target.replyTo ?? target.conversationId;
    const ctx = this.replyContext.get(key);
    this.stopTypingKeepalive(key, ctx);
    const toUserId = ctx?.toUserId ?? target.conversationId;
    if (!ctx?.contextToken) {
      // Without the inbound context_token the reply may not bind to the window
      // (e.g. proactive push, or a restart that lost the in-memory cache).
      this.logger?.warn('wechat send without context_token', { conversationId: target.conversationId, replyTo: target.replyTo });
    }
    const chunks = this.splitMessage(text);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      try {
        const result = await this.withRetry(() =>
          this.client.sendMessage({
            toUserId,
            text: chunk,
            ...(ctx?.groupId ? { groupId: ctx.groupId } : {}),
            ...(ctx?.contextToken ? { contextToken: ctx.contextToken } : {}),
          }),
        );
        lastId = result.messageId ?? lastId;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    this.replyContext.delete(key);
    this.logger?.info('wechat reply sent', {
      conversationId: target.conversationId,
      replyTo: target.replyTo,
      chunks: chunks.length,
      chars: text.length,
    });
    return { ok: true, ...(lastId ? { messageId: lastId } : {}) };
  }

  /**
   * Run the QR login handshake and persist the resulting token. Publishes the QR
   * as an `awaiting_user` prompt, regenerating it in place when it expires, until
   * confirmed or the adapter is stopped.
   */
  private async login(): Promise<void> {
    let qrcode = await this.refreshQr();
    this.logger?.info('wechat awaiting QR scan');
    while (this.running) {
      // Honor a refresh requested mid-scan: regenerate the QR immediately.
      if (this.reloginRequested) {
        this.reloginRequested = false;
        this.logger?.info('wechat QR refresh requested, regenerating');
        qrcode = await this.refreshQr();
      }
      let status;
      try {
        status = await this.client.getQrcodeStatus(qrcode);
      } catch (error) {
        // A transient status-poll timeout/abort must not invalidate the QR the
        // user is mid-scan; treat it as "still pending" and retry the same code.
        this.logger?.warn('wechat QR status poll failed, retrying', { error: errorMessage(error) });
        await delay(QR_POLL_INTERVAL_MS);
        continue;
      }
      if (status.status === 'confirmed' && status.botToken) {
        this.client.setBaseUrl(status.baseUrl);
        this.client.setBotToken(status.botToken);
        // New token invalidates the old long-poll cursor — start fresh like official client.
        this.updatesBuf = '';
        await this.sessionStore.save({ botToken: status.botToken, baseUrl: status.baseUrl, updatesBuf: '' });
        await this.publish({ phase: 'connected' });
        this.logger?.info('wechat login confirmed', { baseUrl: status.baseUrl });
        return;
      }
      if (status.status === 'expired' || status.status === 'canceled') {
        this.logger?.warn('wechat QR expired/canceled, regenerating', { status: status.status });
        qrcode = await this.refreshQr();
      }
      await delay(QR_POLL_INTERVAL_MS);
    }
  }

  /** Fetch a fresh QR, render it to a displayable image, publish it, return the poll id. */
  private async refreshQr(): Promise<string> {
    const res = await this.client.getBotQrcode();
    await this.publishQr(await this.renderQrImage(res));
    return res.qrcode;
  }

  /**
   * Normalize the iLink QR response into a renderable data URL so the web/CLI
   * stay thin. iLink may return either pre-rendered image bytes or a bare login
   * deep-link (sometimes in `qrcode_img_content`), so classify by shape: a data
   * URL passes through, an http(s) login link is encoded into a QR PNG here in
   * the gateway, and raw bytes are wrapped as a base64 PNG.
   */
  private async renderQrImage(res: QrCodeResult): Promise<string | undefined> {
    const candidate = res.qrImage ?? res.qrUrl;
    if (!candidate) {
      return undefined;
    }
    if (candidate.startsWith('data:')) {
      return candidate;
    }
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      try {
        return await QRCode.toDataURL(candidate, { margin: 1, width: 320 });
      } catch (error) {
        this.logger?.warn('wechat QR encode failed', { error: errorMessage(error) });
        return undefined;
      }
    }
    return `data:image/png;base64,${candidate}`;
  }

  private async pollLoop(): Promise<void> {
    let backoff = POLL_BACKOFF_MIN_MS;
    while (this.running) {
      // No token, or a refresh/logout requested re-login: run the scan handshake.
      if (this.reloginRequested || !this.client.hasToken()) {
        this.reloginRequested = false;
        this.client.setBotToken(undefined);
        await this.login().catch((loginError) => {
          this.logger?.error('wechat login failed', { error: errorMessage(loginError) });
        });
        backoff = POLL_BACKOFF_MIN_MS;
        continue;
      }
      try {
        const { msgs, updatesBuf } = await this.client.getUpdates(this.updatesBuf);
        if (updatesBuf && updatesBuf !== this.updatesBuf) {
          this.updatesBuf = updatesBuf;
          void this.sessionStore.save({ updatesBuf }).catch(() => undefined);
        }
        for (const msg of msgs) {
          // Do not await — keep long-polling while the agent runs; each message
          // carries its own reply routing keyed by messageId (see onMessage).
          void this.onMessage(msg).catch((error) => {
            this.logger?.error('wechat inbound handler failed', { error: errorMessage(error) });
          });
        }
        backoff = POLL_BACKOFF_MIN_MS;
      } catch (error) {
        if (error instanceof ILinkError && error.authFailed) {
          this.logger?.warn('wechat token expired, re-login required');
          await this.sessionStore.save({ botToken: undefined }).catch(() => undefined);
          this.client.setBotToken(undefined);
          // Next loop iteration sees no token and re-runs the scan handshake.
          continue;
        }
        this.logger?.warn('wechat getupdates failed, backing off', { error: errorMessage(error), backoffMs: backoff });
        await delay(backoff);
        backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS);
      }
    }
  }

  private async publish(patch: { phase: 'connecting' | 'awaiting_user' | 'connected' | 'error'; prompt?: { kind: 'qr'; image: string } }): Promise<void> {
    if (!this.publishState) {
      return;
    }
    await this.publishState(patch).catch(() => undefined);
  }

  private async publishQr(qrImage?: string): Promise<void> {
    await this.publish({ phase: 'awaiting_user', ...(qrImage ? { prompt: { kind: 'qr', image: qrImage } } : {}) });
  }

  private async onMessage(message: WeixinMessage): Promise<void> {
    // Only inbound user messages (type 1); skip bot echoes / system frames.
    if (typeof message.message_type === 'number' && message.message_type !== WX_MESSAGE_TYPE_USER) {
      return;
    }
    const fromUserId = strField(message.from_user_id);
    if (!fromUserId) {
      this.logger?.warn('wechat message dropped: missing from_user_id');
      return;
    }
    const groupId = strField(message.group_id);
    const chatType: ChatType = groupId ? 'group' : 'p2p';
    const conversationId = groupId ?? fromUserId;
    const contextToken = strField(message.context_token);
    const text = extractText(message);
    const messageKey =
      messageDedupKey(message) ??
      `local:${strField(message.create_time) ?? '0'}:${fromUserId}:${text.length}:${contextToken?.slice(0, 12) ?? 'noctx'}`;

    // Capture reply routing before any early return so ack() can use it too.
    const replyCtx: ReplyContext = {
      toUserId: fromUserId,
      ...(groupId ? { groupId } : {}),
      ...(contextToken ? { contextToken } : {}),
    };
    if (contextToken) {
      try {
        const config = await this.client.getConfig({ ilinkUserId: fromUserId, contextToken });
        if (config.typingTicket) {
          replyCtx.typingTicket = config.typingTicket;
        }
      } catch {
        // getconfig is best-effort; replies still work without typing keepalive.
      }
    }
    this.replyContext.set(messageKey, replyCtx);

    const dedupKey = messageDedupKey(message);
    if (dedupKey && this.dedup?.isDuplicate(dedupKey)) {
      this.logger?.info('wechat message dropped: duplicate', { dedupKey });
      return;
    }

    this.logger?.info('wechat message received', {
      chatType,
      conversationId,
      messageKey,
      hasContextToken: Boolean(contextToken),
      chars: text.length,
    });

    const event: PlatformMessageEvent = {
      channel: this.channel,
      conversationId,
      chatType,
      text,
      userId: fromUserId,
      // iLink only routes group messages addressed to the bot, so treat delivery
      // as an implicit mention (policy/allowlist still gate below).
      mentionsBot: true,
      messageId: messageKey,
      raw: message,
    };

    if (chatType === 'group' && !this.acceptGroupMessage(event)) {
      this.logger?.info('wechat message dropped: group not accepted', { groupPolicy: this.config.groupPolicy });
      this.replyContext.delete(messageKey);
      return;
    }
    if (!text.trim()) {
      this.logger?.info('wechat message dropped: empty/unsupported content');
      this.replyContext.delete(messageKey);
      return;
    }
    await this.dispatch(event);
  }

  private lookupContext(event: PlatformMessageEvent): ReplyContext | undefined {
    return this.replyContext.get(contextKey(event));
  }

  private stopTypingKeepalive(key: string, ctx: ReplyContext | undefined): void {
    if (!ctx?.keepaliveTimer) {
      return;
    }
    clearInterval(ctx.keepaliveTimer);
    ctx.keepaliveTimer = undefined;
    this.replyContext.set(key, ctx);
    if (ctx.typingTicket && ctx.toUserId) {
      void this.client
        .sendTyping({ ilinkUserId: ctx.toUserId, typingTicket: ctx.typingTicket, status: 2 })
        .catch(() => undefined);
    }
  }

  private acceptGroupMessage(event: PlatformMessageEvent): boolean {
    const { groupPolicy, allowedUsers } = this.config;
    if (groupPolicy === 'disabled') {
      return false;
    }
    if (!event.mentionsBot) {
      return false;
    }
    const userId = event.userId ?? '';
    switch (groupPolicy) {
      case 'allowlist':
        return allowedUsers.includes(userId);
      case 'blacklist':
        return !allowedUsers.includes(userId);
      case 'admin_only':
      case 'open':
      default:
        return true;
    }
  }
}

function contextKey(event: PlatformMessageEvent): string {
  return event.messageId ?? event.conversationId;
}

function strField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { SendResult } from '@zleap/core';
import type { ChannelStatePublisher } from '@zleap/agent/conversation';
import type { FeishuCliConfig } from '../../config.js';
import type { FileDedupStore } from '../../dedup.js';
import type { ChatType, GatewayLogger, OutboundTarget, PlatformMessageEvent } from '../../types.js';
import { BasePlatformAdapter } from '../base.js';
import { acceptGroupMessage, extractText, mentionsBot } from '../feishu/normalize.js';
import { LarkCliClient, type EventStreamHandle } from './cli.js';

export const FEISHU_CLI_CHANNEL = 'feishu-cli';

/** Markdown hint: headings, bold, lists, code, links, blockquote, tables. */
const MARKDOWN_HINT = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|\*\*|`|\[[^\]]+\]\([^)]+\)/;

/** Auth poll cadence and consume-stream reconnection backoff. */
const AUTH_POLL_INTERVAL_MS = 3_000;
/** Re-begin device login after this many polls (~5min) to refresh an expiring URL. */
const AUTH_REFRESH_EVERY = 100;
const CONSUME_BACKOFF_MIN_MS = 1_000;
const CONSUME_BACKOFF_MAX_MS = 30_000;

type FeishuCliAdapterOptions = {
  client?: LarkCliClient;
  dedup?: FileDedupStore;
  logger?: GatewayLogger;
  /** Publishes the unified connection state the web/CLI render. */
  publishState?: ChannelStatePublisher;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type CliEvent = any;

/**
 * Second Feishu access method: drives the official `@larksuite/cli` as a
 * subprocess. Inbound = a long-lived `event +subscribe` WebSocket NDJSON stream
 * (bot identity, App ID/Secret); outbound = `im +messages-send`. `bot` identity
 * only needs `config init`; `user` identity additionally runs the OAuth device
 * flow (token owned by lark-cli under an isolated HOME). Shares Feishu
 * normalization/group-gating with the node-sdk adapter.
 */
export class FeishuCliAdapter extends BasePlatformAdapter {
  readonly channel = FEISHU_CLI_CHANNEL;
  private readonly client: LarkCliClient;
  private readonly dedup?: FileDedupStore;
  private readonly logger?: GatewayLogger;
  private readonly publishState?: ChannelStatePublisher;

  private running = false;
  private stream: EventStreamHandle | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** In-memory signal (set by reauth) to re-run the auth handshake. */
  private reauthRequested = false;
  /** True while the user-identity device-flow poll loop is active. */
  private authLoopActive = false;

  constructor(private readonly config: FeishuCliConfig, options: FeishuCliAdapterOptions = {}) {
    super();
    this.client =
      options.client ??
      new LarkCliClient({
        ...(config.cliBin ? { bin: config.cliBin } : {}),
        ...(config.cliHome ? { home: config.cliHome } : {}),
        brand: config.domain,
      });
    this.dedup = options.dedup;
    this.logger = options.logger;
    this.publishState = options.publishState;
  }

  async connect(): Promise<void> {
    await this.dedup?.load();
    this.running = true;
    // Run the (possibly long, for user device-flow) handshake in the background so
    // the supervisor's attach never blocks on a pending authorization.
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const ready = await this.ensureReady();
      if (!ready) {
        this.logger?.warn('feishu-cli not ready; channel idle until configured/authorized');
        return;
      }
      this.startSubscribe();
    } catch (error) {
      // Never let a CLI failure (e.g. lark-cli not installed) crash the gateway
      // and take down the other channels; degrade to an idle channel instead.
      this.logger?.error('feishu-cli connect failed; channel idle', { error: errorMessage(error) });
      await this.publish({ phase: 'error', error: errorMessage(error) });
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stream?.stop();
    this.stream = undefined;
    await this.dedup?.persist();
  }

  /** Re-run the auth handshake (user: new device code; bot: re-verify config). */
  async reauth(): Promise<void> {
    this.reauthRequested = true;
    await this.publish({ phase: 'connecting' });
    // If an auth poll loop is already running, it will pick up the flag and
    // re-begin in place; otherwise restart the whole handshake.
    if (!this.authLoopActive) {
      this.stream?.stop();
      this.stream = undefined;
      this.running = true;
      void this.run();
    }
  }

  /** Sign out of lark-cli (clears the stored token) and re-run the handshake. */
  async logout(): Promise<void> {
    await this.client.logout().catch(() => undefined);
    await this.reauth();
  }

  async send(target: OutboundTarget, content: string): Promise<SendResult> {
    const text = content.trim();
    if (!text) {
      return { ok: true };
    }
    const chunks = this.splitMessage(text);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      try {
        const result = await this.withRetry(() =>
          this.client.sendMessage({
            chatId: target.conversationId,
            text: chunk,
            identity: this.config.identity,
            markdown: MARKDOWN_HINT.test(chunk),
          }),
        );
        lastId = result.messageId ?? lastId;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    return { ok: true, ...(lastId ? { messageId: lastId } : {}) };
  }

  /**
   * Bring the channel to a connected state. Inbound `event +subscribe` only needs
   * the app configured (App ID/Secret via `config init`). Outbound as `user` also
   * needs an OAuth device-flow token (surfacing the verification URL); `bot`
   * identity uses the app credentials directly and skips the device flow.
   */
  private async ensureReady(): Promise<boolean> {
    const cfg = await this.client.configStatus();
    if (!cfg.configured) {
      if (!this.config.appId || !this.config.appSecret) {
        this.logger?.error(
          'feishu-cli not configured: set App ID/Secret (web settings or FEISHU_CLI_APP_ID/SECRET), or run `lark-cli config init --new` once in the configured HOME',
        );
        await this.publish({ phase: 'error', error: 'not configured: missing App ID/Secret' });
        return false;
      }
      await this.publish({ phase: 'connecting' });
      const init = await this.client.initApp(this.config.appId, this.config.appSecret);
      if (init.code !== 0) {
        this.logger?.error('feishu-cli config init failed', { stderr: init.stderr.trim() || init.stdout.trim() });
        await this.publish({ phase: 'error', error: 'config init failed' });
        return false;
      }
    }

    // Bot identity: app credentials are enough to subscribe and send. No QR/URL.
    if (this.config.identity === 'bot') {
      this.reauthRequested = false;
      await this.publish({ phase: 'connected' });
      this.logger?.info('feishu-cli connected', { identity: 'bot' });
      return true;
    }

    // User identity: outbound as the user needs a device-flow token.
    let auth = await this.client.authStatus();
    if (!auth.authorized || this.reauthRequested) {
      this.authLoopActive = true;
      try {
        let login = await this.beginAuth();
        let polls = 0;
        this.reauthRequested = false;
        while (this.running && !auth.authorized) {
          await delay(AUTH_POLL_INTERVAL_MS);
          polls += 1;
          // Device codes expire, and reauth() asks for a fresh URL; re-begin so a
          // stale code never strands the channel (mirrors WeChat QR regeneration).
          if (this.reauthRequested || polls % AUTH_REFRESH_EVERY === 0) {
            this.reauthRequested = false;
            login = await this.beginAuth();
          }
          auth = login.deviceCode
            ? await this.client.pollDeviceLogin(login.deviceCode)
            : await this.client.authStatus();
        }
      } finally {
        this.authLoopActive = false;
      }
      if (!auth.authorized) {
        return false;
      }
    }
    await this.publish({ phase: 'connected', ...(auth.account ? { account: auth.account } : {}) });
    this.logger?.info('feishu-cli connected', { identity: 'user', ...(auth.account ? { account: auth.account } : {}) });
    return true;
  }

  /** Begin a device-flow login and surface the pending URL as a prompt. */
  private async beginAuth(): Promise<{ deviceCode?: string }> {
    const login = await this.client.beginDeviceLogin(this.config.identity);
    await this.publish({
      phase: 'awaiting_user',
      ...(login.verificationUrl
        ? { prompt: { kind: 'url', url: login.verificationUrl, ...(login.deviceCode ? { userCode: login.deviceCode } : {}) } }
        : {}),
    });
    this.logger?.info('feishu-cli awaiting OAuth authorization', {
      identity: this.config.identity,
      ...(login.verificationUrl ? { url: login.verificationUrl } : {}),
    });
    return { ...(login.deviceCode ? { deviceCode: login.deviceCode } : {}) };
  }

  /** Start (and keep alive) the inbound `event +subscribe` stream. */
  private startSubscribe(backoff = CONSUME_BACKOFF_MIN_MS): void {
    if (!this.running) {
      return;
    }
    this.logger?.info('feishu-cli subscribing events', { eventKey: this.config.eventKey });
    this.stream = this.client.subscribe(this.config.eventKey, {
      onLine: (line) => {
        void this.onLine(line).catch((error) => {
          this.logger?.error('feishu-cli inbound handler failed', { error: errorMessage(error) });
        });
      },
      onError: (error) => this.logger?.warn('feishu-cli event stream error', { error: errorMessage(error) }),
      onClose: (code) => {
        this.stream = undefined;
        if (!this.running) {
          return;
        }
        const next = Math.min(backoff * 2, CONSUME_BACKOFF_MAX_MS);
        this.logger?.warn('feishu-cli event stream closed, reconnecting', { code, backoffMs: backoff });
        this.reconnectTimer = setTimeout(() => this.startSubscribe(next), backoff);
        this.reconnectTimer.unref?.();
      },
    });
  }

  private async publish(patch: {
    phase: 'connecting' | 'awaiting_user' | 'connected' | 'error';
    prompt?: { kind: 'url'; url: string; userCode?: string };
    account?: string;
    error?: string;
  }): Promise<void> {
    if (!this.publishState) {
      return;
    }
    await this.publishState(patch).catch(() => undefined);
  }

  private async onLine(line: string): Promise<void> {
    let parsed: CliEvent;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON informational line; ignore.
      return;
    }
    const envelope = unwrapEvent(parsed);
    const message = envelope.message;
    const chatId: string | undefined = message?.chat_id;
    const messageId: string | undefined = message?.message_id;
    if (!chatId || !messageId) {
      return;
    }
    const eventId: string = envelope.header?.event_id ?? messageId;
    const dedupKey = eventId;
    if (this.dedup?.isDuplicate(dedupKey)) {
      this.logger?.info('feishu-cli message dropped: duplicate', { dedupKey });
      return;
    }

    const senderOpenId: string | undefined = envelope.sender?.sender_id?.open_id;
    const senderType: string | undefined = envelope.sender?.sender_type;
    if (this.isFromBot(senderOpenId, senderType)) {
      return;
    }

    const chatType: ChatType =
      message?.chat_type === 'p2p' ? 'p2p' : message?.chat_type === 'group' ? 'group' : 'unknown';
    const mentioned = mentionsBot(message, { botOpenId: this.config.botOpenId, botName: this.config.botName });
    const text = extractText(message);
    const tenantId: string | undefined = envelope.header?.tenant_key;

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
      raw: parsed,
    };

    if (
      chatType === 'group' &&
      !acceptGroupMessage(event, { groupPolicy: this.config.groupPolicy, allowedUsers: this.config.allowedUsers })
    ) {
      this.logger?.info('feishu-cli message dropped: group not accepted', { groupPolicy: this.config.groupPolicy });
      return;
    }
    if (!text.trim()) {
      return;
    }
    this.logger?.info('feishu-cli message dispatching', { chatType, chars: text.length });
    await this.dispatch(event);
  }

  private isFromBot(senderOpenId?: string, senderType?: string): boolean {
    if (senderType && senderType !== 'user') {
      return true;
    }
    return Boolean(this.config.botOpenId && senderOpenId === this.config.botOpenId);
  }
}

/** Locate the Feishu event payload regardless of how the CLI nests it. */
function unwrapEvent(parsed: CliEvent): { message?: CliEvent; sender?: CliEvent; header?: CliEvent } {
  // The CLI may emit the raw v2 event ({ header, event: { message, sender } }),
  // the inner event object directly, or a wrapper carrying it under data/payload.
  const candidates = [parsed?.event, parsed?.data?.event, parsed?.payload, parsed?.data, parsed];
  for (const candidate of candidates) {
    if (candidate && (candidate.message || candidate.sender)) {
      return { message: candidate.message, sender: candidate.sender, header: parsed?.header ?? candidate.header };
    }
  }
  return { message: parsed?.message, sender: parsed?.sender, header: parsed?.header };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { randomBytes } from 'node:crypto';

/**
 * Thin client for Tencent's official WeChat iLink Bot protocol
 * (`ilinkai.weixin.qq.com`, the "微信 ClawBot" feature). The protocol is plain
 * HTTP/JSON with a Telegram-style long-poll, so this client only needs `fetch`
 * — no third-party SDK. Symmetric with the Feishu adapter's WSClient: scan a QR
 * to log in, then long-poll for inbound messages and POST replies.
 *
 * Reference: https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md
 */

/** Official iLink Bot endpoint. */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** Default bot type observed in the official package (account/plan selector). */
export const DEFAULT_BOT_TYPE = 3;
/** `base_info.channel_version` sent on getupdates; mirrors the observed client. */
export const DEFAULT_CHANNEL_VERSION = '1.0.2';
/** Server holds getupdates up to 35s; allow headroom before aborting. */
export const LONG_POLL_TIMEOUT_MS = 60_000;
/** Timeout for non-long-poll calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Inbound user message (from the human). */
export const WX_MESSAGE_TYPE_USER = 1;
/** Outbound bot message (from us). */
export const WX_MESSAGE_TYPE_BOT = 2;
/** A complete (non-streamed) message. */
export const WX_MESSAGE_STATE_FINISH = 2;
/** item_list entry kinds. */
export const WX_ITEM_TEXT = 1;
export const WX_ITEM_IMAGE = 2;
export const WX_ITEM_VOICE = 3;
export const WX_ITEM_FILE = 4;
export const WX_ITEM_VIDEO = 5;

export type WeixinTextItem = { text?: string };

export type WeixinItem = {
  type: number;
  text_item?: WeixinTextItem;
  [key: string]: unknown;
};

/** A single inbound/outbound message in the iLink protocol. */
export type WeixinMessage = {
  from_user_id?: string;
  to_user_id?: string;
  /** Present for group chats; absent for 1:1. */
  group_id?: string;
  message_type?: number;
  message_state?: number;
  /** Must be echoed back on reply to bind to the right conversation window. */
  context_token?: string;
  item_list?: WeixinItem[];
  /** Best-effort stable id used for dedup when present. */
  msg_id?: string;
  client_msg_id?: string;
  create_time?: number;
  [key: string]: unknown;
};

export type GetUpdatesResult = { msgs: WeixinMessage[]; updatesBuf: string };

export type QrCodeResult = {
  /** Opaque id used to poll scan status. */
  qrcode: string;
  /** Pre-rendered QR image content (base64 PNG / data URL) when the API returns one. */
  qrImage?: string;
  /** Login deep-link to encode into a QR when no pre-rendered image is returned. */
  qrUrl?: string;
};

export type QrScanStatus = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'canceled' | (string & {});

export type QrStatusResult = {
  status: QrScanStatus;
  botToken?: string;
  baseUrl?: string;
};

export type SendMessageInput = {
  toUserId: string;
  text: string;
  /** Echoed inbound token; replies without it may not bind to the window. */
  contextToken?: string;
  /** Set for group replies. */
  groupId?: string;
};

export type SendTypingInput = {
  /** iLink user id (inbound `from_user_id`). */
  ilinkUserId: string;
  /** From `getconfig`; required for typing indicators. */
  typingTicket: string;
  /** 1 = typing, 2 = cancel. */
  status?: 1 | 2;
};

export type ILinkClientOptions = {
  baseUrl?: string;
  botToken?: string;
  botType?: number;
  channelVersion?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/** Error raised on transport/protocol failure; `authFailed` drives re-login. */
export class ILinkError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly authFailed: boolean;
  readonly aborted: boolean;

  constructor(message: string, options: { status?: number; code?: number; aborted?: boolean } = {}) {
    super(message);
    this.name = 'ILinkError';
    this.status = options.status;
    this.code = options.code;
    this.authFailed = options.status === 401 || options.status === 403;
    this.aborted = options.aborted ?? false;
  }
}

export class ILinkClient {
  private baseUrl: string;
  private botToken: string | undefined;
  private readonly botType: number;
  private readonly channelVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ILinkClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? ILINK_BASE_URL);
    this.botToken = options.botToken;
    this.botType = options.botType ?? DEFAULT_BOT_TYPE;
    this.channelVersion = options.channelVersion ?? DEFAULT_CHANNEL_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ILinkClient requires a fetch implementation (Node >= 18 or fetchImpl).');
    }
  }

  setBotToken(token: string | undefined): void {
    this.botToken = token;
  }

  setBaseUrl(url: string | undefined): void {
    if (url) {
      this.baseUrl = trimTrailingSlash(url);
    }
  }

  hasToken(): boolean {
    return Boolean(this.botToken);
  }

  /** Request a login QR. No auth header (we are not logged in yet). */
  async getBotQrcode(): Promise<QrCodeResult> {
    const data = await this.request<Record<string, unknown>>('GET', 'ilink/bot/get_bot_qrcode', {
      auth: false,
      query: { bot_type: String(this.botType) },
    });
    const qrcode = asString(data.qrcode);
    if (!qrcode) {
      throw new ILinkError('get_bot_qrcode returned no qrcode');
    }
    return { qrcode, qrImage: asString(data.qrcode_img_content), qrUrl: asString(data.url) };
  }

  /** Poll scan status; `confirmed` yields the bot token + per-account base url. */
  async getQrcodeStatus(qrcode: string): Promise<QrStatusResult> {
    const data = await this.request<Record<string, unknown>>('GET', 'ilink/bot/get_qrcode_status', {
      auth: false,
      query: { qrcode },
    });
    return {
      status: asString(data.status) ?? 'pending',
      botToken: asString(data.bot_token),
      baseUrl: asString(data.baseurl),
    };
  }

  /** Long-poll for new inbound messages. Returns the advanced cursor. */
  async getUpdates(updatesBuf: string): Promise<GetUpdatesResult> {
    try {
      const data = await this.request<Record<string, unknown>>('POST', 'ilink/bot/getupdates', {
        body: { get_updates_buf: updatesBuf, base_info: this.baseInfo() },
        timeoutMs: LONG_POLL_TIMEOUT_MS,
      });
      const msgs = Array.isArray(data.msgs) ? (data.msgs as WeixinMessage[]) : [];
      return { msgs, updatesBuf: asString(data.get_updates_buf) ?? updatesBuf };
    } catch (error) {
      // Client-side long-poll timeout is normal; retry with the same cursor.
      if (error instanceof ILinkError && error.aborted) {
        return { msgs: [], updatesBuf };
      }
      throw error;
    }
  }

  /** Fetch bot config for a user (typing ticket for keepalive during long replies). */
  async getConfig(input: { ilinkUserId: string; contextToken?: string }): Promise<{ typingTicket?: string }> {
    const data = await this.request<Record<string, unknown>>('POST', 'ilink/bot/getconfig', {
      body: {
        ilink_user_id: input.ilinkUserId,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        base_info: this.baseInfo(),
      },
    });
    return { typingTicket: asString(data.typing_ticket) };
  }

  /** Send a text reply. `contextToken` binds it to the inbound conversation. */
  async sendMessage(input: SendMessageInput): Promise<{ messageId?: string }> {
    const clientId = generateClientId();
    const data = await this.request<Record<string, unknown>>('POST', 'ilink/bot/sendmessage', {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: input.toUserId,
          client_id: clientId,
          message_type: WX_MESSAGE_TYPE_BOT,
          message_state: WX_MESSAGE_STATE_FINISH,
          ...(input.contextToken ? { context_token: input.contextToken } : {}),
          ...(input.groupId ? { group_id: input.groupId } : {}),
          item_list: [{ type: WX_ITEM_TEXT, text_item: { text: input.text } }],
        },
        base_info: this.baseInfo(),
      },
    });
    return { messageId: asString(data.msg_id) ?? asString(data.client_msg_id) ?? clientId };
  }

  /** Best-effort "typing" indicator; failures are non-fatal for the caller. */
  async sendTyping(input: SendTypingInput): Promise<void> {
    await this.request('POST', 'ilink/bot/sendtyping', {
      body: {
        ilink_user_id: input.ilinkUserId,
        typing_ticket: input.typingTicket,
        status: input.status ?? 1,
        base_info: this.baseInfo(),
      },
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      auth?: boolean;
      query?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const auth = options.auth ?? true;
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(auth),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ILinkError(`iLink ${path} request failed: ${error instanceof Error ? error.message : String(error)}`, {
        aborted,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ILinkError(`iLink ${path} returned HTTP ${res.status}`, { status: res.status });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const ret = typeof json.ret === 'number' ? json.ret : 0;
    if (ret !== 0) {
      throw new ILinkError(`iLink ${path} returned ret ${ret}${json.errmsg ? `: ${String(json.errmsg)}` : ''}`, {
        code: ret,
      });
    }
    return json as T;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private baseInfo(): { channel_version: string } {
    return { channel_version: this.channelVersion };
  }

  private headers(auth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      // Random per-request uint32 (decimal string, base64-encoded) for anti-replay.
      'X-WECHAT-UIN': randomUin(),
    };
    if (auth && this.botToken) {
      headers.Authorization = `Bearer ${this.botToken}`;
    }
    return headers;
  }
}

/** Extract the human-readable text from an inbound message's item_list. */
export function extractText(message: WeixinMessage): string {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  return items
    .filter((item) => item?.type === WX_ITEM_TEXT)
    .map((item) => (typeof item.text_item?.text === 'string' ? item.text_item.text : ''))
    .join('\n')
    .trim();
}

/** A stable dedup key when the protocol exposes one; otherwise undefined (the
 *  long-poll cursor already prevents normal re-delivery). */
export function messageDedupKey(message: WeixinMessage): string | undefined {
  return asString(message.msg_id) ?? asString(message.client_msg_id);
}

function randomUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value)).toString('base64');
}

function generateClientId(): string {
  return `zleap-wx-${randomBytes(8).toString('hex')}`;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

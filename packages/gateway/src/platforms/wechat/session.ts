/**
 * Persisted WeChat operational session: the bot token, per-account base url, and
 * long-poll cursor. Stored DB-first in `gateway_integrations` under a dedicated
 * channel so the token survives restarts (no cwd-relative file, which bit the 302
 * integration).
 *
 * Login/QR/phase is NOT stored here anymore — that public state is published
 * through the unified `connections:<channel>` row (see `ConnectionsService`),
 * keeping secrets (the bot token) separate from the display state the web reads.
 */

export const WECHAT_SESSION_CHANNEL = 'wechat:session';

export type WeChatSession = {
  botToken?: string;
  baseUrl?: string;
  updatesBuf?: string;
};

export interface WeChatSessionStore {
  load(): Promise<WeChatSession>;
  save(patch: Partial<WeChatSession>): Promise<void>;
  clear(): Promise<void>;
}

/** Structural slice of the store's integration table needed for persistence. */
export type WeChatSessionIntegrationStore = {
  getIntegration(channel: string): Promise<{ config: Record<string, unknown> } | undefined>;
  saveIntegration(record: { channel: string; config: Record<string, unknown>; updatedAt: Date }): Promise<void>;
  deleteIntegration(channel: string): Promise<void>;
};

const DEFAULT_SESSION: WeChatSession = {};

/** DB-backed session store using the shared `gateway_integrations` table. */
export class DbWeChatSessionStore implements WeChatSessionStore {
  constructor(private readonly store: WeChatSessionIntegrationStore) {}

  async load(): Promise<WeChatSession> {
    const record = await this.store.getIntegration(WECHAT_SESSION_CHANNEL);
    const config = record?.config ?? {};
    return {
      botToken: str(config.botToken),
      baseUrl: str(config.baseUrl),
      updatesBuf: str(config.updatesBuf),
    };
  }

  async save(patch: Partial<WeChatSession>): Promise<void> {
    const current = await this.load();
    const merged: WeChatSession = { ...current, ...patch };
    await this.store.saveIntegration({
      channel: WECHAT_SESSION_CHANNEL,
      config: prune(merged as unknown as Record<string, unknown>),
      updatedAt: new Date(),
    });
  }

  async clear(): Promise<void> {
    await this.store.deleteIntegration(WECHAT_SESSION_CHANNEL);
  }
}

/** In-memory session store (tests / DB-less runs). */
export class MemoryWeChatSessionStore implements WeChatSessionStore {
  private session: WeChatSession = { ...DEFAULT_SESSION };

  async load(): Promise<WeChatSession> {
    return { ...this.session };
  }

  async save(patch: Partial<WeChatSession>): Promise<void> {
    this.session = { ...this.session, ...patch };
  }

  async clear(): Promise<void> {
    this.session = { ...DEFAULT_SESSION };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function prune(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

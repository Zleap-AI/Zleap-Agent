import { DEFAULT_BOT_TYPE, DEFAULT_CHANNEL_VERSION, ILINK_BASE_URL } from './platforms/wechat/ilink.js';
import { DEFAULT_EVENT_KEY, resolveLarkCliBin } from './platforms/feishucli/cli.js';

export type GroupPolicy = 'open' | 'allowlist' | 'blacklist' | 'admin_only' | 'disabled';

const GROUP_POLICIES: readonly GroupPolicy[] = ['open', 'allowlist', 'blacklist', 'admin_only', 'disabled'];

/**
 * Tool-approval policy for the channel, mirroring the web composer:
 * - 'request_approval' (default, safe): auto-approve no-risk tools, deny anything
 *   needing HITL (IM has no interactive approval surface, so it fails closed).
 * - 'full_access': auto-approve every tool, including run_command/file writes.
 */
export type GatewayPermissionMode = 'request_approval' | 'full_access';

function parsePermissionMode(value?: string): GatewayPermissionMode {
  return value?.trim().toLowerCase() === 'full_access' ? 'full_access' : 'request_approval';
}

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  /** 'feishu' (cn) or 'lark' (intl). */
  domain: 'feishu' | 'lark';
  encryptKey?: string;
  verificationToken?: string;
  /** Group message admission policy. */
  groupPolicy: GroupPolicy;
  /** Allowed sender open_ids when policy is 'allowlist' (or blocked for 'blacklist'). */
  allowedUsers: string[];
  botOpenId?: string;
  botUserId?: string;
  botName?: string;
  /** Tool-approval policy for runs triggered from this channel. */
  permissionMode: GatewayPermissionMode;
};

export type GatewayProcessConfig = {
  /** Global concurrent agent-run cap across conversations (0 disables). */
  maxConcurrent: number;
};

function splitList(value?: string): string[] {
  return (value ?? '')
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGroupPolicy(value?: string): GroupPolicy {
  const normalized = value?.trim().toLowerCase();
  return GROUP_POLICIES.includes(normalized as GroupPolicy) ? (normalized as GroupPolicy) : 'open';
}

/** Build the Feishu config from env. Returns undefined when credentials are absent. */
export function loadFeishuConfig(env: NodeJS.ProcessEnv = process.env): FeishuConfig | undefined {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return undefined;
  }
  const domain = env.FEISHU_DOMAIN?.trim().toLowerCase() === 'lark' ? 'lark' : 'feishu';
  return {
    appId,
    appSecret,
    domain,
    encryptKey: env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    verificationToken: env.FEISHU_VERIFICATION_TOKEN?.trim() || undefined,
    groupPolicy: parseGroupPolicy(env.FEISHU_GROUP_POLICY),
    allowedUsers: splitList(env.FEISHU_ALLOWED_USERS),
    botOpenId: env.FEISHU_BOT_OPEN_ID?.trim() || undefined,
    botUserId: env.FEISHU_BOT_USER_ID?.trim() || undefined,
    botName: env.FEISHU_BOT_NAME?.trim() || undefined,
    permissionMode: parsePermissionMode(env.FEISHU_PERMISSION_MODE),
  };
}

export function loadGatewayProcessConfig(env: NodeJS.ProcessEnv = process.env): GatewayProcessConfig {
  const raw = Number(env.ZLEAP_GATEWAY_MAX_CONCURRENT ?? 0);
  return { maxConcurrent: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0 };
}

/** Channel id for the Feishu gateway integration row. */
export const FEISHU_INTEGRATION_CHANNEL = 'feishu';

/** Channel id for the WeChat gateway integration row. */
export const WECHAT_INTEGRATION_CHANNEL = 'wechat';

/** Minimal store surface needed to read a persisted gateway integration row. */
export type GatewayIntegrationReader = {
  integrations: {
    getIntegration(channel: string): Promise<{ config: Record<string, unknown> } | undefined>;
  };
};

/** @deprecated Use {@link GatewayIntegrationReader}. Kept for back-compat. */
export type FeishuIntegrationReader = GatewayIntegrationReader;

/**
 * Resolve the Feishu config data-first: a complete DB integration row (edited via
 * the web settings UI) wins; otherwise fall back to env. Keeping env as a fallback
 * means existing `.env`-only deployments keep working unchanged.
 */
export async function resolveFeishuConfig(
  store: FeishuIntegrationReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeishuConfig | undefined> {
  try {
    const record = await store.integrations.getIntegration(FEISHU_INTEGRATION_CHANNEL);
    const fromDb = record ? feishuConfigFromRecord(record.config) : undefined;
    if (fromDb) {
      return fromDb;
    }
  } catch {
    // DB read failed — degrade to env so the gateway can still start.
  }
  return loadFeishuConfig(env);
}

/** Build a FeishuConfig from a persisted integration blob; undefined when the
 *  required credentials are missing. */
export function feishuConfigFromRecord(config: Record<string, unknown>): FeishuConfig | undefined {
  const appId = configString(config.appId);
  const appSecret = configString(config.appSecret);
  if (!appId || !appSecret) {
    return undefined;
  }
  const domain = configString(config.domain)?.toLowerCase() === 'lark' ? 'lark' : 'feishu';
  return {
    appId,
    appSecret,
    domain,
    encryptKey: configString(config.encryptKey),
    verificationToken: configString(config.verificationToken),
    groupPolicy: parseGroupPolicy(configString(config.groupPolicy)),
    allowedUsers: configStringList(config.allowedUsers),
    botOpenId: configString(config.botOpenId),
    botUserId: configString(config.botUserId),
    botName: configString(config.botName),
    permissionMode: parsePermissionMode(configString(config.permissionMode)),
  };
}

/**
 * WeChat (Tencent iLink Bot) channel config. Unlike Feishu there is no app
 * id/secret: auth is a scan-to-login flow whose bot token is persisted in the
 * session row. This config only carries admission/permission policy plus the
 * protocol endpoint knobs (defaulted, overridable for staging/version pinning).
 */
export type WeChatConfig = {
  enabled: boolean;
  baseUrl: string;
  botType: number;
  channelVersion: string;
  groupPolicy: GroupPolicy;
  allowedUsers: string[];
  permissionMode: GatewayPermissionMode;
};

/** Build the WeChat config from env. Returns undefined unless explicitly enabled. */
export function loadWeChatConfig(env: NodeJS.ProcessEnv = process.env): WeChatConfig | undefined {
  if (!parseBool(env.WECHAT_ENABLED)) {
    return undefined;
  }
  return {
    enabled: true,
    baseUrl: env.WECHAT_BASE_URL?.trim() || ILINK_BASE_URL,
    botType: parseIntOr(env.WECHAT_BOT_TYPE, DEFAULT_BOT_TYPE),
    channelVersion: env.WECHAT_CHANNEL_VERSION?.trim() || DEFAULT_CHANNEL_VERSION,
    groupPolicy: parseGroupPolicy(env.WECHAT_GROUP_POLICY),
    allowedUsers: splitList(env.WECHAT_ALLOWED_USERS),
    permissionMode: parsePermissionMode(env.WECHAT_PERMISSION_MODE),
  };
}

/**
 * Resolve the WeChat config data-first: an enabled DB integration row (edited via
 * the web settings UI) wins; otherwise fall back to env so `.env`-only
 * deployments keep working.
 */
export async function resolveWeChatConfig(
  store: GatewayIntegrationReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WeChatConfig | undefined> {
  try {
    const record = await store.integrations.getIntegration(WECHAT_INTEGRATION_CHANNEL);
    const fromDb = record ? wechatConfigFromRecord(record.config) : undefined;
    if (fromDb) {
      return fromDb;
    }
  } catch {
    // DB read failed — degrade to env so the gateway can still start.
  }
  return loadWeChatConfig(env);
}

/** Build a WeChatConfig from a persisted integration blob; undefined when the
 *  channel is not enabled. */
export function wechatConfigFromRecord(config: Record<string, unknown>): WeChatConfig | undefined {
  if (!configBool(config.enabled)) {
    return undefined;
  }
  return {
    enabled: true,
    baseUrl: configString(config.baseUrl) ?? ILINK_BASE_URL,
    botType: configInt(config.botType) ?? DEFAULT_BOT_TYPE,
    channelVersion: configString(config.channelVersion) ?? DEFAULT_CHANNEL_VERSION,
    groupPolicy: parseGroupPolicy(configString(config.groupPolicy)),
    allowedUsers: configStringList(config.allowedUsers),
    permissionMode: parsePermissionMode(configString(config.permissionMode)),
  };
}

/** Channel id for the Feishu CLI gateway integration row. */
export const FEISHU_CLI_INTEGRATION_CHANNEL = 'feishu-cli';

export type FeishuCliIdentity = 'user' | 'bot';

function parseIdentity(value?: string): FeishuCliIdentity {
  return value?.trim().toLowerCase() === 'bot' ? 'bot' : 'user';
}

/**
 * Feishu CLI channel config: a second Feishu access method that drives the
 * official `@larksuite/cli` (lark-cli) as a subprocess. Auth is OAuth device
 * flow (credentials owned by lark-cli, isolated under `cliHome`); App ID/Secret
 * are optional and only used to seed `config init` non-interactively.
 */
export type FeishuCliConfig = {
  enabled: boolean;
  /** Send/consume identity: 'user' (OAuth) or 'bot'. */
  identity: FeishuCliIdentity;
  domain: 'feishu' | 'lark';
  /** EventKey consumed for inbound IM messages. */
  eventKey: string;
  groupPolicy: GroupPolicy;
  allowedUsers: string[];
  permissionMode: GatewayPermissionMode;
  botOpenId?: string;
  botName?: string;
  /** Optional: seed `lark-cli config init` non-interactively. */
  appId?: string;
  appSecret?: string;
  /** Binary name/path (default `lark-cli`). */
  cliBin: string;
  /** HOME dir isolating lark-cli credentials; undefined → gateway default. */
  cliHome?: string;
};

/** Build the Feishu CLI config from env. Returns undefined unless enabled. */
export function loadFeishuCliConfig(env: NodeJS.ProcessEnv = process.env): FeishuCliConfig | undefined {
  if (!parseBool(env.FEISHU_CLI_ENABLED)) {
    return undefined;
  }
  const domain = env.FEISHU_CLI_DOMAIN?.trim().toLowerCase() === 'lark' ? 'lark' : 'feishu';
  return {
    enabled: true,
    identity: parseIdentity(env.FEISHU_CLI_IDENTITY),
    domain,
    eventKey: env.FEISHU_CLI_EVENT_KEY?.trim() || DEFAULT_EVENT_KEY,
    groupPolicy: parseGroupPolicy(env.FEISHU_CLI_GROUP_POLICY ?? 'disabled'),
    allowedUsers: splitList(env.FEISHU_CLI_ALLOWED_USERS),
    permissionMode: parsePermissionMode(env.FEISHU_CLI_PERMISSION_MODE),
    botOpenId: env.FEISHU_CLI_BOT_OPEN_ID?.trim() || undefined,
    botName: env.FEISHU_CLI_BOT_NAME?.trim() || undefined,
    appId: env.FEISHU_CLI_APP_ID?.trim() || undefined,
    appSecret: env.FEISHU_CLI_APP_SECRET?.trim() || undefined,
    cliBin: resolveLarkCliBin(env.FEISHU_CLI_BIN),
    cliHome: env.FEISHU_CLI_HOME?.trim() || undefined,
  };
}

/**
 * Resolve the Feishu CLI config data-first: an enabled DB integration row wins;
 * otherwise fall back to env. Mirrors {@link resolveWeChatConfig}.
 */
export async function resolveFeishuCliConfig(
  store: GatewayIntegrationReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeishuCliConfig | undefined> {
  try {
    const record = await store.integrations.getIntegration(FEISHU_CLI_INTEGRATION_CHANNEL);
    const fromDb = record ? feishuCliConfigFromRecord(record.config, env) : undefined;
    if (fromDb) {
      return fromDb;
    }
  } catch {
    // DB read failed — degrade to env so the gateway can still start.
  }
  return loadFeishuCliConfig(env);
}

/** Build a FeishuCliConfig from a persisted integration blob; undefined when
 *  the channel is not enabled. `cliBin`/`cliHome` fall back to env then default. */
export function feishuCliConfigFromRecord(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): FeishuCliConfig | undefined {
  if (!configBool(config.enabled)) {
    return undefined;
  }
  const domain = configString(config.domain)?.toLowerCase() === 'lark' ? 'lark' : 'feishu';
  return {
    enabled: true,
    identity: parseIdentity(configString(config.identity)),
    domain,
    eventKey: configString(config.eventKey) ?? DEFAULT_EVENT_KEY,
    groupPolicy: parseGroupPolicy(configString(config.groupPolicy) ?? 'disabled'),
    allowedUsers: configStringList(config.allowedUsers),
    permissionMode: parsePermissionMode(configString(config.permissionMode)),
    botOpenId: configString(config.botOpenId),
    botName: configString(config.botName),
    appId: configString(config.appId),
    appSecret: configString(config.appSecret),
    cliBin: configString(config.cliBin) ?? resolveLarkCliBin(env.FEISHU_CLI_BIN),
    cliHome: configString(config.cliHome) ?? (env.FEISHU_CLI_HOME?.trim() || undefined),
  };
}

function parseBool(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function configBool(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return parseBool(typeof value === 'string' ? value : undefined);
}

function configInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const parsed = Number(configString(value));
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function configString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function configStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  return splitList(configString(value));
}

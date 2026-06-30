import type { ZleapStore } from '@zleap/store';

/** Config row channel (identity/admission/permission policy + optional app creds). */
export const FEISHU_CLI_CHANNEL = 'feishu-cli';
/** Session row channel (login state / authorization URL), written by the gateway. */
export const FEISHU_CLI_SESSION_CHANNEL = 'feishu-cli:session';

type IntegrationStore = Pick<ZleapStore, 'integrations'>;

export type FeishuCliPermissionMode = 'request_approval' | 'full_access';
export type FeishuCliIdentity = 'user' | 'bot';

function normalizePermissionMode(value: unknown): FeishuCliPermissionMode {
  return str(value) === 'full_access' ? 'full_access' : 'request_approval';
}

function normalizeIdentity(value: unknown): FeishuCliIdentity {
  return str(value) === 'bot' ? 'bot' : 'user';
}

function normalizeDomain(value: unknown): 'feishu' | 'lark' {
  return str(value) === 'lark' ? 'lark' : 'feishu';
}

export type FeishuCliIntegrationInput = {
  enabled?: boolean;
  identity?: string;
  domain?: string;
  permissionMode?: string;
  groupPolicy?: string;
  allowedUsers?: string[] | string;
  eventKey?: string;
  botOpenId?: string;
  botName?: string;
  appId?: string;
  /** Write-only: persisted but never echoed back by the API. */
  appSecret?: string;
};

/** API-safe config view. The app secret is never echoed. */
export type RedactedFeishuCliIntegration = {
  enabled: boolean;
  identity: FeishuCliIdentity;
  domain: 'feishu' | 'lark';
  permissionMode: FeishuCliPermissionMode;
  groupPolicy: string;
  allowedUsers: string[];
  eventKey?: string;
  botOpenId?: string;
  botName?: string;
  appId?: string;
  hasAppSecret: boolean;
  updatedAt?: string;
};

export async function readFeishuCliIntegration(store: IntegrationStore): Promise<RedactedFeishuCliIntegration> {
  const record = await store.integrations.getIntegration(FEISHU_CLI_CHANNEL);
  const config = record?.config ?? {};
  return {
    enabled: Boolean(config.enabled),
    identity: normalizeIdentity(config.identity),
    domain: normalizeDomain(config.domain),
    permissionMode: normalizePermissionMode(config.permissionMode),
    groupPolicy: str(config.groupPolicy) ?? 'disabled',
    allowedUsers: toList(config.allowedUsers),
    eventKey: str(config.eventKey),
    botOpenId: str(config.botOpenId),
    botName: str(config.botName),
    appId: str(config.appId),
    hasAppSecret: Boolean(str(config.appSecret)),
    updatedAt: record?.updatedAt?.toISOString(),
  };
}

export type SaveFeishuCliResult = { ok: true } | { ok: false; error: string };

export async function saveFeishuCliIntegration(
  store: IntegrationStore,
  input: FeishuCliIntegrationInput,
): Promise<SaveFeishuCliResult> {
  const existing = (await store.integrations.getIntegration(FEISHU_CLI_CHANNEL))?.config ?? {};

  const config: Record<string, unknown> = {
    enabled: input.enabled ?? Boolean(existing.enabled),
    identity: normalizeIdentity(input.identity ?? existing.identity),
    domain: normalizeDomain(input.domain ?? existing.domain),
    permissionMode: normalizePermissionMode(input.permissionMode ?? existing.permissionMode),
    groupPolicy: str(input.groupPolicy) ?? str(existing.groupPolicy) ?? 'disabled',
    allowedUsers: normalizeList(input.allowedUsers),
    eventKey: str(input.eventKey) ?? str(existing.eventKey),
    botOpenId: str(input.botOpenId) ?? str(existing.botOpenId),
    botName: str(input.botName) ?? str(existing.botName),
    appId: str(input.appId) ?? str(existing.appId),
    // Keep the prior secret when the field is omitted/blank (write-only).
    appSecret: str(input.appSecret) ?? str(existing.appSecret),
  };

  await store.integrations.saveIntegration({
    channel: FEISHU_CLI_CHANNEL,
    config: prune(config),
    updatedAt: new Date(),
  });
  return { ok: true };
}

export async function deleteFeishuCliIntegration(store: IntegrationStore): Promise<void> {
  await store.integrations.deleteIntegration(FEISHU_CLI_CHANNEL);
  // Drop the legacy session row and the unified connection state/command rows so
  // a fresh enable re-authorizes.
  await store.integrations.deleteIntegration(FEISHU_CLI_SESSION_CHANNEL);
  await store.integrations.deleteIntegration('connections:feishu-cli');
  await store.integrations.deleteIntegration('connections:feishu-cli:command');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  return normalizeList(str(value));
}

function normalizeList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return (value ?? '')
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function prune(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

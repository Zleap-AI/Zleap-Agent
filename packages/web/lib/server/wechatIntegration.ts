import type { ZleapStore } from '@zleap/store';

/** Config row channel (admission/permission policy). */
export const WECHAT_CHANNEL = 'wechat';
/** Session row channel (bot token / login state / QR), written by the gateway. */
export const WECHAT_SESSION_CHANNEL = 'wechat:session';

type IntegrationStore = Pick<ZleapStore, 'integrations'>;

export type WeChatPermissionMode = 'request_approval' | 'full_access';

function normalizePermissionMode(value: unknown): WeChatPermissionMode {
  return str(value) === 'full_access' ? 'full_access' : 'request_approval';
}

export type WeChatIntegrationInput = {
  enabled?: boolean;
  permissionMode?: string;
  groupPolicy?: string;
  allowedUsers?: string[] | string;
  baseUrl?: string;
  botType?: number | string;
  channelVersion?: string;
};

/** API-safe config view. No secrets here; the bot token lives in the session row. */
export type RedactedWeChatIntegration = {
  enabled: boolean;
  permissionMode: WeChatPermissionMode;
  groupPolicy: string;
  allowedUsers: string[];
  baseUrl?: string;
  updatedAt?: string;
};

export async function readWeChatIntegration(store: IntegrationStore): Promise<RedactedWeChatIntegration> {
  const record = await store.integrations.getIntegration(WECHAT_CHANNEL);
  const config = record?.config ?? {};
  return {
    enabled: Boolean(config.enabled),
    permissionMode: normalizePermissionMode(config.permissionMode),
    groupPolicy: str(config.groupPolicy) ?? 'open',
    allowedUsers: toList(config.allowedUsers),
    baseUrl: str(config.baseUrl),
    updatedAt: record?.updatedAt?.toISOString(),
  };
}

export type SaveWeChatResult = { ok: true } | { ok: false; error: string };

export async function saveWeChatIntegration(
  store: IntegrationStore,
  input: WeChatIntegrationInput,
): Promise<SaveWeChatResult> {
  const existing = (await store.integrations.getIntegration(WECHAT_CHANNEL))?.config ?? {};

  const config: Record<string, unknown> = {
    enabled: input.enabled ?? Boolean(existing.enabled),
    permissionMode: normalizePermissionMode(input.permissionMode ?? existing.permissionMode),
    groupPolicy: str(input.groupPolicy) ?? str(existing.groupPolicy) ?? 'open',
    allowedUsers: normalizeList(input.allowedUsers),
    baseUrl: str(input.baseUrl) ?? str(existing.baseUrl),
    botType: intOrUndefined(input.botType) ?? intOrUndefined(existing.botType),
    channelVersion: str(input.channelVersion) ?? str(existing.channelVersion),
  };

  await store.integrations.saveIntegration({
    channel: WECHAT_CHANNEL,
    config: prune(config),
    updatedAt: new Date(),
  });
  return { ok: true };
}

export async function deleteWeChatIntegration(store: IntegrationStore): Promise<void> {
  await store.integrations.deleteIntegration(WECHAT_CHANNEL);
  // Drop the operational session (token/cursor) and the unified connection state
  // so a fresh enable re-scans. (`wechat:session` is the gateway operational row;
  // `connections:wechat*` are the unified state/command rows.)
  await store.integrations.deleteIntegration(WECHAT_SESSION_CHANNEL);
  await store.integrations.deleteIntegration('connections:wechat');
  await store.integrations.deleteIntegration('connections:wechat:command');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function intOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const parsed = Number(str(value));
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
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

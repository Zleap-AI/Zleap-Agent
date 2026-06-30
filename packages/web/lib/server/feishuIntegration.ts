import type { ZleapStore } from '@zleap/store';

export const FEISHU_CHANNEL = 'feishu';

type IntegrationStore = Pick<ZleapStore, 'integrations'>;

export type FeishuDomain = 'feishu' | 'lark';

export type FeishuPermissionMode = 'request_approval' | 'full_access';

function normalizePermissionMode(value: unknown): FeishuPermissionMode {
  return str(value) === 'full_access' ? 'full_access' : 'request_approval';
}

export type FeishuIntegrationInput = {
  appId?: string;
  appSecret?: string;
  domain?: string;
  groupPolicy?: string;
  permissionMode?: string;
  allowedUsers?: string[] | string;
  botOpenId?: string;
  botName?: string;
  encryptKey?: string;
  verificationToken?: string;
};

/** API-safe view: secrets are reported as booleans, never echoed back. */
export type RedactedFeishuIntegration = {
  configured: boolean;
  appId?: string;
  domain: FeishuDomain;
  groupPolicy: string;
  permissionMode: FeishuPermissionMode;
  allowedUsers: string[];
  botOpenId?: string;
  botName?: string;
  hasAppSecret: boolean;
  hasEncryptKey: boolean;
  hasVerificationToken: boolean;
  updatedAt?: string;
};

export async function readFeishuIntegration(store: IntegrationStore): Promise<RedactedFeishuIntegration> {
  const record = await store.integrations.getIntegration(FEISHU_CHANNEL);
  const config = record?.config ?? {};
  const appSecret = str(config.appSecret);
  return {
    configured: Boolean(str(config.appId) && appSecret),
    appId: str(config.appId),
    domain: str(config.domain) === 'lark' ? 'lark' : 'feishu',
    groupPolicy: str(config.groupPolicy) ?? 'open',
    permissionMode: normalizePermissionMode(config.permissionMode),
    allowedUsers: toList(config.allowedUsers),
    botOpenId: str(config.botOpenId),
    botName: str(config.botName),
    hasAppSecret: Boolean(appSecret),
    hasEncryptKey: Boolean(str(config.encryptKey)),
    hasVerificationToken: Boolean(str(config.verificationToken)),
    updatedAt: record?.updatedAt?.toISOString(),
  };
}

export type SaveFeishuResult = { ok: true } | { ok: false; error: string };

export async function saveFeishuIntegration(
  store: IntegrationStore,
  input: FeishuIntegrationInput,
): Promise<SaveFeishuResult> {
  const existing = (await store.integrations.getIntegration(FEISHU_CHANNEL))?.config ?? {};

  const appId = str(input.appId) ?? str(existing.appId);
  // Secrets: an empty submitted value preserves the stored one (the UI shows a
  // masked placeholder, not the real secret), so editing other fields never
  // wipes credentials. Use DELETE to fully clear the integration.
  const appSecret = str(input.appSecret) ?? str(existing.appSecret);
  if (!appId) {
    return { ok: false, error: 'app_id_required' };
  }
  if (!appSecret) {
    return { ok: false, error: 'app_secret_required' };
  }

  const config: Record<string, unknown> = {
    appId,
    appSecret,
    domain: input.domain === 'lark' ? 'lark' : 'feishu',
    groupPolicy: str(input.groupPolicy) ?? str(existing.groupPolicy) ?? 'open',
    permissionMode: normalizePermissionMode(input.permissionMode ?? existing.permissionMode),
    allowedUsers: normalizeList(input.allowedUsers),
    botOpenId: str(input.botOpenId),
    botName: str(input.botName),
    encryptKey: str(input.encryptKey) ?? str(existing.encryptKey),
    verificationToken: str(input.verificationToken) ?? str(existing.verificationToken),
  };

  await store.integrations.saveIntegration({
    channel: FEISHU_CHANNEL,
    config: prune(config),
    updatedAt: new Date(),
  });
  return { ok: true };
}

export async function deleteFeishuIntegration(store: IntegrationStore): Promise<void> {
  await store.integrations.deleteIntegration(FEISHU_CHANNEL);
}

/**
 * Validate credentials by exchanging them for a tenant_access_token. This is the
 * cheapest authenticated Feishu call and proves the app_id/app_secret pair is
 * valid without needing any extra permission scope.
 */
export async function testFeishuCredentials(input: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<{ ok: boolean; error?: string }> {
  const base = input.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  try {
    const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    });
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (data.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: data.msg ?? `code ${data.code ?? 'unknown'}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve the secret to test with: explicit input wins, else the stored one. */
export async function resolveTestCredentials(
  store: IntegrationStore,
  input: { appId?: string; appSecret?: string; domain?: string },
): Promise<{ appId: string; appSecret: string; domain: FeishuDomain } | undefined> {
  const existing = (await store.integrations.getIntegration(FEISHU_CHANNEL))?.config ?? {};
  const appId = str(input.appId) ?? str(existing.appId);
  const appSecret = str(input.appSecret) ?? str(existing.appSecret);
  if (!appId || !appSecret) {
    return undefined;
  }
  const domain = (str(input.domain) ?? str(existing.domain)) === 'lark' ? 'lark' : 'feishu';
  return { appId, appSecret, domain };
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

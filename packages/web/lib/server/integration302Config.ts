import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getSharedStore } from './sharedStore';

export const DEFAULT_302_API_BASE_URL = 'https://api.302.ai';
export const DEFAULT_302_MODEL_BASE_URL = 'https://api.302.ai/v1';

/** Integration row id for the 302.AI config (shared `gateway_integrations` table). */
export const INTEGRATION_302_CHANNEL = '302';

export type Integration302Config = {
  apiKey?: string;
  apiBaseUrl?: string;
  modelBaseUrl?: string;
  updatedAt?: string;
};

type ModelConfigFallbackStore = {
  models?: {
    listModelConfigs(input?: { purpose?: string }): Promise<Array<{ config?: Record<string, unknown> }>>;
  };
};

export function integration302ConfigPath(): string {
  return process.env.ZLEAP_302_CONFIG_PATH ?? join(process.cwd(), '.zleap', '302.json');
}

/**
 * The DB row (shared `gateway_integrations`, channel '302') is the single source
 * of truth across web/gateway/tasks; returns `{}` when no database is reachable.
 * env/file fallbacks are layered in the resolvers below, mirroring the gateway's
 * data-first `resolveFeishuConfig` pattern.
 */
export async function read302IntegrationConfig(): Promise<Integration302Config> {
  const store = await getSharedStore().catch(() => null);
  if (store) {
    try {
      const record = await store.integrations.getIntegration(INTEGRATION_302_CHANNEL);
      const config = record ? parse302ConfigObject(record.config) : {};
      const fallback = await read302ModelConfigFallback(store);
      return merge302ConfigFallback(config, fallback);
    } catch {
      // DB read failed — degrade to env/file so the UI/tools can still resolve.
    }
  }
  return {};
}

export async function save302IntegrationConfig(config: Integration302Config): Promise<Integration302Config> {
  const current = await read302IntegrationConfig();
  const next: Integration302Config = {
    ...current,
    ...config,
    apiBaseUrl: config.apiBaseUrl?.trim() || current.apiBaseUrl || DEFAULT_302_API_BASE_URL,
    modelBaseUrl: config.modelBaseUrl?.trim() || current.modelBaseUrl || DEFAULT_302_MODEL_BASE_URL,
    updatedAt: new Date().toISOString(),
  };
  const store = await getSharedStore().catch(() => null);
  if (store) {
    await store.integrations.saveIntegration({
      channel: INTEGRATION_302_CHANNEL,
      config: { apiKey: next.apiKey, apiBaseUrl: next.apiBaseUrl, modelBaseUrl: next.modelBaseUrl },
      updatedAt: new Date(),
    });
    return next;
  }
  // No database — fall back to the cwd-relative file (local web without PG).
  const file = integration302ConfigPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await chmod(file, 0o600).catch(() => {});
  return next;
}

export async function clear302IntegrationConfig(): Promise<void> {
  const store = await getSharedStore().catch(() => null);
  if (store) {
    await store.integrations.deleteIntegration(INTEGRATION_302_CHANNEL).catch(() => {});
  }
  await rm(integration302ConfigPath(), { force: true });
}

/** Resolve the API key DB-first (the `config` arg), env as fallback, then file. */
export function resolve302ApiKey(config: Integration302Config = {}): string | undefined {
  return firstNonEmpty(
    config.apiKey,
    process.env.ZLEAP_302_API_KEY,
    process.env['302_API_KEY'],
    read302FileConfig().apiKey,
  );
}

export function resolve302ApiBaseUrl(config: Integration302Config = {}): string {
  return (
    firstNonEmpty(config.apiBaseUrl, process.env.ZLEAP_302_API_BASE_URL, read302FileConfig().apiBaseUrl) ??
    DEFAULT_302_API_BASE_URL
  );
}

export function resolve302ModelBaseUrl(config: Integration302Config = {}): string {
  return (
    firstNonEmpty(config.modelBaseUrl, process.env.ZLEAP_302_MODEL_BASE_URL, read302FileConfig().modelBaseUrl) ??
    DEFAULT_302_MODEL_BASE_URL
  );
}

/** Sync file read kept as the lowest-priority fallback (local web without a DB). */
function read302FileConfig(): Integration302Config {
  try {
    return parse302ConfigString(readFileSync(integration302ConfigPath(), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    return {};
  }
}

function parse302ConfigString(raw: string): Integration302Config {
  return parse302ConfigObject(JSON.parse(raw) as Record<string, unknown>);
}

function parse302ConfigObject(parsed: Record<string, unknown>): Integration302Config {
  return {
    apiKey: stringValue(parsed.apiKey),
    apiBaseUrl: stringValue(parsed.apiBaseUrl),
    modelBaseUrl: stringValue(parsed.modelBaseUrl),
    updatedAt: stringValue(parsed.updatedAt),
  };
}

async function read302ModelConfigFallback(store: ModelConfigFallbackStore): Promise<Integration302Config> {
  const listModelConfigs = store.models?.listModelConfigs;
  if (!listModelConfigs) {
    return {};
  }
  try {
    const models = await listModelConfigs.call(store.models);
    const config = models.find((record) => stringValue(record.config?.providerKey) === '302ai' && stringValue(record.config?.apiKey))?.config;
    return config
      ? {
          apiKey: stringValue(config.apiKey),
          modelBaseUrl: stringValue(config.baseUrl) ?? stringValue(config.baseURL),
        }
      : {};
  } catch {
    return {};
  }
}

function merge302ConfigFallback(config: Integration302Config, fallback: Integration302Config): Integration302Config {
  return {
    ...fallback,
    ...config,
    apiKey: config.apiKey ?? fallback.apiKey,
    modelBaseUrl: config.modelBaseUrl ?? fallback.modelBaseUrl,
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_302_API_BASE_URL = 'https://api.302.ai';
export const DEFAULT_302_MODEL_BASE_URL = 'https://api.302.ai/v1';

/** Integration row id for the 302.AI config (shared `gateway_integrations` table). */
export const INTEGRATION_302_CHANNEL = '302';

export type Integration302Config = {
  apiKey?: string;
  apiBaseUrl?: string;
  modelBaseUrl?: string;
};

/**
 * Minimal store surface needed to read the persisted 302 config. Injected once at
 * process boot (see `createSharedStore`) so the file-less, cwd-agnostic DB row is
 * the single source of truth shared by web, gateway, tasks, and the CLI engine.
 */
export type Integration302Store = {
  integrations: {
    getIntegration(channel: string): Promise<{ config: Record<string, unknown> } | undefined>;
  };
};

let injectedStore: Integration302Store | undefined;

/** Wire the process-level store so 302 resolution becomes DB-first. */
export function setIntegration302Store(store: Integration302Store | undefined): void {
  injectedStore = store;
}

export function integration302ConfigPath(): string {
  return process.env.ZLEAP_302_CONFIG_PATH ?? join(process.cwd(), '.zleap', '302.json');
}

/**
 * The DB row (web settings) is the source of truth; returns `{}` when no store is
 * wired or the row is absent. env/file fallbacks are layered in the resolvers
 * below, mirroring the gateway's data-first `resolveFeishuConfig` pattern.
 */
export async function read302IntegrationConfig(): Promise<Integration302Config> {
  if (injectedStore) {
    try {
      const record = await injectedStore.integrations.getIntegration(INTEGRATION_302_CHANNEL);
      if (record) {
        return parse302ConfigObject(record.config);
      }
    } catch {
      // DB read failed — degrade to env/file so tools can still resolve a key.
    }
  }
  return {};
}

/** Sync file read kept as the lowest-priority fallback (local CLI without a DB). */
function read302FileConfig(): Integration302Config {
  try {
    return parse302ConfigString(readFileSync(integration302ConfigPath(), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    return {};
  }
}

async function read302FileConfigAsync(): Promise<Integration302Config> {
  try {
    return parse302ConfigString(await readFile(integration302ConfigPath(), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    return {};
  }
}

/**
 * Resolve the API key DB-first, env as fallback, then a legacy local file.
 * `config` is the already-loaded DB blob (from `read302IntegrationConfig`); pass
 * it through so callers that already awaited the DB read don't hit it twice.
 */
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

/** One-shot async resolution (DB → env → file) for callers without a config in hand. */
export async function resolveIntegration302(): Promise<{ apiKey?: string; apiBaseUrl: string; modelBaseUrl: string }> {
  const db = await read302IntegrationConfig();
  const file = await read302FileConfigAsync();
  return {
    apiKey: firstNonEmpty(db.apiKey, process.env.ZLEAP_302_API_KEY, process.env['302_API_KEY'], file.apiKey),
    apiBaseUrl:
      firstNonEmpty(db.apiBaseUrl, process.env.ZLEAP_302_API_BASE_URL, file.apiBaseUrl) ?? DEFAULT_302_API_BASE_URL,
    modelBaseUrl:
      firstNonEmpty(db.modelBaseUrl, process.env.ZLEAP_302_MODEL_BASE_URL, file.modelBaseUrl) ??
      DEFAULT_302_MODEL_BASE_URL,
  };
}

function parse302ConfigString(raw: string): Integration302Config {
  return parse302ConfigObject(JSON.parse(raw) as Record<string, unknown>);
}

function parse302ConfigObject(parsed: Record<string, unknown>): Integration302Config {
  return {
    apiKey: stringValue(parsed.apiKey),
    apiBaseUrl: stringValue(parsed.apiBaseUrl),
    modelBaseUrl: stringValue(parsed.modelBaseUrl),
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

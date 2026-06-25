import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CustomModelConfig } from '@zleap/ai';
import { DEFAULT_DATABASE_URL } from './constants.js';
import type { CliSessionPrefs } from './sessionPrefs.js';

export type EmbeddingConfig = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimension?: number;
};

export type CliConfig = {
  model?: CustomModelConfig;
  database?: { url: string };
  embedding?: EmbeddingConfig;
  gateway?: { stateDir?: string };
  /** Set by `zleap init`; skips repeat onboarding in TUI. */
  onboarded?: boolean;
  /** TUI session defaults (run mode + permission mode). */
  session?: CliSessionPrefs;
};

export type PersistenceConfig = {
  databaseUrl?: string;
  embedding?: EmbeddingConfig;
};

export const CONFIG_DIR = join(homedir(), '.zleap');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export type ConfigLoadResult = {
  config: CliConfig;
  /** Set when config.json exists but JSON.parse fails. */
  parseError?: string;
};

export async function loadConfigWithMeta(): Promise<ConfigLoadResult> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    try {
      return { config: JSON.parse(raw) as CliConfig };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { config: {}, parseError: `config.json 无法解析：${message}` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { config: {} };
    }
    return { config: {} };
  }
}

export async function loadConfig(): Promise<CliConfig> {
  const { config } = await loadConfigWithMeta();
  return config;
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function modelLabel(config: CliConfig, fallback = '未配置模型'): string {
  return config.model?.displayName ?? config.model?.model ?? fallback;
}

export function resolvePersistence(config: CliConfig): PersistenceConfig {
  const databaseUrl = resolveConfiguredDatabaseUrl(config) ?? DEFAULT_DATABASE_URL;
  const envModel = process.env.ZLEAP_EMBED_MODEL;
  const embedding: EmbeddingConfig | undefined =
    config.embedding ??
    (envModel
      ? {
          model: envModel,
          baseUrl: process.env.ZLEAP_EMBED_BASE_URL,
          apiKey: process.env.ZLEAP_EMBED_API_KEY,
          dimension: process.env.ZLEAP_EMBED_DIM ? Number(process.env.ZLEAP_EMBED_DIM) : undefined,
        }
      : undefined);
  return { databaseUrl, embedding };
}

export function resolveConfiguredDatabaseUrl(config: CliConfig): string | undefined {
  return firstNonEmpty(process.env.ZLEAP_DATABASE_URL, process.env.DATABASE_URL, config.database?.url);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/** Read a dotted path from config, e.g. `model.baseUrl`. */
export function getConfigValue(config: CliConfig, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Immutably set a dotted path on config. */
export function setConfigValue(config: CliConfig, path: string, value: unknown): CliConfig {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return config;
  const clone = structuredClone(config) as Record<string, unknown>;
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = current[key];
    if (!next || typeof next !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
  return clone as CliConfig;
}

/** Flatten config for display (secrets masked). */
export function flattenConfig(config: CliConfig, prefix = ''): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(config)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push(...flattenConfig(value as CliConfig, full));
      continue;
    }
    rows.push({ key: full, value: formatConfigValue(full, value) });
  }
  return rows;
}

function formatConfigValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  if (/secret|apikey|api_key|password|token/i.test(key) && text.length > 0) {
    return '***';
  }
  return text;
}

/** Map config.json dotted paths to canonical env keys for `config get`. */
export const CONFIG_ENV_MAP: Record<string, string> = {
  'database.url': 'ZLEAP_DATABASE_URL',
  'model.baseUrl': 'ZLEAP_MODEL_BASE_URL',
  'model.apiKey': 'ZLEAP_MODEL_API_KEY',
  'model.model': 'ZLEAP_MODEL_NAME',
  'model.protocol': 'ZLEAP_MODEL_PROTOCOL',
  'embedding.model': 'ZLEAP_EMBED_MODEL',
  'embedding.baseUrl': 'ZLEAP_EMBED_BASE_URL',
  'embedding.apiKey': 'ZLEAP_EMBED_API_KEY',
  'embedding.dimension': 'ZLEAP_EMBED_DIM',
};

export function envKeyForConfigPath(path: string): string | undefined {
  return CONFIG_ENV_MAP[path];
}

/** Env keys the CLI cares about for `config list`. */
export const TRACKED_ENV_KEYS = [
  'ZLEAP_DATABASE_URL',
  'DATABASE_URL',
  'ZLEAP_MODEL_BASE_URL',
  'ZLEAP_MODEL_API_KEY',
  'ZLEAP_MODEL_NAME',
  'ZLEAP_MODEL_PROTOCOL',
  'ZLEAP_EMBED_MODEL',
  'ZLEAP_EMBED_BASE_URL',
  'ZLEAP_EMBED_API_KEY',
  'ZLEAP_EMBED_DIM',
  'ZLEAP_302_API_KEY',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
] as const;

export function trackedEnvEntries(): Array<{ key: string; value: string; set: boolean }> {
  return TRACKED_ENV_KEYS.map((key) => {
    const raw = process.env[key];
    const set = Boolean(raw && raw.trim());
    const masked = /SECRET|KEY|PASSWORD|TOKEN|URL/i.test(key) && set ? '***' : (raw ?? '—');
    return { key, value: set ? masked : '—', set };
  });
}

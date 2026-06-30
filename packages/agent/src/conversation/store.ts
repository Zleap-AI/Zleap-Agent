import { embed, fauxEmbed } from '@zleap/ai';
import { DEFAULT_AVATAR_ID, type ModelConfigRecord } from '@zleap/core';
import { DEFAULT_DATABASE_URL } from '../constants.js';
import { createStore, seedSuperAgentDefaults, type Embedder, type ZleapStore } from '@zleap/store';
import { setIntegration302Store } from '../integration302.js';

const DEFAULT_EMBED_DIM = 1536;
const FAUX_EMBED_DIM = 64;

/** Resolved embedding service: which endpoint/model vectorizes memory text. */
export type ResolvedEmbedding = {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Declared by the source; may disagree with the schema (then it's reported). */
  dimension?: number;
};

/** Embedding service from env (ZLEAP_EMBED_* → ZLEAP_MODEL_* → LLM_*). */
export function embeddingFromEnv(): ResolvedEmbedding | undefined {
  const model = process.env.ZLEAP_EMBED_MODEL;
  const baseUrl = process.env.ZLEAP_EMBED_BASE_URL ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = process.env.ZLEAP_EMBED_API_KEY ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  if (!model || !baseUrl || !apiKey) {
    return undefined;
  }
  const dim = process.env.ZLEAP_EMBED_DIM ? Number(process.env.ZLEAP_EMBED_DIM) : undefined;
  return { model, baseUrl, apiKey, ...(Number.isFinite(dim) ? { dimension: dim } : {}) };
}

/** Embedding service from a DB model config row, falling back to env for creds. */
export function embeddingFromRecord(record: ModelConfigRecord): ResolvedEmbedding | undefined {
  const config = (record.config ?? {}) as Record<string, unknown>;
  const baseUrl = str(config.baseUrl) ?? str(config.baseURL)
    ?? process.env.ZLEAP_EMBED_BASE_URL ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = str(config.apiKey)
    ?? process.env.ZLEAP_EMBED_API_KEY ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  if (!record.model || !baseUrl || !apiKey) {
    return undefined;
  }
  const dim = typeof config.embeddingDimension === 'number' ? config.embeddingDimension : undefined;
  return { model: record.model, baseUrl, apiKey, ...(dim ? { dimension: dim } : {}) };
}

/**
 * Data-first embedding resolution: the default embedding model row in the DB
 * wins, then env. Reads never touch the embedder, so a bootstrap store with any
 * embedder can resolve this safely.
 */
export async function resolveEmbedding(store: ZleapStore | null): Promise<ResolvedEmbedding | undefined> {
  if (store) {
    const rows = await store.models.listModelConfigs({ purpose: 'embedding' }).catch(() => [] as ModelConfigRecord[]);
    const row = rows.find((entry) => entry.config?.isDefault === true) ?? rows[0];
    const fromDb = row ? embeddingFromRecord(row) : undefined;
    if (fromDb) {
      return fromDb;
    }
  }
  return embeddingFromEnv();
}

export type SharedStoreOptions = {
  /** Defaults to ZLEAP_DATABASE_URL → DATABASE_URL → runtime local DB. */
  databaseUrl?: string;
  /** Avatar to seed when missing. Defaults to the built-in super agent. */
  seedAvatarId?: string;
  /** Surface non-fatal config warnings (e.g. dimension mismatch). */
  onWarn?: (message: string) => void;
};

/**
 * Open the process-level shared store that long-lived services (gateway, tasks)
 * and the web chat route inject into every engine, so ONE PG pool backs all
 * conversations instead of each engine/request opening its own.
 *
 * Config precedence is data-first: the default embedding model row in the DB
 * wins, then env (ZLEAP_EMBED_*). The vector dimension is deployment-stable
 * (env ZLEAP_EMBED_DIM, else 1536 real / 64 faux) so it always matches the
 * physical schema; a DB row whose dimension disagrees is reported via `onWarn`,
 * not silently applied (changing it would require re-indexing the vectors).
 *
 * The default avatar (persona + global spaces) is seeded once here because an
 * injected store bypasses the engine's own first-run seeding.
 *
 * Returns `null` when no database is configured/reachable, so callers degrade.
 */
export async function createSharedStore(options: SharedStoreOptions = {}): Promise<ZleapStore | null> {
  const databaseUrl = resolveSharedDatabaseUrl(options);
  if (!databaseUrl) {
    return null;
  }

  // Bootstrap with the env embedder so we can read DB model configs (reads don't
  // touch the embedder), then prefer the DB-configured embedding service.
  const envEmbed = embeddingFromEnv();
  const bootDim = dimensionFor(envEmbed);
  let store = await createStore({ connectionString: databaseUrl, dimension: bootDim, embed: makeEmbedder(envEmbed, bootDim) }).catch(() => null);
  if (!store) {
    return null;
  }

  const resolved = await resolveEmbedding(store);
  const finalDim = dimensionFor(resolved);
  if (resolved?.dimension && resolved.dimension !== finalDim) {
    options.onWarn?.(`embedding model declares dimension ${resolved.dimension} but the store uses ${finalDim}; keeping ${finalDim} to match the schema.`);
  }
  if (embeddingDiffers(resolved, envEmbed) || finalDim !== bootDim) {
    if (finalDim !== bootDim) {
      options.onWarn?.(`embedding dimension changed (${bootDim} -> ${finalDim}); existing vectors may need re-indexing.`);
    }
    const rebuilt = await createStore({ connectionString: databaseUrl, dimension: finalDim, embed: makeEmbedder(resolved, finalDim) }).catch(() => null);
    if (rebuilt) {
      await store.close().catch(() => {});
      store = rebuilt;
    }
  }

  const seedAvatarId = options.seedAvatarId ?? DEFAULT_AVATAR_ID;
  const existing = await store.avatars.getAvatar(seedAvatarId).catch(() => undefined);
  if (!existing) {
    await seedSuperAgentDefaults(store, { avatarId: seedAvatarId }).catch(() => {});
  }
  // Make this process's 302 (web_search/read_webpage) resolution DB-first: the
  // shared store is the single source of truth across web/gateway/tasks/CLI, so a
  // key saved in web settings is visible to the gateway without cwd-relative files.
  setIntegration302Store(store);
  return store;
}

function resolveSharedDatabaseUrl(options: SharedStoreOptions): string | undefined {
  if (Object.prototype.hasOwnProperty.call(options, 'databaseUrl')) {
    return options.databaseUrl?.trim() || undefined;
  }
  return process.env.ZLEAP_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

function dimensionFor(resolved: ResolvedEmbedding | undefined): number {
  const envDim = process.env.ZLEAP_EMBED_DIM ? Number(process.env.ZLEAP_EMBED_DIM) : undefined;
  if (envDim && Number.isFinite(envDim)) {
    return envDim;
  }
  if (resolved) {
    return resolved.dimension ?? DEFAULT_EMBED_DIM;
  }
  return FAUX_EMBED_DIM;
}

function makeEmbedder(resolved: ResolvedEmbedding | undefined, dimension: number): Embedder {
  if (resolved) {
    const { baseUrl, apiKey, model } = resolved;
    return async (texts) => (await embed({ baseUrl, apiKey, model, input: texts })).embeddings;
  }
  return async (texts) => texts.map((text) => fauxEmbed(text, dimension));
}

function embeddingDiffers(a: ResolvedEmbedding | undefined, b: ResolvedEmbedding | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a.model !== b.model || a.baseUrl !== b.baseUrl || a.apiKey !== b.apiKey;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

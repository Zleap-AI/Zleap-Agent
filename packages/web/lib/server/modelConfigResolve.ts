import type { ModelConfigRecord } from '@zleap/core';
import { defaultModelId, modelKind, type ModelKind } from '../models';

const MODEL_KINDS: ModelKind[] = ['llm', 'embedding'];

export function resolveDefaultModel(models: ModelConfigRecord[], kind: ModelKind): ModelConfigRecord | undefined {
  const id = defaultModelId(models, kind);
  return id ? models.find((model) => model.id === id) : undefined;
}

/** Ensure each kind with models has exactly one isDefault=true. */
export function normalizeModelDefaults(models: ModelConfigRecord[]): ModelConfigRecord[] {
  let next = models;
  for (const kind of MODEL_KINDS) {
    const scoped = next.filter((model) => modelKind(model) === kind);
    if (scoped.length === 0) continue;
    const flagged = scoped.filter((model) => model.config?.isDefault === true);
    const targetId = (flagged.length >= 1 ? flagged[0]! : scoped[0]!).id;
    next = next.map((model) => {
      if (modelKind(model) !== kind) return model;
      const shouldDefault = model.id === targetId;
      if (model.config?.isDefault === shouldDefault) return model;
      return markDefault(model, shouldDefault);
    });
  }
  return next;
}

export function modelDefaultsChanged(before: ModelConfigRecord[], after: ModelConfigRecord[]): boolean {
  return after.some((model) => {
    const prev = before.find((entry) => entry.id === model.id);
    return prev?.config?.isDefault !== model.config?.isDefault;
  });
}

export function clearDefaultsForKind(models: ModelConfigRecord[], kind: ModelKind): ModelConfigRecord[] {
  return models.map((model) => {
    if (modelKind(model) !== kind || model.config?.isDefault !== true) return model;
    return markDefault(model, false);
  });
}

export function markDefault(model: ModelConfigRecord, isDefault: boolean): ModelConfigRecord {
  return {
    ...model,
    config: { ...(model.config ?? {}), isDefault },
    updatedAt: new Date(),
  };
}

export type ResolvedEmbeddingConfig = {
  model: string;
  baseUrl: string;
  apiKey: string;
  dimension?: number;
};

export function embeddingConfigFromModel(model: ModelConfigRecord): ResolvedEmbeddingConfig | undefined {
  const config = model.config ?? {};
  const baseUrl = stringValue(config.baseUrl) ?? process.env.ZLEAP_EMBED_BASE_URL ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = stringValue(config.apiKey) ?? process.env.ZLEAP_EMBED_API_KEY ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) return undefined;
  const dimension = typeof config.embeddingDimension === 'number' ? config.embeddingDimension : process.env.ZLEAP_EMBED_DIM ? Number(process.env.ZLEAP_EMBED_DIM) : undefined;
  return {
    model: model.model,
    baseUrl,
    apiKey,
    dimension: Number.isFinite(dimension) ? dimension : undefined,
  };
}

export function embeddingConfigFromEnv(): ResolvedEmbeddingConfig | undefined {
  const model = process.env.ZLEAP_EMBED_MODEL;
  if (!model) return undefined;
  const baseUrl = process.env.ZLEAP_EMBED_BASE_URL ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = process.env.ZLEAP_EMBED_API_KEY ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) return undefined;
  const dimension = process.env.ZLEAP_EMBED_DIM ? Number(process.env.ZLEAP_EMBED_DIM) : undefined;
  return {
    model,
    baseUrl,
    apiKey,
    dimension: Number.isFinite(dimension) ? dimension : undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

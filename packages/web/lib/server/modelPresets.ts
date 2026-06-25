import type { ModelConfigRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { modelKind } from '../models';
import { DEFAULT_302_MODEL_BASE_URL, read302IntegrationConfig, resolve302ApiKey, resolve302ModelBaseUrl } from './integration302Config';
import { listFileModelConfigs, replaceFileModelConfigs } from './modelConfigFileStore';

type StoreLike = Pick<ZleapStore, 'models'> | null;

type Default302Model = Pick<ModelConfigRecord, 'id' | 'providerId' | 'model' | 'purpose'> & {
  config: Record<string, unknown>;
};

export const DEFAULT_302_MODEL_CONFIGS: Default302Model[] = [
  {
    id: '302-qwen3-6-flash',
    providerId: 'openai-compatible',
    model: 'qwen3.6-flash',
    purpose: 'main',
    config: {
      displayName: 'qwen3.6-flash',
      providerKey: '302ai',
      baseUrl: DEFAULT_302_MODEL_BASE_URL,
      protocol: 'openai',
      contextWindow: 128000,
      supportsTools: true,
      supportsThinking: true,
    },
  },
  {
    id: '302-qwen3-embedding-0-6b',
    providerId: 'openai-compatible',
    model: 'Qwen/Qwen3-Embedding-0.6B',
    purpose: 'embedding',
    config: {
      displayName: 'Qwen/Qwen3-Embedding-0.6B',
      providerKey: '302ai',
      baseUrl: DEFAULT_302_MODEL_BASE_URL,
      protocol: 'openai',
    },
  },
];

export async function ensureDefault302ModelConfigs(store: StoreLike): Promise<ModelConfigRecord[]> {
  const config = await read302IntegrationConfig();
  const apiKey = resolve302ApiKey(config);
  const modelBaseUrl = resolve302ModelBaseUrl(config);
  if (!store) {
    const existing = await listFileModelConfigs();
    return mergeDefault302Models(existing, apiKey, modelBaseUrl).models;
  }
  return upsertDefault302ModelConfigs(store, { apiKey, modelBaseUrl });
}

export async function upsertDefault302ModelConfigs(
  store: StoreLike,
  options: { apiKey?: string; modelBaseUrl?: string } = {},
): Promise<ModelConfigRecord[]> {
  const existing = store ? await store.models.listModelConfigs() : await listFileModelConfigs();
  const { models, changedIds, replaceFile } = mergeDefault302Models(existing, options.apiKey, options.modelBaseUrl);
  if (store) {
    await Promise.all(models.filter((model) => changedIds.has(model.id)).map((model) => store.models.saveModelConfig(model)));
  } else if (replaceFile) {
    await replaceFileModelConfigs(models);
  }
  return models;
}

export function createDefault302ModelConfigRecords(options: { apiKey?: string; modelBaseUrl?: string } = {}): ModelConfigRecord[] {
  const now = new Date();
  return DEFAULT_302_MODEL_CONFIGS.map((preset, index) => ({
    id: preset.id,
    providerId: preset.providerId,
    model: preset.model,
    purpose: preset.purpose,
    config: {
      ...preset.config,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      baseUrl: options.modelBaseUrl ?? DEFAULT_302_MODEL_BASE_URL,
      isDefault: true,
    },
    createdAt: new Date(now.getTime() + index),
    updatedAt: new Date(now.getTime() + index),
  }));
}

export async function resetFileDefault302ModelConfigs(): Promise<ModelConfigRecord[]> {
  const models = createDefault302ModelConfigRecords();
  await replaceFileModelConfigs(models);
  return models;
}

function mergeDefault302Models(
  models: ModelConfigRecord[],
  apiKey: string | undefined,
  modelBaseUrl = DEFAULT_302_MODEL_BASE_URL,
): { models: ModelConfigRecord[]; changedIds: Set<string>; replaceFile: boolean } {
  const now = new Date();
  const next = [...models];
  const changedIds = new Set<string>();

  for (const preset of DEFAULT_302_MODEL_CONFIGS) {
    const existingIndex = next.findIndex((model) => model.id === preset.id);
    const kind = modelKind({ purpose: preset.purpose });
    const kindHasDefault = next.some((model) => modelKind(model) === kind && model.config?.isDefault === true);
    const config = defaultModelConfig(preset.config, existingIndex >= 0 ? next[existingIndex]!.config : undefined, {
      ...(apiKey ? { apiKey } : {}),
      baseUrl: modelBaseUrl,
      isDefault: existingIndex >= 0 ? next[existingIndex]!.config?.isDefault === true || !kindHasDefault : !kindHasDefault,
    });
    const record: ModelConfigRecord =
      existingIndex >= 0
        ? {
            ...next[existingIndex]!,
            providerId: preset.providerId,
            model: preset.model,
            purpose: preset.purpose,
            config,
            updatedAt: now,
          }
        : {
            id: preset.id,
            providerId: preset.providerId,
            model: preset.model,
            purpose: preset.purpose,
            config,
            createdAt: now,
            updatedAt: now,
          };

    if (existingIndex >= 0) {
      if (modelChanged(next[existingIndex]!, record)) {
        next[existingIndex] = record;
        changedIds.add(record.id);
      }
    } else {
      next.unshift(record);
      changedIds.add(record.id);
    }
  }

  return { models: next, changedIds, replaceFile: changedIds.size > 0 };
}

function defaultModelConfig(
  presetConfig: Record<string, unknown>,
  existingConfig: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...presetConfig, ...(existingConfig ?? {}), ...patch };
  if (!('maxOutputTokens' in presetConfig)) {
    delete config.maxOutputTokens;
  }
  return config;
}

function modelChanged(before: ModelConfigRecord, after: ModelConfigRecord): boolean {
  return (
    before.providerId !== after.providerId ||
    before.model !== after.model ||
    before.purpose !== after.purpose ||
    JSON.stringify(before.config ?? {}) !== JSON.stringify(after.config ?? {})
  );
}

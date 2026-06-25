import type { CustomModelConfig } from '@zleap/ai';
import { modelFromEnv, resolveModelFromStore, toEngineModel, type ModelResolution } from '@zleap/agent/conversation';
import { createSharedStore } from '@zleap/agent/conversation';
import { loadConfigWithMeta, resolvePersistence, type CliConfig, type PersistenceConfig } from '@zleap/host';

/**
 * Effective configuration priority (highest → lowest):
 * 1. TUI sessionModel / CLI --model-config-id (DB pick)
 * 2. CLI flags (--base-url + --api-key + --model, or --model name override)
 * 3. Database default model (when ZLEAP_DATABASE_URL reachable)
 * 4. ~/.zleap/config.json model
 * 5. Environment / .env (ZLEAP_MODEL_* / LLM_*)
 */

export type ModelSource = 'config' | 'db' | 'env' | 'session' | 'none';

export type CliContext = {
  config: CliConfig;
  persistence: PersistenceConfig;
  model?: CustomModelConfig;
  modelSource: ModelSource;
  modelId?: string;
  dbReachable: boolean;
};

export type ResolveCliContextOptions = {
  /** Pick a specific DB model config (CLI --model or session override). */
  modelConfigId?: string;
  /** In-memory model override (TUI session picker). */
  sessionModel?: CustomModelConfig;
};

function mapResolutionSource(source: ModelResolution['source']): ModelSource {
  if (source === 'none') return 'none';
  if (source === 'env') return 'env';
  if (source === 'config' || source === 'space' || source === 'default') return 'db';
  return 'none';
}

/** Unified config + model resolution for TUI, one-shot, and status displays. */
export async function resolveCliContext(options: ResolveCliContextOptions = {}): Promise<CliContext> {
  const { config } = await loadConfigWithMeta();
  const persistence = resolvePersistence(config);

  if (options.sessionModel) {
    let dbReachable = false;
    if (persistence.databaseUrl) {
      const store = await createSharedStore({ onWarn: () => undefined });
      if (store) {
        dbReachable = true;
        await store.close().catch(() => undefined);
      }
    }
    return {
      config,
      persistence,
      model: options.sessionModel,
      modelSource: 'session',
      modelId: options.sessionModel.id,
      dbReachable,
    };
  }

  let dbReachable = false;

  if (persistence.databaseUrl) {
    const store = await createSharedStore({ onWarn: () => undefined });
    if (store) {
      try {
        dbReachable = true;
        const resolution = await resolveModelFromStore(store, {
          ...(options.modelConfigId ? { modelConfigId: options.modelConfigId } : {}),
        });
        if (resolution.model) {
          return {
            config,
            persistence,
            model: resolution.model,
            modelSource: mapResolutionSource(resolution.source),
            modelId: resolution.modelId,
            dbReachable,
          };
        }
      } finally {
        await store.close().catch(() => undefined);
      }
    }
  }

  if (config.model?.baseUrl && config.model.apiKey && config.model.model) {
    return {
      config,
      persistence,
      model: config.model,
      modelSource: 'config',
      modelId: config.model.id,
      dbReachable,
    };
  }

  const envModel = modelFromEnv();
  if (envModel) {
    return {
      config,
      persistence,
      model: envModel,
      modelSource: 'env',
      modelId: envModel.id,
      dbReachable,
    };
  }

  return {
    config,
    persistence,
    modelSource: 'none',
    dbReachable,
  };
}

/** Resolve a DB model config id to engine model (for session picker). */
export async function resolveModelConfigById(modelConfigId: string): Promise<CustomModelConfig | undefined> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return undefined;
  }
  try {
    const record = await store.models.getModelConfig(modelConfigId);
    return record ? toEngineModel(record) : undefined;
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function modelSourceLabel(source: ModelSource): string {
  switch (source) {
    case 'config':
      return '本地 config.json';
    case 'db':
      return '数据库模型';
    case 'session':
      return '当前会话';
    case 'env':
      return '环境变量';
    default:
      return '未配置';
  }
}

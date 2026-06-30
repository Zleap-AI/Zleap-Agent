import { ModelRegistry, ProviderRegistry, type AiRegistries } from './registry.js';
import type { Model } from './types.js';
import { OPENAI_COMPATIBLE_PROVIDER_ID, OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import { ANTHROPIC_PROVIDER_ID, AnthropicProvider } from './providers/anthropic.js';

/** Wire protocol: which API shape the endpoint speaks. 'custom' relays pick one. */
export type ModelProtocol = 'openai' | 'anthropic';

export type CustomModelConfig = {
  id?: string;
  /** Which wire format to speak. Default 'openai'. */
  protocol?: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsCache?: boolean;
  tokenizer?: string;
};

export function createAiRegistries(config?: { models?: CustomModelConfig[] }): AiRegistries {
  const providers = new ProviderRegistry();
  const models = new ModelRegistry();

  providers.register(new OpenAiCompatibleProvider());
  providers.register(new AnthropicProvider());

  for (const modelConfig of config?.models ?? []) {
    models.register(toModel(modelConfig));
  }

  return { providers, models };
}

export function toModel(config: CustomModelConfig): Model {
  return {
    id: config.id ?? config.model,
    provider: config.protocol === 'anthropic' ? ANTHROPIC_PROVIDER_ID : OPENAI_COMPATIBLE_PROVIDER_ID,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    displayName: config.displayName ?? config.model,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    supportsTools: config.supportsTools ?? true,
    supportsThinking: config.supportsThinking,
    supportsCache: config.supportsCache,
    tokenizer: config.tokenizer,
  };
}

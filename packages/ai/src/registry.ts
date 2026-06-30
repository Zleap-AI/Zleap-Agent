import type { Model, ProviderAdapter, ProviderCapabilities } from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Unknown provider: ${id}`);
    }
    return provider;
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }
}

export class ModelRegistry {
  private readonly models = new Map<string, Model>();

  register(model: Model): void {
    if (this.models.has(model.id)) {
      throw new Error(`Model already registered: ${model.id}`);
    }
    this.models.set(model.id, model);
  }

  get(id: string): Model {
    const model = this.models.get(id);
    if (!model) {
      throw new Error(`Unknown model: ${id}`);
    }
    return model;
  }

  list(): Model[] {
    return [...this.models.values()];
  }
}

export type AiRegistries = {
  providers: ProviderRegistry;
  models: ModelRegistry;
};

export function resolveProviderCapabilities(provider: ProviderAdapter, model?: Model): ProviderCapabilities {
  return {
    ...provider.capabilities,
    toolCalling: model?.supportsTools ?? provider.capabilities.toolCalling,
    cacheBreakpoints: model?.supportsCache ?? provider.capabilities.cacheBreakpoints,
    thinking: model?.supportsThinking ?? provider.capabilities.thinking,
    tokenizer: model?.tokenizer ?? provider.capabilities.tokenizer,
    maxOutputTokens: model?.maxOutputTokens,
  };
}

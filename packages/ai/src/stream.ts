import type { ProviderOptions, ProviderRequest, AssistantStreamEvent } from './types.js';
import { resolveProviderCapabilities, type AiRegistries } from './registry.js';
import { prepareProviderRequest } from './providerReplay.js';

export async function* stream(
  registries: AiRegistries,
  modelId: string,
  request: ProviderRequest,
  options?: ProviderOptions,
): AsyncIterable<AssistantStreamEvent> {
  const model = registries.models.get(modelId);
  const provider = registries.providers.get(model.provider);
  const capabilities = resolveProviderCapabilities(provider, model);
  yield* provider.stream(model, prepareProviderRequest(request, { capabilities }), options);
}

export async function completeText(
  registries: AiRegistries,
  modelId: string,
  request: ProviderRequest,
  options?: ProviderOptions,
): Promise<string> {
  let text = '';
  for await (const event of stream(registries, modelId, request, options)) {
    if (event.type === 'text_delta') {
      text += event.text;
    }
    if (event.type === 'error') {
      throw new Error(event.error.message);
    }
  }
  return text;
}

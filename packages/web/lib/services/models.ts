import { getJson, postJson } from '@/lib/api';

export type ModelListEntry = {
  config?: { hasApiKey?: boolean; baseUrl?: string };
  model?: string;
  purpose?: string;
};

/** List configured model providers. */
export async function fetchModels(signal?: AbortSignal): Promise<ModelListEntry[]> {
  const data = await getJson<{ models?: ModelListEntry[] }>('/api/models', { signal });
  return data.models ?? [];
}

export type SaveModelInput = {
  id: string;
  providerId: string;
  model: string;
  kind: string;
  config: Record<string, unknown>;
  isDefault?: boolean;
};

/** Create or update a model provider configuration. */
export function saveModel(input: SaveModelInput): Promise<unknown> {
  return postJson('/api/models', input);
}

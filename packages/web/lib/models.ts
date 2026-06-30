import type { ModelConfigRecord } from '@zleap/core';
import type { ModelConfigView } from '@/lib/useResources';

export type ModelKind = 'llm' | 'embedding';

/** LLM configs use any purpose except embedding; embedding configs use purpose=embedding. */
export function modelKind(model: { purpose?: string }): ModelKind {
  return model.purpose === 'embedding' ? 'embedding' : 'llm';
}

export function purposeForKind(kind: ModelKind): ModelConfigRecord['purpose'] {
  return kind === 'embedding' ? 'embedding' : 'main';
}

export function llmModels(models: ModelConfigView[]): ModelConfigView[] {
  return models.filter((m) => modelKind(m) === 'llm');
}

export function embeddingModels(models: ModelConfigView[]): ModelConfigView[] {
  return models.filter((m) => modelKind(m) === 'embedding');
}

/** Label shown in the composer model picker. */
export function modelDisplayLabel(model: ModelConfigView): string {
  const config = model.config ?? {};
  const display = typeof config.displayName === 'string' ? config.displayName.trim() : '';
  if (display) return display;
  return model.model?.trim() || model.id;
}

export function defaultModelId(models: ModelConfigView[], kind: ModelKind = 'llm'): string | undefined {
  const scoped = models.filter((m) => modelKind(m) === kind);
  if (scoped.length === 0) return undefined;
  const flagged = scoped.find((m) => m.config?.isDefault === true);
  return flagged?.id ?? scoped[0]?.id;
}

/** Whether this model is the effective default within its kind (LLM / Embedding). */
export function isDefaultForKind(model: ModelConfigView, models: ModelConfigView[]): boolean {
  const kind = modelKind(model);
  return defaultModelId(models, kind) === model.id;
}

export function defaultModelIds(models: ModelConfigView[]): Partial<Record<ModelKind, string>> {
  return {
    llm: defaultModelId(models, 'llm'),
    embedding: defaultModelId(models, 'embedding'),
  };
}

export function hasModelApiKey(model: { config?: Record<string, unknown> }): boolean {
  const config = model.config ?? {};
  if (config.hasApiKey === true) return true;
  return typeof config.apiKey === 'string' && config.apiKey.trim().length > 0;
}

export function isConfiguredLlmModel(model: { config?: Record<string, unknown>; model?: string; purpose?: string }): boolean {
  return modelKind(model) === 'llm' && Boolean(model.model?.trim()) && hasModelApiKey(model);
}

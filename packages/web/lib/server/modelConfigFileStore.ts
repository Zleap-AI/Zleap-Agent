import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ModelConfigRecord } from '@zleap/core';
import { modelKind, type ModelKind } from '../models';
import { clearDefaultsForKind, markDefault } from './modelConfigResolve';

type SerializedModelConfig = Omit<ModelConfigRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

function modelConfigPath(): string {
  return process.env.ZLEAP_WEB_MODEL_CONFIG_PATH ?? join(process.cwd(), '.zleap', 'web-models.json');
}

export async function listFileModelConfigs(): Promise<ModelConfigRecord[]> {
  const raw = await readFile(modelConfigPath(), 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return '[]';
    }
    throw error;
  });
  const rows = JSON.parse(raw) as SerializedModelConfig[];
  return rows.map(deserializeModelConfig);
}

export async function getFileModelConfig(id: string): Promise<ModelConfigRecord | undefined> {
  const models = await listFileModelConfigs();
  return models.find((model) => model.id === id);
}

export async function saveFileModelConfig(record: ModelConfigRecord): Promise<void> {
  const models = await listFileModelConfigs();
  const next = [record, ...models.filter((model) => model.id !== record.id)];
  await writeFileModelConfigs(next);
}

export async function deleteFileModelConfig(id: string): Promise<ModelConfigRecord | undefined> {
  const models = await listFileModelConfigs();
  const target = models.find((model) => model.id === id);
  if (!target) return undefined;
  await writeFileModelConfigs(models.filter((model) => model.id !== id));
  return target;
}

export async function clearFileDefaultModels(kind: ModelKind): Promise<void> {
  const models = await listFileModelConfigs();
  await writeFileModelConfigs(clearDefaultsForKind(models, kind));
}

export async function setFileDefaultModel(id: string, isDefault: boolean): Promise<ModelConfigRecord | undefined> {
  const models = await listFileModelConfigs();
  const target = models.find((model) => model.id === id);
  if (!target) return undefined;
  const kind = modelKind(target);
  const next = models.map((model) => {
    if (model.id === id) return markDefault(model, isDefault);
    if (isDefault && modelKind(model) === kind) return markDefault(model, false);
    return model;
  });
  await writeFileModelConfigs(next);
  return next.find((model) => model.id === id);
}

export async function replaceFileModelConfigs(models: ModelConfigRecord[]): Promise<void> {
  await writeFileModelConfigs(models);
}

export { markDefault as markFileDefault };

async function writeFileModelConfigs(models: ModelConfigRecord[]): Promise<void> {
  const file = modelConfigPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(models.map(serializeModelConfig), null, 2)}\n`, 'utf8');
}

function serializeModelConfig(model: ModelConfigRecord): SerializedModelConfig {
  return {
    ...model,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function deserializeModelConfig(model: SerializedModelConfig): ModelConfigRecord {
  return {
    ...model,
    createdAt: new Date(model.createdAt),
    updatedAt: new Date(model.updatedAt),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

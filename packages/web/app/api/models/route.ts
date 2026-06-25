import { type ModelConfigRecord } from '@zleap/core';
import { modelKind, purposeForKind, type ModelKind } from '../../../lib/models';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { avatarErrorResponse, createModelConfig, ensureAvatar } from '../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import {
  clearFileDefaultModels,
  deleteFileModelConfig,
  getFileModelConfig,
  listFileModelConfigs,
  replaceFileModelConfigs,
  saveFileModelConfig,
  setFileDefaultModel,
} from '../../../lib/server/modelConfigFileStore';
import { clearDefaultsForKind, markDefault, modelDefaultsChanged, normalizeModelDefaults } from '../../../lib/server/modelConfigResolve';
import { upsertDefault302ModelConfigs } from '../../../lib/server/modelPresets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    const raw = await upsertDefault302ModelConfigs(null);
    const models = await persistNormalizedModels(null, raw);
    return Response.json({ models: models.map(redactModel), persistence: { enabled: false, reachable: false, fallback: 'file' } });
  }
  try {
    const raw = await upsertDefault302ModelConfigs(store);
    const models = await persistNormalizedModels(store, raw);
    return Response.json({ models: models.map(redactModel), persistence: { enabled: true, reachable: true } });
  } finally {
    await store.close().catch(() => {});
  }
}

async function persistNormalizedModels(
  store: NonNullable<Awaited<ReturnType<typeof storeFromEnv>>> | null,
  models: ModelConfigRecord[],
): Promise<ModelConfigRecord[]> {
  const normalized = normalizeModelDefaults(models);
  if (!modelDefaultsChanged(models, normalized)) {
    return normalized;
  }
  if (store) {
    await Promise.all(normalized.map((model) => store.models.saveModelConfig(model)));
  } else {
    await replaceFileModelConfigs(normalized);
  }
  return normalized;
}

/** Strip the stored API key before sending a model config to the browser; expose
 *  only a boolean so the UI can show whether a key is configured. */
function redactModel(model: ModelConfigRecord): ModelConfigRecord {
  const config = model.config ?? {};
  if (!('apiKey' in config)) return model;
  const { apiKey, ...rest } = config as Record<string, unknown>;
  return { ...model, config: { ...rest, hasApiKey: Boolean(apiKey) } };
}

function resolvePurpose(body: { purpose?: ModelConfigRecord['purpose']; kind?: ModelKind }): ModelConfigRecord['purpose'] {
  if (body.kind) return purposeForKind(body.kind);
  return body.purpose ?? 'main';
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    try {
      const body = (await req.json()) as {
        id?: string;
        providerId?: string;
        model?: string;
        purpose?: ModelConfigRecord['purpose'];
        kind?: ModelKind;
        config?: Record<string, unknown>;
      };
      if (!body.id?.trim() || !body.model?.trim()) {
        return Response.json({ error: 'id_model_required' }, { status: 400 });
      }
      const purpose = resolvePurpose(body);
      await clearFileDefaultModels(modelKind({ purpose }));
      const now = new Date();
      const model: ModelConfigRecord = {
        id: body.id.trim(),
        providerId: body.providerId?.trim() || 'openai-compatible',
        model: body.model.trim(),
        purpose,
        config: { ...(body.config ?? {}), isDefault: true },
        createdAt: now,
        updatedAt: now,
      };
      await saveFileModelConfig(model);
      return Response.json({ model: redactModel(model) }, { status: 201 });
    } catch (error) {
      return avatarErrorResponse(error);
    }
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      providerId?: string;
      model?: string;
      purpose?: ModelConfigRecord['purpose'];
      kind?: ModelKind;
      config?: Record<string, unknown>;
      avatarId?: string;
    };
    if (!body.id?.trim() || !body.model?.trim()) {
      return Response.json({ error: 'id_model_required' }, { status: 400 });
    }
    await ensureAvatar(store, body.avatarId);
    const purpose = resolvePurpose(body);
    await clearDefaultModels(store, modelKind({ purpose }));
    const model = await createModelConfig(store, {
      id: body.id.trim(),
      providerId: body.providerId?.trim() || 'openai-compatible',
      model: body.model.trim(),
      purpose,
      config: { ...(body.config ?? {}), isDefault: true },
    });
    return Response.json({ model: redactModel(model) }, { status: 201 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    try {
      const body = (await req.json()) as {
        id?: string;
        isDefault?: boolean;
        providerId?: string;
        model?: string;
        purpose?: ModelConfigRecord['purpose'];
        kind?: ModelKind;
        config?: Record<string, unknown>;
      };
      if (!body.id?.trim()) {
        return Response.json({ error: 'id_required' }, { status: 400 });
      }
      await upsertDefault302ModelConfigs(null);
      if (body.providerId !== undefined || body.model !== undefined || body.config !== undefined || body.purpose !== undefined || body.kind !== undefined) {
        const model = await getFileModelConfig(body.id.trim());
        if (!model) {
          return Response.json({ error: 'model_not_found' }, { status: 404 });
        }
        const nextPurpose = body.kind !== undefined || body.purpose !== undefined ? resolvePurpose(body) : model.purpose;
        const kindChanged = modelKind(model) !== modelKind({ purpose: nextPurpose });
        const next: ModelConfigRecord = {
          ...model,
          providerId: body.providerId?.trim() || model.providerId,
          model: body.model?.trim() || model.model,
          purpose: nextPurpose,
          config: {
            ...(model.config ?? {}),
            ...(body.config ?? {}),
            isDefault: kindChanged ? false : model.config?.isDefault === true,
          },
          updatedAt: new Date(),
        };
        await saveFileModelConfig(next);
        return Response.json({ model: redactModel(next) });
      }
      const model = await setFileDefaultModel(body.id.trim(), body.isDefault === true);
      if (!model) {
        return Response.json({ error: 'model_not_found' }, { status: 404 });
      }
      return Response.json({ model: redactModel(model) });
    } catch (error) {
      return avatarErrorResponse(error);
    }
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      isDefault?: boolean;
      providerId?: string;
      model?: string;
      purpose?: ModelConfigRecord['purpose'];
      kind?: ModelKind;
      config?: Record<string, unknown>;
    };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await upsertDefault302ModelConfigs(store);
    const model = await store.models.getModelConfig(body.id.trim());
    if (!model) {
      return Response.json({ error: 'model_not_found' }, { status: 404 });
    }

    if (body.providerId !== undefined || body.model !== undefined || body.config !== undefined || body.purpose !== undefined || body.kind !== undefined) {
      const nextPurpose = body.kind !== undefined || body.purpose !== undefined ? resolvePurpose(body) : model.purpose;
      const kindChanged = modelKind(model) !== modelKind({ purpose: nextPurpose });
      const next: ModelConfigRecord = {
        ...model,
        providerId: body.providerId?.trim() || model.providerId,
        model: body.model?.trim() || model.model,
        purpose: nextPurpose,
        config: {
          ...(model.config ?? {}),
          ...(body.config ?? {}),
          isDefault: kindChanged ? false : model.config?.isDefault === true,
        },
        updatedAt: new Date(),
      };
      await store.models.saveModelConfig(next);
      return Response.json({ model: redactModel(next) });
    }

    if (body.isDefault) {
      await clearDefaultModels(store, modelKind(model));
      const next = markDefault(model, true);
      await store.models.saveModelConfig(next);
      return Response.json({ model: redactModel(next) });
    }
    const next = markDefault(model, false);
    await store.models.saveModelConfig(next);
    return Response.json({ model: redactModel(next) });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    try {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const id = body.id?.trim();
      if (!id) {
        return Response.json({ error: 'id_required' }, { status: 400 });
      }
      await upsertDefault302ModelConfigs(null);
      const deleted = await deleteFileModelConfig(id);
      if (!deleted) {
        return Response.json({ error: 'model_not_found' }, { status: 404 });
      }
      const remaining = await listFileModelConfigs();
      await persistNormalizedModels(null, remaining);
      return Response.json({ ok: true, model: redactModel(deleted) });
    } catch (error) {
      return avatarErrorResponse(error);
    }
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await upsertDefault302ModelConfigs(store);
    const model = await store.models.getModelConfig(id);
    if (!model) {
      return Response.json({ error: 'model_not_found' }, { status: 404 });
    }
    await store.models.deleteModelConfig(id);
    await persistNormalizedModels(store, await store.models.listModelConfigs());
    return Response.json({ ok: true, model: redactModel(model) });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

async function clearDefaultModels(store: NonNullable<Awaited<ReturnType<typeof storeFromEnv>>>, kind: ModelKind): Promise<void> {
  const models = await store.models.listModelConfigs();
  await Promise.all(clearDefaultsForKind(models, kind).map((model) => store.models.saveModelConfig(model)));
}

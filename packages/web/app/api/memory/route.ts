import { DEFAULT_AVATAR_ID, type AgentNote, type RecordRef } from '@zleap/core';
import { ChatEngine } from '@zleap/agent/engine';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import { mainMemoryScope, memoryOrchestratorFromStore, serializeNote, serializeRecord } from '../../../lib/server/memoryService';
import { modelKind } from '../../../lib/models';
import type { ZleapStore } from '@zleap/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Active memory for the Memory management page: A 线 notes + B 线 event records. */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({
      memories: [],
      candidates: [],
      actor: serializeActor(actor),
      persistence: { enabled: false, reachable: false },
      dream: undefined,
    });
  }
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId')?.trim() || DEFAULT_AVATAR_ID;
  try {
    const orchestrator = memoryOrchestratorFromStore(store);
    const scope = mainMemoryScope(agentId, actor);
    const { impressions, experiences, records } = await orchestrator.list(scope, 100);
    const recordDetails = await Promise.all(records.map((record) => scopedRecordDetail(orchestrator, record, scope)));
    const experienceDetails = await Promise.all(experiences.map((record) => scopedRecordDetail(orchestrator, record, scope)));
    return Response.json({
      memories: [
        ...impressions.map(serializeNote),
        ...recordDetails.map((record) => serializeRecord(record, scope)),
        ...experienceDetails.map((record) => serializeRecord(record, { agentId })),
      ],
      // 双线模型不再有候选/审核流程；保留字段以兼容 0613 管理台 UI。
      candidates: [],
      actor: serializeActor(actor),
      persistence: { enabled: true, reachable: true },
      dream: await dreamSummary(store, agentId, actor),
    });
  } catch (error) {
    return Response.json({
      memories: [],
      candidates: [],
      actor: serializeActor(actor),
      error: error instanceof Error ? error.message : String(error),
      dream: await dreamSummary(store, agentId, actor).catch(() => undefined),
    });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const body = (await req.json().catch(() => ({}))) as {
    kind?: 'impression' | 'experience' | 'event';
    targetType?: 'agent' | 'user' | 'space_user' | 'space_shared';
    targetUserId?: string;
    spaceId?: string;
    memory?: string;
    agentId?: string;
    subject?: 'user' | 'agent';
    visibility?: 'user' | 'global';
    action?: 'run_dream';
  };
  const agentId = body.agentId?.trim() || DEFAULT_AVATAR_ID;
  if (body.action === 'run_dream') {
    const store = await storeFromEnv();
    if (!store) {
      return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
    }
    try {
      const model = await modelFromStore(store);
      if (!model) {
        return Response.json({ error: 'model_unconfigured' }, { status: 400 });
      }
      const engine = new ChatEngine(model, undefined, {
        agent: { id: agentId, label: agentId },
        store,
      });
      const dream = await engine.runMemoryDreamNow(actor, { minIntervalMs: 0, minSessions: 1, minToolEvents: 1 });
      return Response.json({ dream, summary: await dreamSummary(store, agentId, actor) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    } finally {
      await store.close().catch(() => {});
    }
  }
  if (body.kind === 'event') {
    return Response.json({ error: 'event_kind_manual_unsupported' }, { status: 400 });
  }
  if (!body.memory?.trim()) {
    return Response.json({ error: 'memory_required' }, { status: 400 });
  }
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }
  try {
    const kind = body.kind === 'experience' ? 'experience' : 'impression';
    const scope = mainMemoryScope(agentId, actor);
    const subject = kind === 'impression' && (body.subject === 'agent' || body.targetType === 'agent') ? 'agent' : 'user';
    const visibility = subject === 'agent' && body.visibility === 'global' ? 'global' : 'user';
    if (subject === 'agent' && visibility === 'global' && !canWriteGlobalAgentSelf(actor)) {
      return Response.json({ error: 'global_agent_self_memory_forbidden' }, { status: 403 });
    }
    if (kind === 'experience') {
      scope.userId = undefined;
      scope.spaceId = undefined;
    } else if (subject === 'agent' && visibility === 'global') {
      scope.userId = undefined;
      scope.spaceId = undefined;
    } else {
      scope.userId = body.targetUserId?.trim() || actor.userId;
    }
    const orchestrator = memoryOrchestratorFromStore(store);
    const memory = await orchestrator.remember(
      {
        kind,
        about: subject,
        visibility,
        memory: body.memory.trim(),
      },
      scope,
    );
    return Response.json({ memory: isRecordMemory(memory) ? serializeRecord(memory, { agentId }) : serializeNote(memory) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

/** Edit = archive the old note and write a replacement (notes have no in-place update). */
export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    memory?: string;
    agentId?: string;
    candidateId?: string;
    action?: 'promote' | 'reject';
  };
  if (body.candidateId?.trim()) {
    return Response.json({ error: 'candidates_removed' }, { status: 400 });
  }
  if (!body.id?.trim()) {
    return Response.json({ error: 'id_required' }, { status: 400 });
  }
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }
  try {
    const agentId = body.agentId?.trim() || DEFAULT_AVATAR_ID;
    const existing = await store.notes.getById(body.id.trim());
    if (!existing || !ownsNote(existing, agentId, actor)) {
      return Response.json({ error: `memory not found: ${body.id.trim()}` }, { status: 400 });
    }
    if (existing.kind !== 'impression') {
      return Response.json({ error: 'memory_edit_unsupported' }, { status: 400 });
    }
    await store.notes.archive(existing.id);
    const orchestrator = memoryOrchestratorFromStore(store);
    const memory = await orchestrator.remember(
      {
        kind: existing.kind,
        about: existing.subject ?? 'user',
        visibility: existing.subject === 'agent' && !existing.userId ? 'global' : 'user',
        memory: body.memory?.trim() || existing.memory,
      },
      {
        agentId,
        userId: existing.userId,
        actorRole: actor.role,
        spaceId: existing.userId ? existing.spaceId ?? mainMemoryScope(agentId, actor).spaceId : undefined,
      },
    );
    return Response.json({ memory: isRecordMemory(memory) ? serializeRecord(memory, { agentId }) : serializeNote(memory) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const body = (await req.json().catch(() => ({}))) as { id?: string; agentId?: string };
  if (!body.id?.trim()) {
    return Response.json({ error: 'id_required' }, { status: 400 });
  }
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }
  try {
    const agentId = body.agentId?.trim() || DEFAULT_AVATAR_ID;
    const existing = await store.notes.getById(body.id.trim());
    if (!existing || !ownsNote(existing, agentId, actor)) {
      const scope = mainMemoryScope(agentId, actor);
      const orchestrator = memoryOrchestratorFromStore(store);
      const memory = await orchestrator.detail(body.id.trim(), scope);
      if (memory && isRecordMemory(memory)) {
        await store.core.setEventStatus(memory.id, 'archived');
        return Response.json({ ok: true });
      }
      return Response.json({ error: `memory not found: ${body.id.trim()}` }, { status: 400 });
    }
    await store.notes.archive(existing.id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store.close().catch(() => {});
  }
}

function serializeActor(actor: { userId?: string; role?: string }) {
  return {
    userId: actor.userId ?? '',
    role: actor.role,
  };
}

function ownsNote(
  note: { agentId: string; userId?: string; subject?: 'user' | 'agent' },
  agentId: string,
  actor: { userId?: string; role?: string },
): boolean {
  if (note.agentId !== agentId) return false;
  if (note.subject === 'agent' && !note.userId) {
    if (!canWriteGlobalAgentSelf(actor)) return false;
    return true;
  }
  if (actor.userId && note.userId !== actor.userId) return false;
  return true;
}

function canWriteGlobalAgentSelf(actor: { role?: string }): boolean {
  return actor.role === 'creator' || actor.role === 'admin';
}

async function scopedRecordDetail(
  orchestrator: ReturnType<typeof memoryOrchestratorFromStore>,
  record: RecordRef,
  scope: ReturnType<typeof mainMemoryScope>,
): Promise<RecordRef> {
  const detail = await orchestrator.detail(record.id, scope).catch(() => undefined);
  return detail && isRecordMemory(detail) ? detail : record;
}

function isRecordMemory(memory: AgentNote | RecordRef): memory is RecordRef {
  return 'keywords' in memory;
}

async function dreamSummary(store: ZleapStore, agentId: string, actor: { userId?: string; tenantId?: string }) {
  const tasks = (store as unknown as { tasks?: Record<string, unknown> }).tasks;
  if (!tasks || typeof tasks.listTasks !== 'function' || typeof tasks.listRuns !== 'function') {
    return undefined;
  }
  const taskRows = await store.tasks.listTasks({ userId: actor.userId, tenantId: actor.tenantId, includeDeleted: false, limit: 500 });
  const task = taskRows.find((row) => row.avatarId === agentId && row.type === 'memory_dream');
  if (!task) {
    return { status: 'idle', runs: [] };
  }
  const runs = await store.tasks.listRuns({ taskId: task.id, userId: actor.userId, tenantId: actor.tenantId, limit: 5 });
  const latest = runs[0];
  return {
    status: latest?.status ?? 'idle',
    taskId: task.id,
    lastRunAt: latest?.finishedAt?.toISOString() ?? latest?.startedAt?.toISOString() ?? latest?.scheduledFor?.toISOString(),
    running: runs.some((run) => run.status === 'queued' || run.status === 'running'),
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt?.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      summary: run.summary,
      error: run.error,
      metadata: run.metadata,
    })),
  };
}

type EngineModelConfig = NonNullable<ConstructorParameters<typeof ChatEngine>[0]>;

async function modelFromStore(store: ZleapStore): Promise<EngineModelConfig | undefined> {
  const models = await store.models.listModelConfigs();
  const selected = models.filter((model) => modelKind(model) === 'llm')
    .find((model) => model.config?.isDefault === true) ?? models.find((model) => modelKind(model) === 'llm');
  if (!selected) return undefined;
  const config = selected.config ?? {};
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) return undefined;
  return {
    protocol: selected.providerId === 'anthropic' || config.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl,
    apiKey,
    model: selected.model,
    id: selected.id,
    displayName: typeof config.displayName === 'string' ? config.displayName : selected.id,
    contextWindow: typeof config.contextWindow === 'number' ? config.contextWindow : undefined,
    maxOutputTokens: typeof config.maxOutputTokens === 'number' ? config.maxOutputTokens : undefined,
    supportsTools: typeof config.supportsTools === 'boolean' ? config.supportsTools : undefined,
    supportsThinking: typeof config.supportsThinking === 'boolean' ? config.supportsThinking : undefined,
    supportsCache: typeof config.supportsCache === 'boolean' ? config.supportsCache : undefined,
    tokenizer: typeof config.tokenizer === 'string' && config.tokenizer.trim() ? config.tokenizer.trim() : undefined,
  };
}

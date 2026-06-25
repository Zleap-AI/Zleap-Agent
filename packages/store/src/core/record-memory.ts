/**
 * B 线 record 适配器：把 store.core（通用引擎）适配成 agent 的 RecordMemoryPort。
 *
 * store 依赖 agent，所以这里直接实现 agent 定义的端口，agent 层无需认识 core。
 * group_id 固定 'memory'；对事 kind='work'，经验 kind='experience'。
 */
import type {
  RecordDetail,
  RecordFragmentMessage,
  RecordMemoryKind,
  RecordHit,
  RecordMemoryPort,
  RecordRef,
  RecordScope,
  WriteExperienceInput,
} from '@zleap/core';
import { ingestFragment, type CoreExtractor, type CoreMemoryReconciler, type EmbedBatch } from './extract.js';
import type { CoreEvent, CoreReranker, CoreStore, RecallHit } from './types.js';

export const RECORD_GROUP_ID = 'memory';
export const WORK_KIND: RecordMemoryKind = 'work';
export const EXPERIENCE_KIND: RecordMemoryKind = 'experience';
export const RECORD_KIND = WORK_KIND;

export type RecordMemoryDeps = {
  core: CoreStore;
  /** Batch embedder for event ingestion (B 线 only). */
  embed?: EmbedBatch;
  /** Single-text embedder for recall queries. */
  embedQuery?: (text: string) => Promise<number[]>;
  /** Optional LLM extractor; absent/failed extraction writes no events. */
  extractor?: CoreExtractor;
  /** Optional LLM reranker for precise recall. */
  reranker?: CoreReranker;
  /** Related-memory threshold; intentionally higher than normal recall. */
  relatedMinScore?: number;
  relatedCandidateLimit?: number;
  relatedGraphHops?: 0 | 1 | 2;
  reconciler?: CoreMemoryReconciler;
};

function eventWorkKind(event: CoreEvent): 'process' | 'result' | undefined {
  const workKind = event.metadata?.workKind;
  return workKind === 'process' || workKind === 'result' ? workKind : undefined;
}

function toRef(event: CoreEvent, kind?: RecordMemoryKind): RecordRef {
  return {
    id: event.id,
    kind,
    memory: event.memory,
    keywords: event.keywords,
    messageIds: event.messageIds,
    workKind: eventWorkKind(event),
    status: event.status,
    relationId: event.relationId,
    supersedesId: event.supersedesId,
    supersededBy: event.supersededBy,
    supersededAt: event.supersededAt,
    confidence: event.confidence,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function toHit(hit: RecallHit, kind?: RecordMemoryKind): RecordHit {
  return { ...toRef(hit, kind), score: hit.score, paths: hit.paths };
}

function workScope(scope: RecordScope): RecordScope | undefined {
  if (!scope.userId || !scope.spaceId || !scope.threadId) return undefined;
  return {
    agentId: scope.agentId,
    userId: scope.userId,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    threadId: scope.threadId,
  };
}

function experienceScope(scope: RecordScope): RecordScope {
  return {
    agentId: scope.agentId,
  };
}

function canReadSource(
  kind: string,
  source: { agentId: string; userId?: string; tenantId?: string; spaceId?: string; threadId?: string },
  scope: RecordScope,
): boolean {
  if (source.agentId !== scope.agentId) return false;
  if (kind === EXPERIENCE_KIND) return true;
  return Boolean(
    scope.userId &&
    scope.spaceId &&
    scope.threadId &&
    source.userId === scope.userId &&
    source.spaceId === scope.spaceId &&
    source.threadId === scope.threadId &&
    (scope.tenantId === undefined || source.tenantId === scope.tenantId),
  );
}

export function createRecordMemoryPort(deps: RecordMemoryDeps): RecordMemoryPort {
  return {
    ingest: async ({ scope, messages }: { scope: RecordScope; messages: RecordFragmentMessage[] }) => {
      const scoped = workScope(scope);
      if (!scoped) return [];
      const events = await ingestFragment(
        { groupId: RECORD_GROUP_ID, kind: WORK_KIND, scope: scoped, messages },
        {
          core: deps.core,
          embed: deps.embed,
          extractor: deps.extractor,
          relatedMinScore: deps.relatedMinScore,
          relatedCandidateLimit: deps.relatedCandidateLimit,
          relatedGraphHops: deps.relatedGraphHops,
          reconciler: deps.reconciler,
        },
      );
      return events.map((event) => toRef(event, WORK_KIND));
    },
    writeExperience: async (input: WriteExperienceInput) => {
      const scope = experienceScope(input.scope);
      const [embedding] = deps.embed ? await deps.embed([input.memory]).catch(() => []) : [];
      const source = await deps.core.ensureSource({
        groupId: RECORD_GROUP_ID,
        kind: EXPERIENCE_KIND,
        scope,
        name: EXPERIENCE_KIND,
      });
      const core = Object.create(deps.core) as CoreStore;
      core.ensureSource = async () => source;
      const events = await ingestFragment(
        {
          groupId: RECORD_GROUP_ID,
          kind: EXPERIENCE_KIND,
          scope,
          messages: [{ role: 'assistant', content: input.memory, id: input.scope.threadId }],
        },
        {
          core,
          embed: embedding ? async () => [embedding] : undefined,
          extractor: async () => [{
            memory: input.memory,
            metadata: {
              ...(input.scope.userId ? { originUserId: input.scope.userId } : {}),
            },
            keywords: input.keywords,
            confidence: input.confidence,
          }],
          relatedMinScore: deps.relatedMinScore,
          relatedCandidateLimit: deps.relatedCandidateLimit,
          relatedGraphHops: deps.relatedGraphHops,
          reconciler: deps.reconciler,
        },
      );
      const event = events[0];
      if (!event) {
        throw new Error('experience memory write produced no event');
      }
      return toRef(event, EXPERIENCE_KIND);
    },
    recall: async (input) => {
      const { scope, query, limit, mode } = input;
      const embedding = deps.embedQuery ? await deps.embedQuery(query).catch(() => undefined) : undefined;
      const kinds: RecordMemoryKind[] = input.kinds?.length ? input.kinds : [WORK_KIND, EXPERIENCE_KIND];
      const perKind = await Promise.all(kinds.map(async (kind) => {
        const scoped = kind === WORK_KIND ? workScope(scope) : experienceScope(scope);
        if (!scoped) return [] as RecordHit[];
        const hits = await deps.core.recall({
          groupId: RECORD_GROUP_ID,
          kind,
          scope: scoped,
          queryText: query,
          embedding: embedding && embedding.length ? embedding : undefined,
          limit,
          mode: mode ?? 'fast',
          rerank: mode === 'precise' ? deps.reranker : undefined,
        });
        return hits.map((hit) => toHit(hit, kind));
      }));
      return perKind.flat()
        .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit ?? 10);
    },
    listRecent: async ({ scope, kind = WORK_KIND, limit }) => {
      const scoped = kind === WORK_KIND ? workScope(scope) : experienceScope(scope);
      if (!scoped) return [];
      const events = await deps.core.listEvents({ groupId: RECORD_GROUP_ID, kind, scope: scoped, limit });
      return events.map((event) => toRef(event, kind));
    },
    detail: async (id, scope): Promise<RecordDetail | undefined> => {
      const detail = await deps.core.detail(id);
      if (!detail) return undefined;
      if (!canReadSource(detail.source.kind, detail.source, scope)) return undefined;
      return {
        ...toRef(detail, detail.source.kind === EXPERIENCE_KIND ? EXPERIENCE_KIND : WORK_KIND),
        messageIds: detail.messageIds,
        entities: detail.entities.map((e) => ({ type: e.type, name: e.name, role: e.role })),
      };
    },
    deleteByThread: async ({ agentId, threadId }) => {
      await deps.core.deleteByThread({ groupId: RECORD_GROUP_ID, agentId, threadId, kind: RECORD_KIND });
    },
  };
}

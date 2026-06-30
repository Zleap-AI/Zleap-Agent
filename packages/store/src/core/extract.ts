/**
 * core 抽取管线（docs/store.md §3.3）。
 *
 * 会话片段 → 结构化 event(+entity)，带 message_ids 出处与 content_hash 幂等键。
 * LLM 抽取器可插拔；缺失、失败或返回空时不写事件。embed 批量向量化，缺失时优雅降级
 * （event 无向量仍可入库，靠词法/实体/图召回）。实体名按 source 归一去重。
 */
import { createHash } from 'node:crypto';
import { normalizeEntityName } from './types.js';
import type { CoreEntityInput, CoreEvent, CoreEventStatus, CoreScope, CoreStore, RecallHit } from './types.js';

export type ExtractionMessage = { role: string; content: string; id?: string };

export type ExtractionInput = {
  groupId: string;
  kind: string;
  scope: CoreScope;
  messages: ExtractionMessage[];
};

export type ExtractedEntity = {
  type: string;
  name: string;
  role?: string;
  description?: string;
  weight?: number;
  confidence?: number;
};

export type ExtractedEvent = {
  memory: string;
  metadata?: Record<string, unknown>;
  workKind?: 'process' | 'result';
  keywords?: string[];
  confidence?: number;
  entities?: ExtractedEntity[];
  messageIds?: string[];
};

/** Pluggable LLM extractor. Missing/failed/empty extraction means no records. */
export type CoreExtractor = (input: ExtractionInput) => Promise<ExtractedEvent[]>;

/** Batch embedder (same contract as the store's configured embedder). */
export type EmbedBatch = (texts: string[]) => Promise<number[][]>;

export type IngestDeps = {
  core: CoreStore;
  embed?: EmbedBatch;
  extractor?: CoreExtractor;
  relatedMinScore?: number;
  relatedCandidateLimit?: number;
  relatedGraphHops?: 0 | 1 | 2;
  reconciler?: CoreMemoryReconciler;
};

export type CoreMemoryReconcileInput = {
  groupId: string;
  kind: string;
  scope: CoreScope;
  draft: ExtractedEvent;
  related: RecallHit[];
};

export type CoreMemoryReconcileDecision =
  | { action: 'skip'; reason?: string }
  | { action: 'keep_both'; targetId?: string; reason?: string }
  | { action: 'replace_old'; targetId: string; reason?: string }
  | { action: 'keep_old'; targetId?: string; reason?: string };

export type CoreMemoryReconciler = (input: CoreMemoryReconcileInput) => Promise<CoreMemoryReconcileDecision>;

const DEFAULT_RELATED_CANDIDATE_LIMIT = 5;
const DEFAULT_RELATED_GRAPH_HOPS = 1;

/** Stable idempotency key for an event within its source. */
export function contentHash(parts: (string | undefined)[]): string {
  return createHash('sha256').update(parts.filter(Boolean).join('\u0000').trim().toLowerCase()).digest('hex');
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'were', 'they', 'them', 'their', 'about', 'would', 'could',
  'should', 'there', 'here', 'what', 'when', 'where', 'which', 'while', 'because', 'into', 'over',
  'then', 'than', 'your', 'yours', 'will', 'shall', 'been', 'being', 'does', 'done',
]);

/** Cheap keyword pull: words ≥4 chars, not stopwords, by frequency, capped. */
export function topKeywords(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Run extraction over a fragment and persist the events idempotently.
 * Source is ensured once; events dedupe on content_hash; entities normalize per source.
 */
export async function ingestFragment(input: ExtractionInput, deps: IngestDeps): Promise<CoreEvent[]> {
  const source = await deps.core.ensureSource({
    groupId: input.groupId,
    kind: input.kind,
    scope: input.scope,
    name: input.scope.threadId,
  });

  if (!deps.extractor) return [];
  let extracted: ExtractedEvent[] = [];
  try {
    extracted = await deps.extractor(input);
  } catch {
    extracted = [];
  }
  if (extracted.length === 0) return [];

  // Batch embed event contents; degrade gracefully when no embedder.
  let vectors: number[][] = [];
  if (deps.embed) {
    try {
      vectors = await deps.embed(extracted.map((e) => eventMemory(e)));
    } catch {
      vectors = [];
    }
  }

  const out: CoreEvent[] = [];
  for (let i = 0; i < extracted.length; i += 1) {
    const e = extracted[i];
    const memory = eventMemory(e);
    if (!memory) {
      continue;
    }
    const keywords = e.keywords ?? topKeywords(memory);
    const entities: CoreEntityInput[] = (e.entities ?? []).map((en) => ({
      type: en.type,
      name: en.name,
      normalizedName: normalizeEntityName(en.name),
      role: en.role,
      description: en.description,
      weight: en.weight,
      confidence: en.confidence,
    }));
    const hash = contentHash([memory]);
    const existing = await deps.core.findEventByHash(source.id, hash);
    if (existing) {
      out.push(existing);
      continue;
    }
    const related = await findRelatedCandidates(input, e, keywords, vectors[i], deps);
    const decision = await reconcileDraft(input, e, related, deps);
    if (decision.action === 'skip') {
      continue;
    }
    const target = chooseTarget(decision, related);
    const status: CoreEventStatus = decision.action === 'keep_old' ? 'archived' : 'active';
    const event = await deps.core.insertEvent({
      sourceId: source.id,
      memory,
      metadata: {
        ...(e.metadata ?? {}),
        memoryKind: input.kind,
        ...(e.workKind ? { workKind: e.workKind } : {}),
      },
      keywords,
      messageIds: e.messageIds,
      contentHash: hash,
      relationId: target ? (target.relationId ?? target.id) : undefined,
      supersedesId: decision.action === 'replace_old' ? target?.id : undefined,
      confidence: e.confidence,
      status,
      embedding: vectors[i],
      entities,
    });
    if (decision.action === 'replace_old' && target && event.id !== target.id) {
      await deps.core.setEventStatus(target.id, 'superseded', {
        supersededBy: event.id,
        supersededAt: event.createdAt,
      });
    }
    out.push(event);
  }
  return out;
}

async function findRelatedCandidates(
  input: ExtractionInput,
  event: ExtractedEvent,
  keywords: string[],
  embedding: number[] | undefined,
  deps: IngestDeps,
): Promise<RecallHit[]> {
  const hits = await deps.core.recall({
    groupId: input.groupId,
    kind: input.kind,
    scope: input.scope,
    queryText: eventMemory(event),
    embedding: embedding && embedding.length ? embedding : undefined,
    limit: deps.relatedCandidateLimit ?? DEFAULT_RELATED_CANDIDATE_LIMIT,
    mode: 'fast',
    graphHops: deps.relatedGraphHops ?? DEFAULT_RELATED_GRAPH_HOPS,
  }).catch(() => []);
  const minScore = deps.relatedMinScore ?? 0.92;
  const deduped = hits
    .filter((hit) => hasRelatedSignal(keywords, hit, minScore))
    .reduce((latest, hit) => {
      const relationKey = hit.relationId ?? hit.id;
      const existing = latest.get(relationKey);
      if (!existing || eventTime(hit) > eventTime(existing)) latest.set(relationKey, hit);
      return latest;
    }, new Map<string, RecallHit>());
  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || eventTime(b) - eventTime(a))
    .slice(0, deps.relatedCandidateLimit ?? DEFAULT_RELATED_CANDIDATE_LIMIT);
}

async function reconcileDraft(
  input: ExtractionInput,
  draft: ExtractedEvent,
  related: RecallHit[],
  deps: IngestDeps,
): Promise<CoreMemoryReconcileDecision> {
  if (!deps.reconciler || related.length === 0) return { action: 'keep_both' };
  try {
    return normalizeDecision(await deps.reconciler({ groupId: input.groupId, kind: input.kind, scope: input.scope, draft, related }), related);
  } catch {
    return { action: 'keep_both' };
  }
}

function normalizeDecision(decision: CoreMemoryReconcileDecision | undefined, related: RecallHit[]): CoreMemoryReconcileDecision {
  const relatedIds = new Set(related.map((hit) => hit.id));
  if (!decision) return { action: 'keep_both' };
  if (decision.action === 'skip') return decision;
  if (decision.action === 'keep_both') {
    return decision.targetId && !relatedIds.has(decision.targetId) ? { action: 'keep_both' } : decision;
  }
  if (decision.action === 'keep_old') {
    return decision.targetId && !relatedIds.has(decision.targetId) ? { action: 'keep_both' } : decision;
  }
  if (decision.action === 'replace_old') {
    return decision.targetId && relatedIds.has(decision.targetId) ? decision : { action: 'keep_both' };
  }
  return { action: 'keep_both' };
}

function chooseTarget(decision: CoreMemoryReconcileDecision, related: RecallHit[]): RecallHit | undefined {
  if ('targetId' in decision && decision.targetId) {
    return related.find((hit) => hit.id === decision.targetId);
  }
  return related[0];
}

function eventMemory(event: ExtractedEvent): string {
  return event.memory.trim();
}

function hasRelatedSignal(next: string[], hit: RecallHit, minScore: number): boolean {
  if (hit.paths.includes('entity') || hit.paths.includes('graph')) return true;
  return directPathScore(hit) >= minScore && hasHighKeywordOverlap(next, hit.keywords);
}

function directPathScore(hit: RecallHit): number {
  const directScores = [hit.vectorScore, hit.lexicalScore]
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  return directScores.length ? Math.max(...directScores) : hit.score;
}

function hasHighKeywordOverlap(next: string[], previous: string[]): boolean {
  if (next.length === 0 || previous.length === 0) return false;
  const prior = new Set(previous.map((word) => word.toLowerCase()));
  const shared = next.filter((word) => prior.has(word.toLowerCase())).length;
  return shared / Math.max(next.length, previous.length) >= 0.8;
}

function eventTime(event: Pick<CoreEvent, 'updatedAt' | 'createdAt'>): number {
  return (event.updatedAt ?? event.createdAt).getTime();
}

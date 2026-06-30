/**
 * B 线 · core 事件图端口（docs/store.md §3 / §5）。
 *
 * agent 层不依赖 store；它只认这个最小端口。接线层（cli/web）用 store.core +
 * ingestFragment + 注入的 extractor/reranker/embed 适配出实现。
 */
export type RecordMemoryKind = 'work' | 'experience';

export type RecordScope = {
  agentId: string;
  userId?: string;
  tenantId?: string;
  spaceId?: string;
  threadId?: string;
};

export type RecordFragmentMessage = { role: string; content: string; id?: string };

export type RecordRef = {
  id: string;
  kind?: RecordMemoryKind;
  memory: string;
  keywords: string[];
  messageIds?: string[];
  workKind?: 'process' | 'result';
  status?: 'active' | 'superseded' | 'archived';
  relationId?: string;
  supersedesId?: string;
  supersededBy?: string;
  supersededAt?: Date;
  confidence?: number;
  createdAt: Date;
  updatedAt?: Date;
};

export type RecordHit = RecordRef & {
  score: number;
  paths?: string[];
};

export type RecordEntity = { type: string; name: string; role?: string };

export type RecordDetail = RecordRef & {
  messageIds?: string[];
  entities: RecordEntity[];
};

export type RecordRecallMode = 'fast' | 'precise';

export type RecordRecallInput = {
  scope: RecordScope;
  query: string;
  kinds?: RecordMemoryKind[];
  limit?: number;
  /** 'fast' = no LLM (prefetch); 'precise' = LLM rerank (active recall). */
  mode?: RecordRecallMode;
};

export type WriteExperienceInput = {
  scope: RecordScope;
  memory: string;
  keywords?: string[];
  confidence?: number;
};

/**
 * The agent-facing record contract. Implemented by the wiring layer over
 * store.core; a no-op/in-memory double is used in tests.
 */
export interface RecordMemoryPort {
  /** Extract + persist a conversation fragment as work events (idempotent). */
  ingest(input: { scope: RecordScope; messages: RecordFragmentMessage[] }): Promise<RecordRef[]>;
  /** Persist a reusable, desensitized experience event. */
  writeExperience(input: WriteExperienceInput): Promise<RecordRef>;
  /** Relevance recall over visible work/experience events. */
  recall(input: RecordRecallInput): Promise<RecordHit[]>;
  /** Recency window — most-recent events for prefetch or management. */
  listRecent(input: { scope: RecordScope; kind?: RecordMemoryKind; limit?: number }): Promise<RecordRef[]>;
  /** Full event + entities by id, scoped by the current runtime. */
  detail(id: string, scope: RecordScope): Promise<RecordDetail | undefined>;
  /** Lifecycle — delete a conversation's work records. */
  deleteByThread(input: { agentId: string; threadId: string }): Promise<void>;
}

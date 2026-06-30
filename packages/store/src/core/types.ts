/**
 * core 通用结构化事件图引擎（docs/store.md §3）。
 *
 * 自成一体，不认识 memory/knowledge 业务语义；身份/隔离/范围都落在 `source`，
 * `event` 纯净只挂 source_id，实体按 source 共享。B 线 record 是第一个使用者，
 * 后续 knowledge 复用同一套表。
 */
export type CoreEventStatus = 'active' | 'superseded' | 'archived';
export type CoreSourceStatus = 'active' | 'archived';

/** Identity / isolation columns reused from the existing schema convention. */
export type CoreScope = {
  agentId: string;
  userId?: string;
  tenantId?: string;
  spaceId?: string;
  threadId?: string;
};

export type CoreSource = {
  id: string;
  groupId: string;
  kind: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  spaceId?: string;
  threadId?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  status: CoreSourceStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CoreEntityInput = {
  type: string;
  name: string;
  /** Computed from `name` when omitted. */
  normalizedName?: string;
  aliases?: string[];
  embedding?: number[];
  /** Edge attributes (event ↔ entity). */
  role?: string;
  description?: string;
  weight?: number;
  confidence?: number;
};

export type CoreEntity = {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  aliases?: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type CoreEntityRef = CoreEntity & {
  role?: string;
  description?: string;
  weight?: number;
  confidence?: number;
};

export type CoreEvent = {
  id: string;
  sourceId: string;
  memory: string;
  metadata?: Record<string, unknown>;
  keywords: string[];
  messageIds?: string[];
  contentHash?: string;
  relationId?: string;
  supersedesId?: string;
  supersededBy?: string;
  supersededAt?: Date;
  confidence?: number;
  status: CoreEventStatus;
  validUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CoreEventDetail = CoreEvent & {
  source: CoreSource;
  entities: CoreEntityRef[];
};

export type EnsureSourceInput = {
  groupId: string;
  kind: string;
  scope: CoreScope;
  name?: string;
  metadata?: Record<string, unknown>;
};

export type InsertEventInput = {
  sourceId: string;
  memory: string;
  metadata?: Record<string, unknown>;
  keywords?: string[];
  messageIds?: string[];
  contentHash?: string;
  relationId?: string;
  supersedesId?: string;
  confidence?: number;
  status?: CoreEventStatus;
  validUntil?: Date;
  embedding?: number[];
  entities?: CoreEntityInput[];
  id?: string;
};

export type ListEventsQuery = {
  groupId: string;
  scope: CoreScope;
  kind?: string;
  limit?: number;
};

/**
 * 召回模式（docs/store.md §3.4，用户约定）：
 * - fast    : 仅向量/词法/实体/图四路 + RRF 融合排序，无 LLM。prefetch 用，快速响应。
 * - precise : 在 fast 候选之上再走注入的 LLM reranker 精排。仅主动 recall 用。
 */
export type RecallMode = 'fast' | 'precise';

export type RecallHit = CoreEvent & {
  /** RRF fused score across vector/lexical/entity/graph paths. */
  score: number;
  vectorScore?: number;
  lexicalScore?: number;
  entityScore?: number;
  graphScore?: number;
  /** Which retrievers surfaced this event: vector|lexical|entity|graph. */
  paths: string[];
};

/** Pluggable LLM reranker — only invoked in precise mode. */
export type CoreReranker = (input: { queryText: string; hits: RecallHit[]; limit: number }) => Promise<RecallHit[]>;

export type RecallInput = {
  groupId: string;
  /** Isolation: source selection happens here before any event scan. */
  scope: CoreScope;
  kind?: string;
  queryText: string;
  /** Query vector for the vector path; omit to skip it (graceful degrade). */
  embedding?: number[];
  /** Final result count (default 10). */
  limit?: number;
  /** Per-path candidate fetch size (default 30). */
  candidateLimit?: number;
  /** default 'fast'. */
  mode?: RecallMode;
  /** Graph expansion hops over shared entities within the same sources (default 1). */
  graphHops?: 0 | 1 | 2;
  /** Required when mode==='precise'; ignored otherwise. */
  rerank?: CoreReranker;
};

export type DeleteByThreadInput = {
  groupId: string;
  agentId: string;
  threadId: string;
  kind?: string;
};

export type PurgeByAgentInput = {
  agentId: string;
  groupId?: string;
};

export type SetEventStatusInput = {
  supersededBy?: string;
  supersededAt?: Date;
};

/**
 * core 数据层契约（P1）。检索（P3）以 SearchInput/SearchResult 扩展，见 search 模块。
 */
export interface CoreStore {
  ensureSource(input: EnsureSourceInput): Promise<CoreSource>;
  getSource(id: string): Promise<CoreSource | undefined>;
  insertEvent(input: InsertEventInput): Promise<CoreEvent>;
  getEvent(id: string): Promise<CoreEvent | undefined>;
  findEventByHash(sourceId: string, contentHash: string): Promise<CoreEvent | undefined>;
  detail(id: string): Promise<CoreEventDetail | undefined>;
  listEvents(query: ListEventsQuery): Promise<CoreEvent[]>;
  /** Multi-path recall (docs/store.md §3.4). fast = no LLM; precise = +reranker. */
  recall(input: RecallInput): Promise<RecallHit[]>;
  setEventStatus(id: string, status: CoreEventStatus, input?: SetEventStatusInput): Promise<void>;
  /** Lifecycle — delete a conversation: drop its record source(s) (cascade). */
  deleteByThread(input: DeleteByThreadInput): Promise<void>;
  /** Lifecycle — delete an agent: drop all of its sources (cascade). */
  purgeByAgent(input: PurgeByAgentInput): Promise<void>;
}

/** Normalize an entity name for in-source dedup (lowercase, collapse whitespace). */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

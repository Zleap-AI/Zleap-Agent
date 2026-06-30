/**
 * A 线 · agent_memory 笔记（docs/store.md §2）。
 *
 * 对人记忆：主动写入的持久笔记。不向量化、不抽取实体、不进 core 管线。
 * 经验的主路径是 core 事件图；`experience` kind 仅为旧数据兼容保留。
 *
 * 隔离 + 计数范围键：
 *   impression 印象 — agentId 硬隔离；subject=user 绑定 userId，subject=agent 可为 userId 或全局 NULL
 *   experience 经验 — legacy only；新写入走 core kind=experience
 *
 * 模型/API 语义只暴露 memory 单字段；旧 title/content/importance/tenant_id
 * 不再是 agent_memory 合同的一部分。
 */
import { DEFAULT_MODEL_MEMORY_LIMIT } from './peoplePolicy.js';

export type AgentNoteKind = 'impression' | 'experience';
export type AgentNoteSubject = 'user' | 'agent';

export type AgentNoteStatus = 'active' | 'archived';

/** Identity / isolation columns reused from the existing schema convention. */
export type AgentNoteScope = {
  agentId: string;
  userId?: string;
  spaceId?: string;
  /** 出处：写入时所在对话。仅溯源，不参与范围键。 */
  threadId?: string;
};

export type AgentNote = {
  id: string;
  kind: AgentNoteKind;
  agentId: string;
  userId?: string;
  spaceId?: string;
  threadId?: string;
  subject?: AgentNoteSubject;
  memory: string;
  status: AgentNoteStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type WriteAgentNoteInput = {
  kind: AgentNoteKind;
  scope: AgentNoteScope;
  memory: string;
  subject?: AgentNoteSubject;
  /** Optional explicit id; generated when omitted. */
  id?: string;
};

export type ListAgentNotesQuery = {
  kind: AgentNoteKind;
  scope: AgentNoteScope;
  limit?: number;
};

/** Default per-scope retention; the (limit+1)-th write evicts the oldest. */
export const DEFAULT_AGENT_NOTE_LIMIT = DEFAULT_MODEL_MEMORY_LIMIT;

/**
 * The columns that form a note's retention/isolation scope key, by kind.
 * impression counts/filters by user. experience is legacy and agent-scoped here;
 * new experience memory lives in core.
 */
export function agentNoteScopeColumns(kind: AgentNoteKind): ('userId' | 'spaceId')[] {
  return kind === 'impression' ? ['userId'] : [];
}

/**
 * Durable note store (A 线). pgvector-free; one table, recent-N reads.
 */
export interface AgentNoteStore {
  /** Upsert a note by id when provided, then FIFO-archive anything beyond `limit` in its scope. */
  write(input: WriteAgentNoteInput, limit?: number): Promise<AgentNote>;
  /** Newest-first active notes for a scope (default DEFAULT_AGENT_NOTE_LIMIT). */
  listRecent(query: ListAgentNotesQuery): Promise<AgentNote[]>;
  getById(id: string): Promise<AgentNote | undefined>;
  /** Soft-delete (surface curation). */
  archive(id: string): Promise<void>;
  /** Lifecycle — delete agent: drop all of its notes. */
  purgeByAgent(agentId: string): Promise<void>;
  /** Lifecycle — delete space: legacy no-op for new memory; impressions untouched. */
  archiveBySpace(query: { agentId: string; spaceId: string }): Promise<void>;
  /** Lifecycle — delete user: drop its impressions (experiences have no user). */
  purgeByUser(query: { agentId: string; userId: string }): Promise<void>;
}

/**
 * MemoryOrchestrator（docs/store.md §5）。
 *
 * agent 级记忆编排，解耦于 CLI/Web。统一两条线：
 *   people notes：对人记忆，简单最新列表，无模型。
 *   core records：对事 work + 经验 experience，抽取/写入 + 召回。
 *
 * 上下文编排原则（用户约定）：prefetch 只做快速读取（people 最新列表 + core 摘要，fast），
 * 不走 LLM；只有主动 recall 才用 precise（LLM 精排）。
 */
import type { ActorRole } from '../actor.js';
import { DEFAULT_AGENT_NOTE_LIMIT, type AgentNote, type AgentNoteKind, type AgentNoteStore } from './notes.js';
import { DEFAULT_MODEL_MEMORY_LIMIT } from './peoplePolicy.js';
import type {
  RecordFragmentMessage,
  RecordHit,
  RecordMemoryPort,
  RecordRecallMode,
  RecordRef,
  RecordScope,
} from './record-port.js';
import { assessExperienceMemory, ExperienceMemoryRejectedError, sanitizeExperienceMemory } from './redaction.js';

export const DEFAULT_AGENT_SELF_LIMIT = 10;
export const DEFAULT_USER_IMPRESSION_LIMIT = DEFAULT_MODEL_MEMORY_LIMIT;
export const DEFAULT_WORK_MEMORY_LIMIT = 10;
export const DEFAULT_EXPERIENCE_MEMORY_LIMIT = 10;
export const DEFAULT_PEOPLE_RECONCILE_LIMIT = 100;

export type MemoryScopeContext = {
  agentId: string;
  userId?: string;
  actorRole?: ActorRole;
  tenantId?: string;
  spaceId?: string;
  threadId?: string;
};

export type RememberMemoryInput = {
  kind: AgentNoteKind;
  about: 'user' | 'agent';
  memory: string;
  /** about=agent only: user-level self memory by default; global requires creator/admin. */
  visibility?: 'user' | 'global';
};

export type MemoryRecallInput = {
  query: string;
  limit?: number;
  mode?: RecordRecallMode;
};

export type MemoryListResult = {
  impressions: AgentNote[];
  experiences: RecordRef[];
  records: RecordRef[];
};

/** Fast prefetch blocks for context assembly (no LLM). */
export type MemoryContextBlocks = {
  impressions: AgentNote[];
  experiences: RecordRef[];
  recentRecords: RecordRef[];
};

export type PeopleReconcileDecision =
  | { action: 'skip'; reason?: string }
  | {
      action: 'update_profile';
      targetId: string;
      about?: 'user' | 'agent';
      memory?: string;
      visibility?: 'user' | 'global';
      confidence?: number;
      reason?: string;
    }
  | { action: 'archive_profile'; targetId: string; reason?: string }
  | {
      action: 'keep_both';
      about?: 'user' | 'agent';
      memory: string;
      visibility?: 'user' | 'global';
      confidence?: number;
      reason?: string;
    };

export type RememberMemoryOptions = {
  /** Runtime-prefetched visible people/impression context for this turn. */
  peopleCandidates?: readonly AgentNote[];
};

export type MemoryOrchestratorDeps = {
  notes: AgentNoteStore;
  records: RecordMemoryPort;
  /** Per-scope note retention (A 线). Default DEFAULT_AGENT_NOTE_LIMIT. */
  noteLimit?: number;
  agentSelfLimit?: number;
  userImpressionLimit?: number;
  workMemoryLimit?: number;
  experienceMemoryLimit?: number;
};

function recordScope(scope: MemoryScopeContext): RecordScope {
  return {
    agentId: scope.agentId,
    userId: scope.userId,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    threadId: scope.threadId,
  };
}

export class MemoryOrchestrator {
  constructor(private readonly deps: MemoryOrchestratorDeps) {}

  private get noteLimit(): number {
    return this.deps.noteLimit ?? DEFAULT_AGENT_NOTE_LIMIT;
  }

  private get agentSelfLimit(): number {
    return this.deps.agentSelfLimit ?? DEFAULT_AGENT_SELF_LIMIT;
  }

  private get userImpressionLimit(): number {
    return this.deps.userImpressionLimit ?? DEFAULT_USER_IMPRESSION_LIMIT;
  }

  private get workMemoryLimit(): number {
    return this.deps.workMemoryLimit ?? DEFAULT_WORK_MEMORY_LIMIT;
  }

  private get experienceMemoryLimit(): number {
    return this.deps.experienceMemoryLimit ?? DEFAULT_EXPERIENCE_MEMORY_LIMIT;
  }

  /** Active write: impressions go to A-line people notes; experience goes to core. */
  async remember(
    input: RememberMemoryInput,
    scope: MemoryScopeContext,
    options: RememberMemoryOptions = {},
  ): Promise<AgentNote | RecordRef> {
    if (input.kind === 'experience') {
      const assessment = assessExperienceMemory({
        title: memoryTitle(input.memory),
        content: input.memory,
      });
      if (!assessment.accepted) {
        throw new ExperienceMemoryRejectedError(assessment.reason, assessment.code);
      }
      return this.deps.records.writeExperience({
        scope: recordScope({ agentId: scope.agentId, userId: scope.userId, threadId: scope.threadId }),
        memory: assessment.content,
      });
    }

    const subject = input.about;
    if (subject === 'user' && !scope.userId) {
      throw new Error('user impression requires userId');
    }
    const writeScope = this.peopleWriteScope(input, scope, subject);
    const candidates = options.peopleCandidates ?? [];
    const decision = this.fallbackRememberPeopleDecision(input, subject, candidates);
    const applied = await this.applyPeopleReconcileDecision(decision, writeScope, candidates);
    if (!applied) {
      throw new Error('failed to save impression memory');
    }
    return applied;
  }

  private peopleWriteScope(
    input: RememberMemoryInput,
    scope: MemoryScopeContext,
    subject: 'user' | 'agent',
  ): MemoryScopeContext {
    if (subject !== 'agent') {
      return scope;
    }
    if (input.visibility === 'global') {
      if (scope.actorRole !== 'creator' && scope.actorRole !== 'admin') {
        throw new Error('global agent self memory requires creator or admin role');
      }
      return { ...scope, userId: undefined, spaceId: undefined };
    }
    if (!scope.userId) {
      throw new Error('user-level agent self memory requires userId');
    }
    return scope;
  }

  /** B 线 — relevance recall over the conversation's records. */
  recall(input: MemoryRecallInput, scope: MemoryScopeContext): Promise<RecordHit[]> {
    return this.deps.records.recall({
      scope: recordScope(scope),
      query: input.query,
      limit: input.limit,
      mode: input.mode ?? 'precise',
    }).then((hits) => hits.map(sanitizeExperienceRecord));
  }

  /** Management list — A 线 notes + recent B 线 records. */
  async list(scope: MemoryScopeContext, limit?: number): Promise<MemoryListResult> {
    const [impressions, experiences, records] = await Promise.all([
      this.listPeopleNotes(scope, limit),
      this.deps.records.listRecent({ scope: recordScope({ agentId: scope.agentId }), kind: 'experience', limit: limit ?? this.experienceMemoryLimit }),
      this.deps.records.listRecent({ scope: recordScope(scope), kind: 'work', limit: limit ?? this.workMemoryLimit }),
    ]);
    return { impressions, experiences: experiences.map(sanitizeExperienceRecord), records };
  }

  /** Detail by id — record first (B), else note (A). */
  async detail(id: string, scope: MemoryScopeContext): Promise<RecordRef | AgentNote | undefined> {
    const record = await this.deps.records.detail(id, recordScope(scope));
    if (record) return sanitizeExperienceRecord(record);
    const note = await this.deps.notes.getById(id);
    if (!note || note.agentId !== scope.agentId) return undefined;
    if ((note.subject ?? 'user') === 'user' && note.userId !== scope.userId) return undefined;
    if (note.subject === 'agent' && note.userId && note.userId !== scope.userId) return undefined;
    return note;
  }

  /**
   * Fast prefetch for the context window (no LLM): impressions + experiences
   * (recent N) and the most-recent records. Keeps startup snappy.
   */
  async prepareContext(
    scope: MemoryScopeContext,
    opts?: { impressionLimit?: number; experienceLimit?: number; recordLimit?: number },
  ): Promise<MemoryContextBlocks> {
    const impressionLimit = opts?.impressionLimit;
    const experienceLimit = opts?.experienceLimit ?? this.experienceMemoryLimit;
    const recordLimit = opts?.recordLimit ?? this.workMemoryLimit;
    const [impressions, experiences, recentRecords] = await Promise.all([
      this.listPeopleNotes(scope, impressionLimit),
      this.deps.records.listRecent({ scope: recordScope({ agentId: scope.agentId }), kind: 'experience', limit: experienceLimit }),
      this.deps.records.listRecent({ scope: recordScope(scope), kind: 'work', limit: recordLimit }),
    ]);
    return { impressions, experiences: experiences.map(sanitizeExperienceRecord), recentRecords };
  }

  async listPeopleForReconcile(
    scope: MemoryScopeContext,
    limit = DEFAULT_PEOPLE_RECONCILE_LIMIT,
  ): Promise<AgentNote[]> {
    const perLaneLimit = Math.max(1, limit);
    const [userScopedRows, globalRows] = await Promise.all([
      scope.userId
        ? this.deps.notes.listRecent({ kind: 'impression', scope, limit: perLaneLimit })
        : Promise.resolve([] as AgentNote[]),
      this.deps.notes.listRecent({
        kind: 'impression',
        scope: { agentId: scope.agentId },
        limit: perLaneLimit,
      }),
    ]);
    const byId = new Map<string, AgentNote>();
    for (const note of [...userScopedRows, ...globalRows]) {
      const subject = note.subject ?? 'user';
      if (subject === 'user' && note.userId !== scope.userId) continue;
      if (subject === 'agent' && note.userId && note.userId !== scope.userId) continue;
      byId.set(note.id, note);
    }
    return [...byId.values()]
      .sort((a, b) => peopleNoteTime(b).getTime() - peopleNoteTime(a).getTime())
      .slice(0, limit);
  }

  async applyPeopleReconcileDecision(
    decision: PeopleReconcileDecision,
    scope: MemoryScopeContext,
    existingPeople?: readonly AgentNote[],
  ): Promise<AgentNote | undefined> {
    if (decision.action === 'skip') return undefined;
    const candidates = existingPeople ?? await this.listPeopleForReconcile(scope);
    const target = 'targetId' in decision && decision.targetId
      ? candidates.find((note) => note.id === decision.targetId)
      : undefined;

    if (decision.action === 'archive_profile') {
      if (!target) return undefined;
      await this.deps.notes.archive(target.id);
      return { ...target, status: 'archived', updatedAt: new Date() };
    }

    if (decision.action === 'update_profile') {
      if (!target) return undefined;
      const subject = target.subject ?? 'user';
      const memory = peopleMemoryText(decision.memory, target);
      const updated = await this.deps.notes.write({
        id: target.id,
        kind: 'impression',
        scope: {
          agentId: target.agentId,
          userId: target.userId,
          spaceId: target.spaceId,
          threadId: target.threadId ?? scope.threadId,
        },
        subject,
        memory,
      }, subject === 'agent' ? this.agentSelfLimit : this.userImpressionLimit);
      return this.deps.notes.getById(updated.id).then((note) => note ?? updated);
    }

    const subject = decision.about ?? 'user';
    if (subject === 'user' && !scope.userId) return undefined;
    const content = decision.memory.trim();
    if (!content) return undefined;
    const title = memoryTitle(content);
    const writeScope = this.peopleWriteScope(
      { kind: 'impression', about: subject, memory: content, visibility: decision.visibility },
      scope,
      subject,
    );
    return this.deps.notes.write({
      kind: 'impression',
      scope: writeScope,
      subject,
      memory: content,
    }, subject === 'agent' ? this.agentSelfLimit : this.userImpressionLimit);
  }

  /**
   * Pre-compaction hook (B 线): before the window folds, extract the folded
   * turns into durable records so nothing is lost.
   */
  async onPreCompaction(messages: RecordFragmentMessage[], scope: MemoryScopeContext): Promise<RecordRef[]> {
    if (messages.length === 0) return [];
    return this.deps.records.ingest({ scope: recordScope(scope), messages });
  }

  private async listPeopleNotes(scope: MemoryScopeContext, limit?: number): Promise<AgentNote[]> {
    const userRows = scope.userId
      ? await this.deps.notes.listRecent({ kind: 'impression', scope, limit: this.userImpressionLimit + this.agentSelfLimit })
      : [];
    const globalRows = await this.deps.notes.listRecent({
      kind: 'impression',
      scope: { agentId: scope.agentId },
      limit: this.agentSelfLimit,
    });
    const userImpressions = userRows
      .filter((note) => (note.subject ?? 'user') === 'user')
      .slice(0, limit ?? this.userImpressionLimit);
    const self = [...userRows.filter((note) => note.subject === 'agent'), ...globalRows.filter((note) => note.subject === 'agent')]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, this.agentSelfLimit);
    return [...self, ...userImpressions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private fallbackRememberPeopleDecision(
    input: RememberMemoryInput,
    subject: 'user' | 'agent',
    existingPeople: readonly AgentNote[],
  ): PeopleReconcileDecision {
    const content = input.memory.trim();
    const titleText = memoryTitle(content);
    const title = normalizeProfileKey(titleText);
    const target = existingPeople.find((note) =>
      (note.subject ?? 'user') === subject &&
      normalizeProfileKey(memoryTitle(note.memory)) === title);
    if (target) {
      return {
        action: 'update_profile',
        targetId: target.id,
        about: subject,
        memory: content,
        visibility: input.visibility,
        reason: 'same_title_profile_update',
      };
    }
    return {
      action: 'keep_both',
      about: subject,
      memory: content,
      visibility: input.visibility,
      reason: 'new_profile',
    };
  }

}

function peopleMemoryText(memory: string | undefined, fallback: AgentNote): string {
  const content = memory?.trim();
  if (!content) {
    return fallback.memory;
  }
  return content;
}

function memoryTitle(memory: string): string {
  const compact = memory.trim().replace(/\s+/g, ' ');
  const separator = compact.search(/[:：]/);
  if (separator > 0 && separator <= 80) {
    return compact.slice(0, separator).trim();
  }
  return compact.length <= 80 ? compact : `${compact.slice(0, 80).trimEnd()}...`;
}

function peopleNoteTime(note: AgentNote): Date {
  return note.updatedAt ?? note.createdAt;
}

function normalizeProfileKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sanitizeExperienceRecord<T extends RecordRef>(record: T): T {
  if (record.kind !== 'experience') {
    return record;
  }
  const sanitized = sanitizeExperienceMemory({
    title: memoryTitle(record.memory),
    content: record.memory,
  });
  if (!sanitized.redacted) {
    return record;
  }
  return {
    ...record,
    memory: sanitized.content,
  };
}

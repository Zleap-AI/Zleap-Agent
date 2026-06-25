/**
 * MemoryPlugin（docs/store.md §5）。把 MemoryOrchestrator 暴露成 agent 的挂载点：
 *   tools  : remember(→A/B) / recall(→B precise)
 *   render : 把 prefetch 块渲染成上下文文本（人/经验/最近记录）
 *
 * onPreCompaction（B 线抽取）由 engine 在回落前直接调用 orchestrator.onPreCompaction，
 * 不经过 tool，所以不在这里暴露。
 */
import type { ToolDefinition, ToolExecutionContext } from '../types.js';
import { projectMemoriesForModel, recordRefToMemoryRecordForModel } from './modelProjection.js';
import type { AgentNote } from './notes.js';
import type { MemoryContextBlocks, MemoryOrchestrator, MemoryScopeContext } from './orchestrator.js';
import type { RecordRef } from './record-port.js';
import { ExperienceMemoryRejectedError } from './redaction.js';

export const MEMORY_PLUGIN_TOOL_IDS = ['remember', 'recall'] as const;

const RECALL_CONTENT_CHARS = 2_400;

export type MemoryPluginDeps = {
  orchestrator: (
    toolContext: ToolExecutionContext,
  ) => MemoryOrchestrator | null | undefined | Promise<MemoryOrchestrator | null | undefined>;
  /** Runtime resolves the scope (agent/user/space/thread); the model never picks it. */
  scope: (toolContext: ToolExecutionContext) => MemoryScopeContext | null | undefined;
  /** Runtime-prefetched people/impression candidates already visible to the model this turn. */
  peopleCandidates?: (toolContext: ToolExecutionContext) => readonly AgentNote[] | undefined;
  /** Runtime role gate. Only creator/admin should see or use visibility. */
  exposeVisibility?: (toolContext: ToolExecutionContext) => boolean;
};

async function resolve(
  deps: MemoryPluginDeps,
  toolContext: ToolExecutionContext,
): Promise<{ orchestrator: MemoryOrchestrator; scope: MemoryScopeContext } | undefined> {
  const orchestrator = await deps.orchestrator(toolContext);
  const scope = deps.scope(toolContext);
  return orchestrator && scope ? { orchestrator, scope } : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function stringField(input: unknown, key: string): string | undefined {
  return input && typeof input === 'object' && typeof (input as Record<string, unknown>)[key] === 'string'
    ? ((input as Record<string, unknown>)[key] as string)
    : undefined;
}

function isExperienceMemoryRejected(error: unknown): boolean {
  return error instanceof ExperienceMemoryRejectedError ||
    Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'experience_memory_rejected');
}

function truncateDetail(content: string): { content: string; truncated: boolean } {
  if (content.length <= RECALL_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  return { content: `${content.slice(0, RECALL_CONTENT_CHARS).trimEnd()}...`, truncated: true };
}

export function createMemoryPluginTools(deps: MemoryPluginDeps): ToolDefinition[] {
  return [
    {
      id: 'remember',
      description:
        'Save one durable memory. kind=impression is only for the current user, this agent, or their relationship. about=user means the current user; about=agent means this assistant/agent. kind=experience is only for reusable, desensitized workflow lessons. Runtime forces experience about=user and binds the current userId as the audit origin while allowing agent-wide recall. Do not include names, projects, paths, accounts, secrets, private facts, one-off research results, or customer/company identifiers in experience memory.',
      promptSnippet:
        'Call remember when the user explicitly asks to remember a durable fact/preference or asks to summarize reusable experience. Use about=user or about=agent only; write the full memory in memory.',
      promptGuidelines: [
        'Call remember(impression) in the same turn before confirming when the user explicitly asks to remember, rename, or set a future preference.',
        'For impression, about=user means current user and about=agent means this assistant/agent; never store third-party people or researched subjects.',
        'Call remember(experience) only when the user asks to record a reusable lesson or when a clear reusable workflow lesson should be saved; skip one-off facts.',
        'Experience memory must be desensitized. Runtime records the current userId as origin for audit.',
        'Do not claim memory was saved unless remember returned saved.',
      ],
      parameters: rememberParameters(false),
      describe: (toolContext) => {
        const canUseVisibility = deps.exposeVisibility?.(toolContext) === true;
        return {
          parameters: rememberParameters(canUseVisibility),
          promptGuidelines: canUseVisibility
            ? [
              'Call remember(impression) in the same turn before confirming when the user explicitly asks to remember, rename, or set a future preference.',
              'For impression, about=user means current user and about=agent means this assistant/agent; never store third-party people or researched subjects.',
              'visibility is available only because the current actor is creator/admin. Use visibility=global only for durable agent-self facts that should apply to all users of this agent; otherwise omit it.',
              'Call remember(experience) only when the user asks to record a reusable lesson or when a clear reusable workflow lesson should be saved; skip one-off facts.',
              'Experience memory must be desensitized. Runtime records the current userId as origin for audit.',
              'Do not claim memory was saved unless remember returned saved.',
            ]
            : undefined,
        };
      },
      handler: async (input, toolContext) => {
        const resolved = await resolve(deps, toolContext);
        if (!resolved) return { saved: false, reason: 'memory not configured' };
        const record = asRecord(input);
        const kind = record.kind === 'impression' ? 'impression' : 'experience';
        const peopleCandidates = kind === 'impression' ? deps.peopleCandidates?.(toolContext) : undefined;
        const memoryText = typeof record.memory === 'string' ? record.memory.trim() : '';
        if (!memoryText) {
          return { saved: false, kind, status: 'rejected', reason: 'remember requires a non-empty memory.' };
        }
        const about = kind === 'experience'
          ? 'user'
          : record.about === 'agent' ? 'agent' : 'user';
        const canUseVisibility = deps.exposeVisibility?.(toolContext) === true;
        if (record.visibility === 'global' && !canUseVisibility) {
          return {
            saved: false,
            kind,
            status: 'rejected',
            reason: 'global visibility requires creator/admin.',
          };
        }
        const visibility = canUseVisibility && record.visibility === 'global' ? 'global' : 'user';
        let memory: AgentNote | RecordRef;
        try {
          memory = await resolved.orchestrator.remember(
            {
              kind,
              about,
              memory: memoryText,
              visibility,
            },
            resolved.scope,
            { peopleCandidates },
          );
        } catch (error) {
          if (isExperienceMemoryRejected(error)) {
            const rejectionCode = error instanceof ExperienceMemoryRejectedError
              ? error.rejectionCode
              : stringField(error, 'rejectionCode') ?? 'experience_not_reusable';
            return {
              saved: false,
              kind,
              status: 'rejected',
              reason: error instanceof Error ? error.message : 'experience memory rejected',
              code: rejectionCode,
              guidance: 'Only call remember(experience) for reusable, desensitized process lessons. Skip one-off task facts or research results.',
            };
          }
          throw error;
        }
        return { id: memory.id, kind: kind, status: 'saved' };
      },
    },
    {
      id: 'recall',
      description: 'Search visible work and experience memory. Work memory is limited to the current conversation/session scope; reusable experience memory is desensitized and agent-wide. Returns complete usable memory paragraphs plus evidence ids for original source recovery. Do not use recall for user profile, preferences, agent self-knowledge, or original chat details. Use the injected listMemory.impressions tool result for profile facts and readMessage for original transcript details.',
      promptSnippet: 'Call recall only when current-session work memory or reusable experience memory is needed. Use returned memory directly; use returned ids with readMessage only when original evidence is needed.',
      promptGuidelines: [
        'recall searches only work and experience memory; it does not search impressions/user profile.',
        'Work memory results are scoped to the current conversation/session. Do not expect recall to search other conversations.',
        'Experience memory can be reused across conversations only after runtime desensitization; it should not contain one-off project facts.',
        'Use listMemory.impressions for user profile, preferences, and agent self-knowledge; do not call recall for those facts.',
        'Use recall memory directly when it is enough.',
        'If original evidence is needed, choose a returned id and call readMessage({ id }).',
        'Use readMessage, not recall, when original chat details, long source material, or exact wording need verification.',
      ],
      executionMode: 'parallel',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: { type: 'number', description: 'Maximum number of hits. Defaults to 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (input, toolContext) => {
        const resolved = await resolve(deps, toolContext);
        if (!resolved) return { hits: [] };
        const record = asRecord(input);
        const hits = await resolved.orchestrator.recall(
          {
            query: typeof record.query === 'string' ? record.query : '',
            limit: typeof record.limit === 'number' ? record.limit : undefined,
            mode: 'precise',
          },
          resolved.scope,
        );
        return {
          memories: hits.map((hit) => ({
            ...recordProjection(hit),
            evidenceIds: hit.messageIds ?? [],
            score: hit.score,
            paths: hit.paths ?? [],
          })),
        };
      },
    },
  ];
}

function rememberParameters(includeVisibility: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['impression', 'experience'], description: 'impression=durable fact about the user or agent; experience=reusable desensitized workflow lesson.' },
      about: { type: 'string', enum: ['user', 'agent'], description: 'Required choice. user=current user; agent=this assistant/agent. For experience, runtime forces user.' },
      memory: { type: 'string', description: 'One complete, searchable, directly usable memory paragraph. Do not split title/summary/detail.' },
      ...(includeVisibility
        ? {
          visibility: {
            type: 'string',
            enum: ['user', 'global'],
            description: 'Optional creator/admin-only scope for agent impressions. Omit for current-user scope; use global only for agent-self facts shared by all users of this agent.',
          },
        }
        : {}),
    },
    required: ['kind', 'about', 'memory'],
    additionalProperties: false,
  };
}

function noteProjection(note: AgentNote): Record<string, unknown> {
  return {
    id: note.id,
    kind: note.kind,
    ...(note.kind === 'impression' ? { subject: note.subject ?? 'user' } : {}),
    memory: note.memory,
    createdAt: formatNoteTime(note.createdAt),
  };
}

function recordProjection(record: RecordRef): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    memory: record.memory,
    evidenceIds: record.messageIds ?? [],
    workKind: record.workKind,
    status: record.status,
    relationId: record.relationId,
    supersedesId: record.supersedesId,
    supersededBy: record.supersededBy,
    supersededAt: record.supersededAt instanceof Date ? record.supersededAt.toISOString() : undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt).toISOString(),
  };
}

/** 人 — durable impressions, into the stable systemPrompt. */
export function renderImpressionNotes(notes: AgentNote[]): string | undefined {
  if (notes.length === 0) return undefined;
  const userNotes = notes.filter((note) => (note.subject ?? 'user') === 'user');
  const agentNotes = notes.filter((note) => note.subject === 'agent');
  return [
    'Long-term impression memory. Interpret subject labels as ownership: subject=user is about the current user; subject=agent is about this assistant/agent. Resolve pronouns by speaker: in user messages, first-person pronouns refer to the user and second-person pronouns refer to this assistant; in assistant messages, first-person pronouns refer to this assistant. Answer from the matching subject or persona.',
    renderSubjectNotes('Known facts about the user (long-term memory)', userNotes),
    renderSubjectNotes('Known facts about this agent (long-term memory)', agentNotes),
  ].filter(Boolean).join('\n\n') || undefined;
}

/** 经验 — reusable lessons, rendered as detail-capable projections. */
export function renderExperienceNotes(records: RecordRef[]): string | undefined {
  if (records.length === 0) return undefined;
  const lines = projectMemoriesForModel(records.map((record) => recordRefToMemoryRecordForModel(record, 'experience')));
  return `Relevant experience memory:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/** 最近记录 — recency timeline of records (semiStable). */
export function renderRecentRecords(records: RecordRef[]): string | undefined {
  if (records.length === 0) return undefined;
  const lines = projectMemoriesForModel(records.map((record) => recordRefToMemoryRecordForModel(record, 'work')));
  return `Prior conversation highlights (records):\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/** Convenience: render all prefetch blocks at once. */
export function renderMemoryBlocks(blocks: MemoryContextBlocks): {
  stableText?: string;
  recentRecordsText?: string;
} {
  const stableText = [renderImpressionNotes(blocks.impressions)]
    .filter(Boolean)
    .join('\n\n');
  return {
    stableText: stableText || undefined,
    recentRecordsText: renderRecentRecords(blocks.recentRecords),
  };
}

function formatNoteTime(createdAt: Date): string {
  const time = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isNaN(time.getTime()) ? 'unknown-time' : time.toISOString();
}

function renderSubjectNotes(title: string, notes: AgentNote[]): string | undefined {
  if (notes.length === 0) return undefined;
  return `${title}:\n${notes.map((n) => `- [subject: ${n.subject ?? 'user'}; time: ${formatNoteTime(n.createdAt)}] ${n.memory}`).join('\n')}`;
}

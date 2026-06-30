import type { SessionEntryRecord } from '@zleap/core';

export type PublicChatTraceSourceRef = {
  table: string;
  ids: string[];
};

export type PublicChatTraceEntry = {
  id: string;
  sessionId: string;
  parentEntryId?: string;
  type: SessionEntryRecord['type'];
  role?: SessionEntryRecord['role'];
  runId?: string;
  workId?: string;
  workStepId?: string;
  toolCallId?: string;
  artifactId?: string;
  tokenCount?: number;
  hasContent: boolean;
  contentLength?: number;
  data?: PublicChatTraceEntryData;
  createdAt: string;
};

export type PublicChatTraceEntryData = {
  projectionKind?: string;
  source?: string;
  sourceRefs?: PublicChatTraceSourceRef[];
  conversationId?: string;
  phase?: string;
  toolName?: string;
  toolId?: string;
  isError?: boolean;
  artifactId?: string;
  artifactTitle?: string;
  workspaceId?: string;
  runtimeWorkspaceId?: string;
  sourceSessionId?: string;
  workspaceResultStatus?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
};

export function toPublicChatTraceEntry(entry: SessionEntryRecord): PublicChatTraceEntry {
  return dropUndefined({
    id: entry.id,
    sessionId: entry.sessionId,
    parentEntryId: entry.parentEntryId,
    type: entry.type,
    role: entry.role,
    runId: entry.runId,
    workId: entry.workId,
    workStepId: entry.workStepId,
    toolCallId: entry.toolCallId,
    artifactId: entry.artifactId,
    tokenCount: entry.tokenCount,
    hasContent: Boolean(entry.content),
    contentLength: entry.content?.length,
    data: toPublicChatTraceEntryData(entry.data),
    createdAt: entry.createdAt.toISOString(),
  }) as PublicChatTraceEntry;
}

export function toPublicChatTraceEntryData(data: unknown): PublicChatTraceEntryData | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const publicData = dropUndefined({
    projectionKind: stringField(record.projectionKind),
    source: stringField(record.source),
    sourceRefs: sourceRefsField(record.sourceRefs),
    conversationId: stringField(record.conversationId),
    phase: stringField(record.phase),
    toolName: stringField(record.toolName),
    toolId: stringField(record.toolId),
    isError: booleanField(record.isError),
    artifactId: stringField(record.artifactId),
    artifactTitle: stringField(record.artifactTitle),
    workspaceId: stringField(record.workspaceId),
    runtimeWorkspaceId: stringField(record.runtimeWorkspaceId),
    sourceSessionId: stringField(record.sourceSessionId),
    workspaceResultStatus: stringField(record.workspaceResultStatus),
    status: stringField(record.status),
    startedAt: stringField(record.startedAt),
    endedAt: stringField(record.endedAt),
  }) as PublicChatTraceEntryData;
  return Object.keys(publicData).length > 0 ? publicData : undefined;
}

function sourceRefsField(value: unknown): PublicChatTraceSourceRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const table = stringField((item as Record<string, unknown>).table);
    const ids = (item as Record<string, unknown>).ids;
    if (!table || !Array.isArray(ids)) {
      return [];
    }
    const safeIds = ids.filter((id): id is string => typeof id === 'string');
    return safeIds.length ? [{ table, ids: safeIds }] : [];
  });
  return refs.length ? refs : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function dropUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

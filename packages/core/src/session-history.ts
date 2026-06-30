import type { SessionEntryRecord } from './records.js';
import type { BuiltConversationMessage, SessionEntryVisibility } from './store-ports.js';

export function filterSessionEntriesByVisibility(
  entries: readonly SessionEntryRecord[],
  visibility: SessionEntryVisibility = 'active',
): SessionEntryRecord[] {
  if (visibility === 'audit') {
    return [...entries];
  }
  return entries.filter((entry) => !entry.deletedAt);
}

export function buildConversationFromEntries(
  entries: readonly SessionEntryRecord[],
  visibility: SessionEntryVisibility = 'active',
): BuiltConversationMessage[] {
  return filterSessionEntriesByVisibility(entries, visibility).flatMap(entryToConversationMessage);
}

export function buildSessionContextFromEntries(
  entries: readonly SessionEntryRecord[],
  visibility: SessionEntryVisibility = 'active',
): BuiltConversationMessage[] {
  const visibleEntries = filterSessionEntriesByVisibility(entries, visibility);
  const compactionIndex = findLastIndex(visibleEntries, (entry) => entry.type === 'compaction' && Boolean(entry.content?.trim()));
  if (compactionIndex < 0) {
    return visibleEntries.flatMap(entryToUncompactedSessionContextMessage);
  }

  const compaction = visibleEntries[compactionIndex]!;
  const firstKeptEntryId = readStringField(compaction.data, 'firstKeptEntryId');
  const firstKeptIndex = firstKeptEntryId ? visibleEntries.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
  const proposedKeptStart = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
  const keptStart = safeSessionContextKeptStart(visibleEntries, proposedKeptStart);
  return visibleEntries
    .slice(keptStart)
    .filter((_, index) => keptStart + index !== compactionIndex)
    .flatMap(entryToSessionContextMessage);
}

export function expandRelatedDeletionEntryIds(
  entries: readonly SessionEntryRecord[],
  entryIds: readonly string[],
): string[] {
  const activeEntries = filterSessionEntriesByVisibility(entries, 'active');
  const ids = new Set(entryIds);
  for (const entryId of entryIds) {
    const index = activeEntries.findIndex((entry) => entry.id === entryId);
    const entry = index >= 0 ? activeEntries[index] : undefined;
    if (!entry || !(entry.type === 'message' && entry.role === 'assistant')) continue;
    const start = previousUserBoundary(activeEntries, index) + 1;
    const end = nextUserBoundary(activeEntries, index);
    const assistantText = normalizeText(entry.content);
    for (let i = start; i < end; i += 1) {
      const candidate = activeEntries[i];
      if (
        candidate?.type === 'message' &&
        candidate.role === 'assistant' &&
        normalizeText(candidate.content) === assistantText
      ) {
        ids.add(candidate.id);
      }
      if (candidate?.type === 'tool_result' && isAssistantHandoff(candidate.data)) {
        ids.add(candidate.id);
      }
    }
  }
  return [...ids];
}

function entryToConversationMessage(entry: SessionEntryRecord): BuiltConversationMessage[] {
  if (entry.type !== 'message' || !entry.role || !entry.content) {
    return [];
  }
  return [{
    role: entry.role as BuiltConversationMessage['role'],
    content: entry.content,
    data: entry.data,
  }];
}

function entryToSessionContextMessage(entry: SessionEntryRecord): BuiltConversationMessage[] {
  if ((entry.type === 'message' || entry.type === 'tool_call' || entry.type === 'tool_result') && entry.role && entry.content) {
    return [{
      role: entry.role as BuiltConversationMessage['role'],
      content: entry.content,
      data: entry.data,
    }];
  }
  return [];
}

function entryToUncompactedSessionContextMessage(entry: SessionEntryRecord): BuiltConversationMessage[] {
  if (entry.type === 'message') {
    return entryToConversationMessage(entry);
  }
  if ((entry.type === 'tool_call' || entry.type === 'tool_result') && isSafeUncompactedSessionProjection(entry.data) && entry.role && entry.content) {
    return [{
      role: entry.role as BuiltConversationMessage['role'],
      content: entry.content,
      data: entry.data,
    }];
  }
  return [];
}

function isSafeUncompactedSessionProjection(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const projectionKind = (data as { projectionKind?: unknown }).projectionKind;
  return projectionKind === 'artifact_handoff' || projectionKind === 'approval_request';
}

function safeSessionContextKeptStart(entries: readonly SessionEntryRecord[], proposedStart: number): number {
  let keptStart = Math.max(0, Math.min(proposedStart, entries.length));
  while (keptStart > 0) {
    const unsafeToolCallIndex = findToolCallSplitBeforeEntry(entries, keptStart);
    if (unsafeToolCallIndex < 0 || unsafeToolCallIndex >= keptStart) {
      return keptStart;
    }
    keptStart = unsafeToolCallIndex;
  }
  return keptStart;
}

function findToolCallSplitBeforeEntry(entries: readonly SessionEntryRecord[], keptStart: number): number {
  for (let index = keptStart - 1; index >= 0; index -= 1) {
    const toolCallId = entries[index]?.type === 'tool_call' ? entries[index]?.toolCallId : undefined;
    if (!toolCallId) {
      continue;
    }
    if (hasMatchingToolResultAtOrAfterEntry(entries, keptStart, toolCallId)) {
      return index;
    }
  }
  return -1;
}

function hasMatchingToolResultAtOrAfterEntry(
  entries: readonly SessionEntryRecord[],
  start: number,
  toolCallId: string,
): boolean {
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type === 'tool_result' && entry.toolCallId === toolCallId) {
      return true;
    }
  }
  return false;
}

function previousUserBoundary(entries: readonly SessionEntryRecord[], index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === 'message' && entries[i]?.role === 'user') return i;
  }
  return -1;
}

function nextUserBoundary(entries: readonly SessionEntryRecord[], index: number): number {
  for (let i = index + 1; i < entries.length; i += 1) {
    if (entries[i]?.type === 'message' && entries[i]?.role === 'user') return i;
  }
  return entries.length;
}

function isAssistantHandoff(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const projectionKind = (data as { projectionKind?: unknown }).projectionKind;
  return projectionKind === 'artifact_handoff' || projectionKind === 'workspace_result';
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function readStringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) {
      return index;
    }
  }
  return -1;
}

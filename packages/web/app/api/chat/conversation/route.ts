import { DEFAULT_AVATAR_ID, DEFAULT_FILE_WORKSPACE_ROOT, type SessionEntryRecord, type SpaceSessionRecord, type ThreadRecord } from '@zleap/core';
import { expandRelatedDeletionEntryIds, filterSessionEntriesByVisibility } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import {
  type ConversationSummaryRecord,
  conversationSource,
  conversationThreadCandidates,
  ensureConversationWorkspace,
  listConversationSummaries,
  metadataString,
  sanitizeConversationId,
  setConversationWorkspaceStatus,
} from '../../../../lib/server/conversationWorkspace';
import { normalizeAssistantDisplayText } from '../../../../lib/messageText';
import { dataUrlToBase64Payload, isSupportedImageMimeType, type ChatImageAttachment } from '../../../../lib/chatAttachments';
import type { ArtifactView, DisplayMessage, ToolCallView, WorkspaceTransitionView, WorkPane } from '../../../../lib/types';
import { artifactFromToolResult, dedupeArtifactViews, refToLocalPath, resolveArtifactPath } from '../../../../lib/workspaceArtifacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const url = new URL(req.url);
  const avatarId = nonEmpty(url.searchParams.get('avatarId')) ?? DEFAULT_AVATAR_ID;
  const conversationId = nonEmpty(url.searchParams.get('conversationId'));
  const source = conversationSource(url.searchParams.get('source'));
  const before = nonEmpty(url.searchParams.get('before'));
  const pageSize = numberParam(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  try {
    const owner = { userId: actor.userId, tenantId: actor.tenantId };
    if (!conversationId) {
      const limit = numberParam(url.searchParams.get('limit'), 100, 200);
      const [active, archived] = await Promise.all([
        listConversationSummaries(store, actor, { status: 'active', limit }),
        listConversationSummaries(store, actor, { status: 'archived', limit }),
      ]);
      const [startedActive, startedArchived] = await Promise.all([
        filterStartedSummaries(store, active, owner),
        filterStartedSummaries(store, archived, owner),
      ]);
      return Response.json({
        conversations: startedActive.map(conversationSummaryToJson),
        archived: startedArchived.map(conversationSummaryToJson),
      });
    }

    const sanitizedConversationId = sanitizeConversationId(conversationId);
    for (const threadId of conversationThreadCandidates(sanitizedConversationId, source)) {
      const thread = await store.threads.getThread(threadId, owner);
      if (!thread || thread.avatarId !== avatarId) continue;
      const sessionId = thread.mainSessionId ?? `${thread.id}:main`;
      const rawLimit = Math.min(pageSize * 5, 1000);
      const entries = await store.sessions.listEntries({ sessionId, ...owner, limit: rawLimit, beforeEntryId: before });
      const activeEntries = filterSessionEntriesByVisibility(entries);
      const session = await store.sessions.getSession(sessionId, owner);
      const workspaceRoot = metadataString(thread.metadata, 'workspaceRoot') ?? metadataString(session?.metadata, 'workspaceRoot');
      const projectId = metadataString(thread.metadata, 'projectId') ?? metadataString(session?.metadata, 'projectId');
      const messages = toDisplayMessages(activeEntries, workspaceRoot).slice(-pageSize);
      const workspaces = before ? [] : await toWorkspacePanes(store, thread.id, sessionId, owner, workspaceRoot);
      const nextCursor = messages[0]?.entryId;
      return Response.json({
        conversationId,
        threadId: thread.id,
        sessionId,
        source: conversationSource(thread.source) ?? 'web',
        workspaceRoot,
        workspaceKind: projectId ? 'project' : workspaceRoot ? 'artifact' : undefined,
        projectId,
        messages,
        hasMore: entries.length >= rawLimit && Boolean(nextCursor),
        nextCursor,
        workspaces,
      });
    }
    return Response.json({ error: 'thread_not_found' }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  } finally {
    await store.close().catch(() => {});
  }
}

async function filterStartedSummaries(
  store: ZleapStore,
  summaries: ConversationSummaryRecord[],
  owner: { userId?: string; tenantId?: string },
): Promise<ConversationSummaryRecord[]> {
  const kept: ConversationSummaryRecord[] = [];
  for (const summary of summaries) {
    if (await summaryHasConversationContent(store, summary, owner)) {
      kept.push(summary);
    }
  }
  return kept;
}

async function summaryHasConversationContent(
  store: ZleapStore,
  summary: ConversationSummaryRecord,
  owner: { userId?: string; tenantId?: string },
): Promise<boolean> {
  const mainSessionId = summary.mainSessionId ?? `${summary.threadId}:main`;
  const entries = await store.sessions.listEntries({ sessionId: mainSessionId, ...owner, limit: 1 });
  if (entries.length > 0) return true;
  const childSessions = await store.sessions.listSessions({ threadId: summary.threadId, parentSessionId: mainSessionId, ...owner, limit: 1 });
  return childSessions.length > 0;
}

export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: unknown;
      source?: unknown;
      status?: unknown;
    };
    if (typeof body.conversationId !== 'string' || !body.conversationId.trim()) {
      return Response.json({ error: 'conversation_id_required' }, { status: 400 });
    }
    if (body.status !== 'active' && body.status !== 'archived') {
      return Response.json({ error: 'conversation_status_invalid' }, { status: 400 });
    }
    const record = await setConversationWorkspaceStatus(store, actor, {
      conversationId: body.conversationId,
      source: typeof body.source === 'string' ? conversationSource(body.source) : undefined,
      status: body.status,
    });
    return Response.json({ conversation: conversationSummaryToJson(record) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const conversationId = stringField(body.conversationId);
  const source = conversationSource(stringField(body.source));
  const avatarId = stringField(body.avatarId) ?? DEFAULT_AVATAR_ID;
  const entryIds = stringArray(body.entryIds ?? body.entryId);
  if (!conversationId) {
    return Response.json({ error: 'conversation_id_required' }, { status: 400 });
  }

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  try {
    const owner = { userId: actor.userId, tenantId: actor.tenantId };
    const sanitizedConversationId = sanitizeConversationId(conversationId);
    for (const threadId of conversationThreadCandidates(sanitizedConversationId, source)) {
      const thread = await store.threads.getThread(threadId, owner);
      if (!thread || thread.avatarId !== avatarId) continue;
      if (entryIds.length === 0) {
        await deleteConversationWorkspaceDirectory(store, thread, owner);
        await deleteThreadMemory(store, avatarId, sanitizedConversationId, thread.id);
        const deleted = await store.threads.deleteThread(thread.id, owner);
        return Response.json({ deleted, threadId: thread.id });
      }
      const sessionId = thread.mainSessionId ?? `${thread.id}:main`;
      const entries = await store.sessions.listEntries({ sessionId, ...owner, limit: 1000 });
      const ids = expandRelatedDeletionEntryIds(entries, entryIds);
      const deletedEntryIds: string[] = [];
      for (const entryId of ids) {
        if (await store.sessions.deleteEntry({ sessionId, entryId, ...owner })) {
          deletedEntryIds.push(entryId);
        }
      }
      return Response.json({ deleted: deletedEntryIds.length > 0, deletedEntryIds });
    }
    return Response.json({ error: 'thread_not_found' }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  } finally {
    await store.close().catch(() => {});
  }
}

async function deleteConversationWorkspaceDirectory(
  store: ZleapStore,
  thread: ThreadRecord,
  owner: { userId?: string; tenantId?: string },
): Promise<void> {
  const session = thread.mainSessionId ? await store.sessions.getSession(thread.mainSessionId, owner) : undefined;
  const projectId = metadataString(thread.metadata, 'projectId') ?? metadataString(session?.metadata, 'projectId');
  const workspaceKind = metadataString(thread.metadata, 'workspaceKind') ?? metadataString(session?.metadata, 'workspaceKind');
  if (projectId || workspaceKind === 'project') {
    return;
  }
  const workspaceRoot = metadataString(thread.metadata, 'workspaceRoot') ?? metadataString(session?.metadata, 'workspaceRoot');
  const removable = removableConversationWorkspaceRoot(workspaceRoot);
  if (!removable) {
    return;
  }
  await rm(removable, { recursive: true, force: true });
}

function removableConversationWorkspaceRoot(workspaceRoot: string | undefined): string | undefined {
  if (!workspaceRoot) return undefined;
  const root = resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT);
  const target = resolve(workspaceRoot);
  if (target === root || !pathInside(target, root)) {
    return undefined;
  }
  return target;
}

function pathInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + sep);
}

async function deleteThreadMemory(
  store: ZleapStore,
  agentId: string,
  conversationId: string,
  threadId: string,
): Promise<void> {
  const threadIds = new Set([conversationId, threadId]);
  await Promise.all([...threadIds].map((id) => store.core.deleteByThread({ groupId: 'memory', agentId, threadId: id })));
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: unknown;
      source?: unknown;
      avatarId?: unknown;
      projectId?: unknown;
      title?: unknown;
    };
    if (typeof body.conversationId !== 'string' || !body.conversationId.trim()) {
      return Response.json({ error: 'conversation_id_required' }, { status: 400 });
    }
    const record = await ensureConversationWorkspace(store, actor, {
      conversationId: body.conversationId,
      source: typeof body.source === 'string' ? conversationSource(body.source) : undefined,
      avatarId: typeof body.avatarId === 'string' ? body.avatarId : undefined,
      projectId: typeof body.projectId === 'string' || body.projectId === null ? body.projectId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return Response.json({
      conversationId: record.conversationId,
      threadId: record.threadId,
      sessionId: record.sessionId,
      source: record.source,
      avatarId: record.avatarId,
      title: record.title,
      workspaceRoot: record.workspaceRoot,
      workspaceKind: record.workspaceKind,
      projectId: record.projectId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  } finally {
    await store.close().catch(() => {});
  }
}

function conversationSummaryToJson(record: {
  conversationId: string;
  threadId: string;
  source: string;
  avatarId: string;
  title: string;
  status: string;
  updatedAt: Date;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
  projectId?: string;
}): Record<string, unknown> {
  return {
    conversationId: record.conversationId,
    threadId: record.threadId,
    source: record.source,
    avatarId: record.avatarId,
    title: record.title,
    status: record.status,
    updatedAt: record.updatedAt.toISOString(),
    workspaceRoot: record.workspaceRoot,
    workspaceKind: record.workspaceKind,
    projectId: record.projectId,
  };
}

async function toWorkspacePanes(
  store: Awaited<ReturnType<typeof storeFromEnv>>,
  threadId: string,
  mainSessionId: string,
  owner: { userId?: string; tenantId?: string },
  workspaceRoot?: string,
): Promise<WorkPane[]> {
  if (!store) return [];
  const sessions = await store.sessions.listSessions({
    threadId,
    parentSessionId: mainSessionId,
    kind: 'work',
    ...owner,
    limit: 50,
  });
  const panes: WorkPane[] = [];
  for (const session of sessions) {
    panes.push(await workspacePaneFromSession(store, session, owner, workspaceRoot));
  }
  return mergeWorkspacePanes(withIncomingWorkspaceTransitions(panes));
}

function mergeWorkspacePanes(panes: WorkPane[]): WorkPane[] {
  const grouped = new Map<string, WorkPane[]>();
  for (const pane of panes) {
    const key = pane.spaceId || pane.id;
    grouped.set(key, [...(grouped.get(key) ?? []), pane]);
  }
  return [...grouped.values()]
    .map(mergeSameSpacePanes)
    .sort((a, b) => paneSortTime(b) - paneSortTime(a));
}

function mergeSameSpacePanes(panes: WorkPane[]): WorkPane {
  if (panes.length === 1) return normalizePaneArtifacts(panes[0]!);
  const chronological = [...panes].sort((a, b) => a.startedAt - b.startedAt);
  const latest = [...panes].sort((a, b) => paneSortTime(b) - paneSortTime(a))[0]!;
  const tools: ToolCallView[] = [];
  const messages: WorkPane['messages'] = [];
  const artifacts: ArtifactView[] = [];
  let toolOffset = 0;
  const transitions: WorkspaceTransitionView[] = [];

  for (const pane of chronological) {
    messages.push(...(pane.messages ?? []).map((message) => ({ ...message, after: message.after + toolOffset })));
    tools.push(...pane.tools);
    artifacts.push(...pane.artifacts);
    transitions.push(...(pane.transitions ?? []));
    toolOffset += pane.tools.length;
  }

  const mergedArtifacts = reindexArtifacts(dedupeArtifacts(artifacts));
  return {
    ...latest,
    id: latest.spaceId,
    startedAt: Math.min(...panes.map((pane) => pane.startedAt)),
    endedAt: latest.status === 'running' ? undefined : Math.max(...panes.map((pane) => pane.endedAt ?? pane.startedAt)),
    tools,
    messages,
    artifacts: mergedArtifacts,
    transitions: dedupeWorkspaceTransitions(transitions),
    currentRunArtifactStart: mergedArtifacts.length,
  };
}

function paneSortTime(pane: WorkPane): number {
  return pane.endedAt ?? pane.startedAt;
}

function normalizePaneArtifacts(pane: WorkPane): WorkPane {
  const artifacts = reindexArtifacts(dedupeArtifacts(pane.artifacts));
  return {
    ...pane,
    artifacts,
    currentRunArtifactStart: Math.min(pane.currentRunArtifactStart ?? artifacts.length, artifacts.length),
  };
}

async function workspacePaneFromSession(
  store: NonNullable<Awaited<ReturnType<typeof storeFromEnv>>>,
  session: SpaceSessionRecord,
  owner: { userId?: string; tenantId?: string },
  workspaceRoot?: string,
): Promise<WorkPane> {
  let artifactId = 1;
  const entries = filterSessionEntriesByVisibility(await store.sessions.listEntries({ sessionId: session.id, ...owner, limit: 500 }));
  const tools: ToolCallView[] = [];
  const messages: WorkPane['messages'] = [];
  const artifacts: ArtifactView[] = [];
  const transitions: WorkspaceTransitionView[] = [];
  const previewStarts: ToolCallView[] = [];
  for (const entry of entries) {
    const data = objectField(entry.data);
    const projectionKind = stringField(data?.projectionKind);
    if (entry.type === 'message' && entry.role === 'user' && projectionKind === 'workspace_user_message' && entry.content?.trim()) {
      messages.push({ text: `任务：${entry.content.trim()}`, after: tools.length });
      continue;
    }
    if (entry.type === 'message' && entry.role === 'assistant' && projectionKind === 'workspace_assistant_message' && entry.content?.trim()) {
      messages.push({ text: entry.content.trim(), after: tools.length });
      continue;
    }
    if ((entry.type === 'tool_call' || entry.type === 'tool_result') && projectionKind === 'tool_execution_record') {
      const transition = workspaceTransitionFromToolEntry(entry, data, session.spaceId);
      if (transition) {
        transitions.push(transition);
      }
      const tool = toolFromEntry(entry, data);
      tools.push(tool);
      artifacts.push(...artifactsFromEntry(entry, tool.result, () => artifactId++, session.spaceId, workspaceRoot));
      continue;
    }
    if ((entry.type === 'tool_call' || entry.type === 'tool_result') && projectionKind === 'workspace_tool_preview') {
      const transition = workspaceTransitionFromPreviewEntry(entry, data, session.spaceId);
      if (transition) {
        transitions.push(transition);
        continue;
      }
      const preview = previewToolFromEntry(entry, data, previewStarts);
      if (preview?.status === 'error') {
        tools.push(preview);
        artifacts.push(...artifactsFromEntry(entry, preview.result, () => artifactId++, session.spaceId, workspaceRoot));
      }
    }
  }
  const status = session.status === 'failed' ? 'error' : session.status === 'active' || session.status === 'suspended' ? 'running' : 'done';
  const metadata = objectField(session.metadata);
  const summary = stringField(metadata?.workspaceResultSummary);
  const normalizedArtifacts = dedupeArtifacts(artifacts);
  return {
    id: session.spaceId,
    sessionId: session.id,
    spaceId: session.spaceId,
    label: session.spaceId,
    ...(session.task ? { goal: session.task } : {}),
    ...(session.rootGoal ? { context: { source: 'durable session', detail: session.rootGoal } } : {}),
    startedAt: session.createdAt.getTime(),
    endedAt: status === 'running' ? undefined : session.updatedAt.getTime(),
    tools,
    messages,
    artifacts: normalizedArtifacts,
    transitions: dedupeWorkspaceTransitions(transitions),
    currentRunArtifactStart: normalizedArtifacts.length,
    ...(summary ? { envelope: { status: status === 'error' ? 'failed' : 'success', summary } } : {}),
    statusLine: summary ?? (status === 'running' ? 'workspace 历史运行中' : 'workspace 历史已恢复'),
    status,
  };
}

function withIncomingWorkspaceTransitions(panes: WorkPane[]): WorkPane[] {
  const incomingTargets = new Set(
    panes.flatMap((pane) => pane.transitions ?? [])
      .filter((transition) => transition.toSpace !== 'main' && transition.fromSpace !== transition.toSpace)
      .map((transition) => transition.toSpace),
  );
  return panes.map((pane) => {
    const transitions = pane.transitions ?? [];
    const hasIncoming = incomingTargets.has(pane.spaceId);
    const incoming: WorkspaceTransitionView | undefined = hasIncoming
      ? undefined
      : {
          fromSpace: 'main',
          toSpace: pane.spaceId,
          status: 'handoff',
          message: pane.goal ?? pane.context?.detail ?? `Enter ${pane.spaceId}`,
          createdAt: new Date(pane.startedAt).toISOString(),
        };
    return {
      ...pane,
      transitions: dedupeWorkspaceTransitions([...(incoming ? [incoming] : []), ...transitions]),
    };
  });
}

function workspaceTransitionFromPreviewEntry(
  entry: SessionEntryRecord,
  data: Record<string, unknown> | undefined,
  fromSpace: string,
): WorkspaceTransitionView | undefined {
  if (stringField(data?.toolName) !== 'enterWorkspace' || data?.isError === true) {
    return undefined;
  }
  const phase = stringField(data?.phase);
  if (phase !== 'start' && phase !== 'end') {
    return undefined;
  }
  return workspaceTransitionFromInput(objectField(parseJsonObject(entry.content)), fromSpace, entry.createdAt, entry.content?.trim());
}

function workspaceTransitionFromToolEntry(
  entry: SessionEntryRecord,
  data: Record<string, unknown> | undefined,
  fromSpace: string,
): WorkspaceTransitionView | undefined {
  if (stringField(data?.toolId) !== 'enterWorkspace') {
    return undefined;
  }
  const input = objectField(data?.input);
  return workspaceTransitionFromInput(input, fromSpace, entry.createdAt, entry.content?.trim());
}

function workspaceTransitionFromInput(
  input: Record<string, unknown> | undefined,
  fromSpace: string,
  createdAt: Date,
  fallbackMessage?: string,
): WorkspaceTransitionView | undefined {
  const status = workspaceTransitionStatus(stringField(input?.status));
  const toSpace = status === 'handoff' ? stringField(input?.space) : status ? 'main' : undefined;
  if (!status || !toSpace) {
    return undefined;
  }
  const message = stringField(input?.message)
    ?? stringField(input?.task)
    ?? fallbackMessage
    ?? `${fromSpace} -> ${toSpace}`;
  return {
    fromSpace,
    toSpace,
    status,
    message,
    createdAt: createdAt.toISOString(),
  };
}

function workspaceTransitionStatus(value: string | undefined): WorkspaceTransitionView['status'] | undefined {
  if (value === 'completed' || value === 'failed' || value === 'handoff') {
    return value;
  }
  return undefined;
}

function dedupeWorkspaceTransitions(transitions: WorkspaceTransitionView[]): WorkspaceTransitionView[] {
  const seen = new Set<string>();
  const result: WorkspaceTransitionView[] = [];
  for (const transition of transitions) {
    const key = [
      transition.fromSpace,
      transition.toSpace,
      transition.status,
      transition.createdAt,
      transition.message,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(transition);
  }
  return result.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function previewToolFromEntry(
  entry: SessionEntryRecord,
  data: Record<string, unknown> | undefined,
  previewStarts: ToolCallView[],
): ToolCallView | undefined {
  const name = stringField(data?.toolName) ?? 'tool';
  const phase = stringField(data?.phase);
  const content = entry.content?.trim() ?? '';
  if (phase === 'start') {
    previewStarts.push({
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      name,
      args: content,
      result: '',
      status: 'running',
    });
    return undefined;
  }
  if (phase !== 'end' || data?.isError !== true) {
    return undefined;
  }
  const startIndex = findLastRunningToolIndex(previewStarts, name, entry.toolCallId);
  const start = startIndex >= 0 ? previewStarts.splice(startIndex, 1)[0] : undefined;
  return {
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : start?.toolCallId ? { toolCallId: start.toolCallId } : {}),
    name,
    args: start?.args ?? '',
    result: content,
    status: 'error',
  };
}

function findLastRunningToolIndex(tools: readonly ToolCallView[], name: string, toolCallId?: string): number {
  if (toolCallId) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const tool = tools[index];
      if (tool?.toolCallId === toolCallId) {
        return index;
      }
    }
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.name === name && tool.status === 'running') {
      return index;
    }
  }
  return -1;
}

function toolFromEntry(entry: SessionEntryRecord, data: Record<string, unknown> | undefined): ToolCallView {
  const name = stringField(data?.toolId) ?? 'tool';
  const args = stableJson(data?.input);
  const error = objectField(data?.error);
  const result = error ? stableJson(error) : stableJson(data?.result) || entry.content?.trim() || '';
  return {
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    name,
    args,
    result,
    status: entry.type === 'tool_result' || error ? 'error' : 'done',
  };
}

function toDisplayMessages(entries: SessionEntryRecord[], workspaceRoot?: string): DisplayMessage[] {
  let index = 1;
  let artifactId = 1;
  const messages: DisplayMessage[] = [];
  let pendingHandoffArtifacts: ArtifactView[] = [];

  entries.forEach((entry, entryIndex) => {
    if (entry.type === 'tool_result' && isAssistantHandoff(entry.data)) {
      const handoffArtifacts = artifactsFromData(entry.data, () => artifactId++, workspaceRoot);
      if (hasAssistantMessageInTurn(entries, entryIndex)) {
        const previousAssistantIndex = findPreviousAssistantIndexInCurrentTurn(messages);
        if (previousAssistantIndex >= 0) {
          const previous = messages[previousAssistantIndex]!;
          messages[previousAssistantIndex] = {
            ...previous,
            artifacts: dedupeArtifacts([...(previous.artifacts ?? []), ...handoffArtifacts]),
          };
        } else {
          pendingHandoffArtifacts = dedupeArtifacts([...pendingHandoffArtifacts, ...handoffArtifacts]);
        }
        return;
      }
    }

    const role = displayRole(entry);
    if (!role) return;
    const text = entry.content?.trim();
    if (!text) return;
    const displayText = cleanDisplayText(text);
    const artifacts = artifactsFromEntry(entry, displayText, () => artifactId++, undefined, workspaceRoot);
    const attachments = role === 'user' ? displayAttachmentsFromEntry(entry.data) : [];
    const mergedArtifacts = role === 'assistant'
      ? dedupeArtifacts([...pendingHandoffArtifacts, ...artifacts])
      : artifacts;
    if (role === 'assistant') {
      pendingHandoffArtifacts = [];
    }
    messages.push({
      id: messageIdFromEntry(entry, index++),
      entryId: entry.id,
      role,
      text: displayText,
      ts: entry.createdAt.getTime(),
      ...(mergedArtifacts.length ? { artifacts: mergedArtifacts } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  });

  return mergeDuplicateAssistantMessages(messages);
}

function messageIdFromEntry(entry: SessionEntryRecord, index: number): number {
  return entry.createdAt.getTime() * 1000 + index;
}

function displayRole(entry: SessionEntryRecord): 'user' | 'assistant' | undefined {
  if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
    return entry.role;
  }
  if (entry.type === 'tool_result' && isAssistantHandoff(entry.data)) {
    return 'assistant';
  }
  return undefined;
}

function displayAttachmentsFromEntry(data: unknown): ChatImageAttachment[] {
  const record = objectField(data);
  const raw = Array.isArray(record?.displayAttachments) ? record.displayAttachments : [];
  const attachments: ChatImageAttachment[] = [];
  for (const item of raw) {
    const attachment = displayAttachmentFromUnknown(item);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function displayAttachmentFromUnknown(value: unknown): ChatImageAttachment | undefined {
  const record = objectField(value);
  if (!record) return undefined;
  const id = stringField(record.id);
  const name = stringField(record.name);
  const mimeType = stringField(record.mimeType);
  const thumbnailDataUrl = stringField(record.thumbnailDataUrl);
  const rawPreviewDataUrl = stringField(record.previewDataUrl);
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0
    ? record.sizeBytes
    : undefined;
  if (
    record.kind !== 'image'
    || !id
    || !name
    || !mimeType
    || !isSupportedImageMimeType(mimeType)
    || sizeBytes === undefined
    || !thumbnailDataUrl
  ) {
    return undefined;
  }
  const thumbnailPayload = dataUrlToBase64Payload(thumbnailDataUrl);
  if (!thumbnailPayload || thumbnailPayload.mimeType !== mimeType) {
    return undefined;
  }
  const previewDataUrl = rawPreviewDataUrl ?? thumbnailDataUrl;
  const previewPayload = dataUrlToBase64Payload(previewDataUrl);
  if (!previewPayload || previewPayload.mimeType !== mimeType) {
    return undefined;
  }
  return {
    id,
    kind: 'image',
    name,
    mimeType,
    sizeBytes,
    thumbnailDataUrl,
    previewDataUrl,
  };
}

function isAssistantHandoff(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const projectionKind = (data as Record<string, unknown>).projectionKind;
  return projectionKind === 'artifact_handoff' || projectionKind === 'workspace_result';
}

function hasAssistantMessageInTurn(entries: SessionEntryRecord[], entryIndex: number): boolean {
  let start = entryIndex;
  while (start > 0 && !(entries[start - 1]?.type === 'message' && entries[start - 1]?.role === 'user')) {
    start -= 1;
  }

  let end = entryIndex + 1;
  while (end < entries.length && !(entries[end]?.type === 'message' && entries[end]?.role === 'user')) {
    end += 1;
  }

  for (let index = start; index < end; index += 1) {
    const entry = entries[index];
    if (entry?.type === 'message' && entry.role === 'assistant' && entry.content?.trim()) {
      return true;
    }
  }
  return false;
}

function findPreviousAssistantIndexInCurrentTurn(messages: DisplayMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === 'user' || role === 'system') return -1;
    if (role === 'assistant') return index;
  }
  return -1;
}

function cleanDisplayText(text: string): string {
  return normalizeAssistantDisplayText(text.replace(/^---\s*/, '')).trim();
}

function artifactsFromEntry(entry: SessionEntryRecord, text: string, nextId: () => number, fallbackSpaceId?: string, workspaceRoot?: string): ArtifactView[] {
  const structured = artifactsFromData(entry.data, nextId, workspaceRoot);
  if (structured.length) return structured;
  const data = objectField(entry.data);
  const projectionKind = stringField(data?.projectionKind);
  const toolId = stringField(data?.toolId);
  const spaceId = entry.workId ?? fallbackSpaceId ?? 'session';
  if (projectionKind === 'tool_execution_record' && toolId) {
    const artifact = artifactFromToolResult({ id: nextId(), name: toolId, result: text, spaceId, workspaceRoot });
    if (artifact) return [artifact];
  }
  if (entry.role !== 'assistant' && entry.role !== 'tool') return [];
  return artifactsFromText(text, spaceId, nextId, workspaceRoot);
}

function artifactsFromData(data: unknown, nextId: () => number, workspaceRoot?: string): ArtifactView[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const spaceId = stringField(record.workspaceId) ?? stringField(record.spaceId) ?? 'session';
  const artifacts: ArtifactView[] = [];

  const workspaceResult = objectField(record.workspaceResult);
  const workspaceArtifacts = Array.isArray(workspaceResult?.artifacts) ? workspaceResult.artifacts : [];
  for (const item of workspaceArtifacts) {
    const artifact = artifactFromWorkspaceResultItem(item, spaceId, nextId, workspaceRoot);
    if (artifact) artifacts.push(artifact);
  }

  const references = Array.isArray(record.references) ? record.references : [];
  for (const item of references) {
    const artifact = artifactFromReferenceItem(item, spaceId, nextId, workspaceRoot);
    if (artifact) artifacts.push(artifact);
  }

  const artifactRef = stringField(record.artifactRef) ?? stringField(record.ref) ?? stringField(record.artifactUri);
  const artifactPath = resolveArtifactPath(
    stringField(record.artifactPath) ?? refToLocalPath(artifactRef) ?? (artifactRef && !/^https?:\/\//i.test(artifactRef) ? artifactRef : undefined),
    workspaceRoot,
  );
  const artifactTitle = stringField(record.artifactTitle) ?? (artifactPath ? basename(artifactPath) : undefined);
  if (artifactPath || artifactRef) {
    artifacts.push({
      id: nextId(),
      spaceId,
      kind: artifactRef && /^https?:\/\//i.test(artifactRef) ? 'url' : 'file',
      title: artifactTitle ?? artifactRef ?? artifactPath ?? 'artifact',
      detail: '持久化产物',
      ...(artifactPath ? { path: artifactPath } : {}),
      ...(artifactRef && /^https?:\/\//i.test(artifactRef) ? { href: artifactRef } : {}),
    });
  }

  return dedupeArtifacts(artifacts);
}

function artifactFromWorkspaceResultItem(item: unknown, spaceId: string, nextId: () => number, workspaceRoot?: string): ArtifactView | null {
  const record = objectField(item);
  if (!record) return null;
  const ref = stringField(record.ref);
  const href = ref && /^https?:\/\//i.test(ref) ? ref : undefined;
  const path = href ? undefined : resolveArtifactPath(refToLocalPath(ref) ?? ref, workspaceRoot);
  if (!path && !href) return null;
  const title = stringField(record.description) ?? basename(path ?? href ?? 'artifact');
  return {
    id: nextId(),
    spaceId,
    kind: href ? 'url' : 'file',
    title,
    detail: `workspaceResult · ${stringField(record.kind) ?? 'file'}`,
    ...(path ? { path } : {}),
    ...(href ? { href } : {}),
  };
}

function artifactFromReferenceItem(item: unknown, spaceId: string, nextId: () => number, workspaceRoot?: string): ArtifactView | null {
  const record = objectField(item);
  if (!record) return null;
  const path = resolveArtifactPath(stringField(record.path), workspaceRoot);
  const url = stringField(record.url);
  if (!path && !url) return null;
  return {
    id: nextId(),
    spaceId,
    kind: url ? 'url' : 'file',
    title: stringField(record.title) ?? basename(path ?? url ?? 'artifact'),
    detail: '持久化引用',
    ...(path ? { path } : {}),
    ...(url ? { href: url } : {}),
    ...(stringField(record.lines) ? { lines: stringField(record.lines) } : {}),
  };
}

function artifactsFromText(text: string, spaceId: string, nextId: () => number, workspaceRoot?: string): ArtifactView[] {
  const matches = new Set<string>();
  const directoryHint = singleLocalDirectoryHint(text);
  const filePattern = /(?:^|[\s（(:：`"'“*])((?:\.{1,2}\/|\/)?[\w@~./\-\u4e00-\u9fff]+?\.(?:html?|css|js|mdx?|txt|json|csv|tsv|pdf|pptx?|png|jpe?g|webp|svg))(?:$|[\s（），)。,，`"'”*])/giu;
  for (const match of text.matchAll(filePattern)) {
    const path = normalizeMentionedArtifactPath(match[1]?.trim(), directoryHint);
    if (path && !isRemoteUrlPath(path)) {
      matches.add(path.replace(/^当前工作目录\s*[/:：]\s*/u, ''));
    }
    if (matches.size >= 5) break;
  }
  return [...matches].map((path) => ({
    id: nextId(),
    spaceId,
    kind: 'file' as const,
    title: basename(path),
    detail: '消息中提到的文件',
    path: resolveArtifactPath(path, workspaceRoot) ?? path,
  }));
}

function singleLocalDirectoryHint(text: string): string | undefined {
  const hints = new Set<string>();
  const directoryPattern = /(?:^|[\s（(:：`"'“])((?:\.{1,2}\/)?[\w@~.\-\u4e00-\u9fff]+\/)(?:$|[\s（），)。,，`"'”])/giu;
  for (const match of text.matchAll(directoryPattern)) {
    const hint = match[1]?.trim();
    if (!hint || isRemoteUrlPath(hint)) continue;
    hints.add(hint.replace(/\/+$/, '/'));
    if (hints.size > 1) return undefined;
  }
  return [...hints][0];
}

function normalizeMentionedArtifactPath(path: string | undefined, directoryHint: string | undefined): string | undefined {
  if (!path) return undefined;
  const cleaned = path.replace(/^当前工作目录\s*[/:：]\s*/u, '');
  if (!directoryHint || isAbsoluteArtifactPath(cleaned) || cleaned.includes('/') || cleaned.includes('\\')) {
    return cleaned;
  }
  return `${directoryHint}${cleaned}`;
}

function isAbsoluteArtifactPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function isRemoteUrlPath(path: string): boolean {
  const trimmed = path.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    return true;
  }
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, '');
  const firstSegment = withoutLeadingSlashes.split(/[\\/]/, 1)[0] ?? '';
  return withoutLeadingSlashes.includes('/') && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(firstSegment);
}

function dedupeArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return dedupeArtifactViews(artifacts);
}

function reindexArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return artifacts.map((artifact, index) => ({ ...artifact, id: index + 1 }));
}

function mergeDuplicateAssistantMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (
      previous?.role === 'assistant' &&
      message.role === 'assistant' &&
      normalizeText(previous.text) === normalizeText(message.text)
    ) {
      result[result.length - 1] = {
        ...previous,
        text: message.text,
        ts: message.ts,
        artifacts: dedupeArtifacts([...(previous.artifacts ?? []), ...(message.artifacts ?? [])]),
      };
      continue;
    }
    result.push(message);
  }
  return result;
}

function normalizeText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stableJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonObject(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function numberParam(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function statusForError(message: string): number {
  if (message === 'project_not_found' || message === 'conversation_not_found') return 404;
  if (message.endsWith('_not_allowed')) return 403;
  return 400;
}

import {
  DEFAULT_AVATAR_ID,
  DEFAULT_FILE_WORKSPACE_ROOT,
  resolveConversationWorkspaceRoot,
  type ActorContext,
  type ThreadRecord,
  type ThreadStatus,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { mkdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { resolveBrowsePath } from './projectPaths';
import { projectStore } from './projectStore';

export const CONVERSATION_SOURCES = ['web', 'api', 'wechat', 'feishu', 'feishu-cli'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

export type ConversationWorkspaceRecord = {
  conversationId: string;
  threadId: string;
  sessionId: string;
  source: ConversationSource;
  avatarId: string;
  title: string;
  workspaceRoot: string;
  workspaceKind: 'project' | 'artifact';
  projectId?: string;
};

export type EnsureConversationWorkspaceInput = {
  conversationId: string;
  source?: ConversationSource;
  avatarId?: string;
  projectId?: string | null;
  /** Authoritative title: overrides any existing title (explicit create/rename). */
  title?: string;
  /** Seed title applied ONLY when creating the conversation (e.g. the first user
   *  message). Ignored for existing threads so later turns don't rewrite it. */
  seedTitle?: string;
};

export type ConversationSummaryRecord = {
  conversationId: string;
  threadId: string;
  mainSessionId?: string;
  source: ConversationSource;
  avatarId: string;
  title: string;
  status: ThreadStatus;
  updatedAt: Date;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
  projectId?: string;
};

type Owner = { userId?: string; tenantId?: string };

export async function ensureConversationWorkspace(
  store: ZleapStore,
  actor: ActorContext,
  input: EnsureConversationWorkspaceInput,
): Promise<ConversationWorkspaceRecord> {
  const conversationId = sanitizeConversationId(input.conversationId);
  const preferredSource = input.source ?? 'web';
  const owner = ownerFromActor(actor);
  const existingThread = await findConversationThread(store, conversationId, owner, preferredSource);
  const source = existingThread ? sourceFromThread(existingThread) : preferredSource;
  const existingMetadata = existingThread?.metadata;
  const threadId = existingThread?.id ?? `${source}:${conversationId}`;
  const sessionId = existingThread?.mainSessionId ?? `${threadId}:main`;
  const explicitProjectId = input.projectId === null ? undefined : clean(input.projectId);
  const existingProjectId = metadataString(existingMetadata, 'projectId');
  const projectId = input.projectId !== undefined ? explicitProjectId : existingProjectId;
  const avatarId = clean(input.avatarId) ?? existingThread?.avatarId ?? DEFAULT_AVATAR_ID;
  const title = clean(input.title) ?? existingThread?.title ?? clean(input.seedTitle) ?? '新对话';
  const workspace = await resolveWorkspace({
    conversationId,
    projectId,
    title,
    existingWorkspaceRoot: projectId ? undefined : metadataString(existingMetadata, 'workspaceRoot'),
  });
  const now = new Date();
  const metadata = {
    ...(existingMetadata ?? {}),
    conversationId,
    ...actorMetadata(actor),
    workspaceRoot: workspace.root,
    workspaceKind: workspace.kind,
    ...(projectId ? { projectId } : {}),
  };
  if (!projectId) {
    delete (metadata as Record<string, unknown>).projectId;
  }

  await store.transaction(async (tx) => {
    await tx.threads.createThread({
      id: threadId,
      avatarId,
      userId: actor.userId,
      tenantId: actor.tenantId,
      title,
      mainSessionId: sessionId,
      status: 'active',
      source,
      createdAt: existingThread?.createdAt ?? now,
      updatedAt: now,
      metadata,
    });
    await tx.sessions.createSession({
      id: sessionId,
      threadId,
      avatarId,
      userId: actor.userId,
      tenantId: actor.tenantId,
      spaceId: 'main',
      kind: 'main',
      status: 'active',
      rootGoal: title,
      source,
      createdAt: existingThread?.createdAt ?? now,
      updatedAt: now,
      metadata,
    });
  });

  return {
    conversationId,
    threadId,
    sessionId,
    source,
    avatarId,
    title,
    workspaceRoot: workspace.root,
    workspaceKind: workspace.kind,
    ...(projectId ? { projectId } : {}),
  };
}

export async function readConversationWorkspace(
  store: ZleapStore,
  actor: ActorContext,
  input: { conversationId: string; source?: ConversationSource; avatarId?: string },
): Promise<ConversationWorkspaceRecord> {
  const conversationId = sanitizeConversationId(input.conversationId);
  const owner = ownerFromActor(actor);
  const thread = await findConversationThread(store, conversationId, owner, input.source);
  if (!thread) throw new Error('conversation_not_found');
  if (input.avatarId && thread.avatarId !== input.avatarId) throw new Error('conversation_not_found');

  const sessionId = thread.mainSessionId ?? `${thread.id}:main`;
  const session = await store.sessions.getSession(sessionId, owner);
  const workspaceRoot = metadataString(thread.metadata, 'workspaceRoot') ?? metadataString(session?.metadata, 'workspaceRoot');
  if (!workspaceRoot) throw new Error('conversation_workspace_uninitialized');
  const root = resolve(workspaceRoot);
  await assertWorkspaceRootAllowed(root);
  const projectId = metadataString(thread.metadata, 'projectId') ?? metadataString(session?.metadata, 'projectId');
  const source = sourceFromThread(thread);
  return {
    conversationId,
    threadId: thread.id,
    sessionId,
    source,
    avatarId: thread.avatarId,
    title: thread.title ?? (basename(root) || '新对话'),
    workspaceRoot: root,
    workspaceKind: projectId ? 'project' : 'artifact',
    ...(projectId ? { projectId } : {}),
  };
}

export async function listConversationSummaries(
  store: ZleapStore,
  actor: ActorContext,
  input: { status: ThreadStatus; limit?: number },
): Promise<ConversationSummaryRecord[]> {
  const owner = ownerFromActor(actor);
  const threads = await store.threads.listThreads({ ...owner, status: input.status, limit: input.limit ?? 100 });
  return threads.map(conversationSummaryFromThread);
}

export async function setConversationWorkspaceStatus(
  store: ZleapStore,
  actor: ActorContext,
  input: { conversationId: string; source?: ConversationSource; status: ThreadStatus },
): Promise<ConversationSummaryRecord> {
  const conversationId = sanitizeConversationId(input.conversationId);
  const owner = ownerFromActor(actor);
  const thread = await findConversationThread(store, conversationId, owner, input.source);
  if (!thread) throw new Error('conversation_not_found');
  const now = new Date();
  const next = { ...thread, status: input.status, updatedAt: now };
  await store.threads.createThread(next);
  return conversationSummaryFromThread(next);
}

export function conversationSource(value: string | null | undefined): ConversationSource | undefined {
  return CONVERSATION_SOURCES.find((source) => source === value);
}

export function conversationThreadCandidates(conversationId: string, preferredSource?: ConversationSource): string[] {
  return orderedConversationSources(preferredSource).map((source) => `${source}:${conversationId}`);
}

export function sanitizeConversationId(value: string | undefined): string {
  const sanitized = value?.trim().replace(/[^\w:.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
  if (!sanitized) throw new Error('conversation_id_required');
  return sanitized;
}

export function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return clean(typeof metadata?.[key] === 'string' ? metadata[key] : undefined);
}

async function resolveWorkspace(input: {
  conversationId: string;
  projectId?: string;
  title: string;
  existingWorkspaceRoot?: string;
}): Promise<{ root: string; kind: 'project' | 'artifact' }> {
  if (input.projectId) {
    const project = (await projectStore.list()).find((item) => item.id === input.projectId);
    if (!project) throw new Error('project_not_found');
    return { root: resolveBrowsePath(project.path), kind: 'project' };
  }
  if (input.existingWorkspaceRoot) {
    const root = resolve(input.existingWorkspaceRoot);
    await assertWorkspaceRootAllowed(root);
    await mkdir(root, { recursive: true });
    return { root, kind: 'artifact' };
  }
  const root = resolveConversationWorkspaceRoot({
    conversationId: input.conversationId,
    titleSeed: input.title,
    baseRoot: process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT,
  });
  await mkdir(root, { recursive: true });
  return { root, kind: 'artifact' };
}

async function findConversationThread(
  store: ZleapStore,
  conversationId: string,
  owner: Owner,
  preferredSource?: ConversationSource,
): Promise<ThreadRecord | undefined> {
  for (const threadId of threadCandidates(conversationId, preferredSource)) {
    const thread = await store.threads.getThread(threadId, owner);
    if (thread) return thread;
  }
  return undefined;
}

function threadCandidates(conversationId: string, preferredSource?: ConversationSource): string[] {
  return conversationThreadCandidates(conversationId, preferredSource);
}

function ownerFromActor(actor: ActorContext): Owner {
  return { userId: actor.userId, tenantId: actor.tenantId };
}

function actorMetadata(actor: ActorContext): Record<string, string> {
  return {
    userId: actor.userId,
    actorRole: actor.role,
    ...(actor.tenantId ? { tenantId: actor.tenantId } : {}),
  };
}

function sourceFromThread(thread: ThreadRecord): ConversationSource {
  return conversationSource(thread.source) ?? 'web';
}

function conversationSummaryFromThread(thread: ThreadRecord): ConversationSummaryRecord {
  const projectId = metadataString(thread.metadata, 'projectId');
  const workspaceRoot = metadataString(thread.metadata, 'workspaceRoot');
  const workspaceKind = metadataString(thread.metadata, 'workspaceKind');
  return {
    conversationId: metadataString(thread.metadata, 'conversationId') ?? stripKnownSourcePrefix(thread.id),
    threadId: thread.id,
    mainSessionId: thread.mainSessionId,
    source: sourceFromThread(thread),
    avatarId: thread.avatarId,
    title: thread.title ?? '新对话',
    status: thread.status,
    updatedAt: thread.updatedAt,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(workspaceKind === 'project' || workspaceKind === 'artifact'
      ? { workspaceKind }
      : projectId
        ? { workspaceKind: 'project' as const }
        : workspaceRoot
          ? { workspaceKind: 'artifact' as const }
          : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function orderedConversationSources(preferredSource?: ConversationSource): ConversationSource[] {
  const preferred = preferredSource ?? 'web';
  return [
    preferred,
    ...CONVERSATION_SOURCES.filter((source) => source !== preferred),
  ];
}

function stripKnownSourcePrefix(threadId: string): string {
  for (const source of CONVERSATION_SOURCES) {
    const prefix = `${source}:`;
    if (threadId.startsWith(prefix)) {
      return threadId.slice(prefix.length);
    }
  }
  return threadId;
}

async function assertWorkspaceRootAllowed(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const artifactRoot = resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT);
  if (pathInside(resolvedRoot, artifactRoot)) return;

  for (const project of await projectStore.list()) {
    try {
      if (pathInside(resolvedRoot, resolveBrowsePath(project.path))) return;
    } catch {
      // Invalid project records do not expand the allowed root set.
    }
  }
  throw new Error('workspace_root_not_allowed');
}

function pathInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

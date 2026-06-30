'use client';

import { useCallback, useEffect, useState } from 'react';
import { patchJson, webApiFetch } from './api';
import { clearAllComposerDrafts, clearComposerDraft } from './composerDrafts';
import { normalizeDisplayMessages } from './displayMessages';
import type { DisplayMessage, WorkPane } from './types';

/** What we snapshot per conversation so switching restores the full view:
 *  the chat transcript AND the 调度台 work panes (console state). */
export type ConversationSnapshot = { messages: DisplayMessage[]; workspaces: WorkPane[] };

/**
 * Client-side conversation manager (localStorage). Tracks the list of
 * conversations (threads) the user has started — each with its own agent,
 * optional project, title, and a message snapshot so switching restores the
 * transcript. This is the local-first MVP; it swaps to a durable `/api/threads`
 * (store-backed `listThreads`/`buildConversation`) without changing callers.
 */
export type Conversation = {
  id: string;
  title: string;
  source?: string;
  agentId: string;
  projectId?: string;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
  updatedAt: number;
  archived?: boolean;
  /** User renamed it — auto-title (from first message) must not override. */
  titled?: boolean;
};

export type ConversationContextPatch = {
  agentId?: string;
  projectId?: string | null;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
};

const LIST_KEY = 'zleap-conversations';
const MSGS_PREFIX = 'zleap-conv-msgs:';

function readList(): Conversation[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const parsed = raw ? (JSON.parse(raw) as Conversation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list: Conversation[]): void {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    // storage full / private mode — conversations are best-effort
  }
}

export type ConversationsApi = {
  /** Started conversations, most-recent-first. */
  conversations: Conversation[];
  /** Archived conversations (status='archived'), most-recent-first. */
  archivedConversations: Conversation[];
  /** Add a conversation (with a caller-supplied id) to the list if not present.
   *  The active conversation id is owned by the page, not here. */
  ensure: (id: string, agentId: string, projectId?: string) => void;
  /** Hard-remove a conversation locally (used for permanent delete from the archive). */
  remove: (id: string) => void;
  /** Archive: PATCH status='archived' + local flag; it leaves the active list. */
  archive: (id: string) => void;
  /** Restore an archived conversation back to active. */
  unarchive: (id: string) => void;
  /** Bump updatedAt and, if still untitled, set the title from the first message. */
  touch: (id: string, titleSeed?: string) => void;
  /** Rename a conversation (and mark it user-titled so auto-title won't override). */
  rename: (id: string, title: string) => void;
  /** Update agent/project for an existing thread (e.g. mid-conversation switch). */
  updateContext: (id: string, patch: ConversationContextPatch) => void;
  refresh: () => Promise<void>;
  clearAll: () => void;
  loadSnapshot: (id: string) => ConversationSnapshot;
  saveSnapshot: (id: string, snapshot: ConversationSnapshot) => void;
};

const UNTITLED = '新对话';
type RemoteConversation = {
  conversationId?: unknown;
  title?: unknown;
  avatarId?: unknown;
  projectId?: unknown;
  workspaceRoot?: unknown;
  workspaceKind?: unknown;
  source?: unknown;
  updatedAt?: unknown;
};

type ConversationListResponse = {
  conversations?: unknown;
  archived?: unknown;
};

export function useConversations(defaultAgentId: string): ConversationsApi {
  const [list, setList] = useState<Conversation[]>([]);

  const persist = useCallback((next: Conversation[]) => {
    setList(next);
    writeList(next);
  }, []);

  const refresh = useCallback(async () => {
    const response = await webApiFetch('/api/chat/conversation?limit=100');
    const body = (await response.json().catch(() => ({}))) as ConversationListResponse;
    if (!response.ok) {
      throw new Error(typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${response.status}`);
    }
    const active = Array.isArray(body.conversations) ? body.conversations : [];
    const archived = Array.isArray(body.archived) ? body.archived : [];
    const remote = [
      ...active.map((item) => remoteConversation(item, defaultAgentId, false)).filter((item): item is Conversation => Boolean(item)),
      ...archived.map((item) => remoteConversation(item, defaultAgentId, true)).filter((item): item is Conversation => Boolean(item)),
    ];
    persist(mergeRemoteConversations(readList(), remote));
  }, [defaultAgentId, persist]);

  useEffect(() => {
    setList(readList());
    void refresh().catch(() => undefined);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 15_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const ensure = useCallback(
    (id: string, agentId: string, projectId?: string) => {
      if (readList().some((c) => c.id === id)) return;
      const conv: Conversation = { id, title: UNTITLED, agentId: agentId || defaultAgentId, projectId, updatedAt: Date.now() };
      persist([conv, ...readList()]);
    },
    [defaultAgentId, persist],
  );

  const remove = useCallback(
    (id: string) => {
      persist(readList().filter((c) => c.id !== id));
      try {
        localStorage.removeItem(`${MSGS_PREFIX}${id}`);
      } catch {
        /* best-effort */
      }
      clearComposerDraft(id);
    },
    [persist],
  );

  const archive = useCallback(
    (id: string) => {
      persist(readList().map((c) => (c.id === id ? { ...c, archived: true } : c)));
      void patchJson('/api/chat/conversation', { conversationId: id, status: 'archived' }).catch(() => undefined);
    },
    [persist],
  );

  const unarchive = useCallback(
    (id: string) => {
      persist(readList().map((c) => (c.id === id ? { ...c, archived: false, updatedAt: Date.now() } : c)));
      void patchJson('/api/chat/conversation', { conversationId: id, status: 'active' }).catch(() => undefined);
    },
    [persist],
  );

  const touch = useCallback(
    (id: string, titleSeed?: string) => {
      persist(
        readList().map((c) => {
          if (c.id !== id) return c;
          const title = !c.titled && c.title === UNTITLED && titleSeed?.trim() ? titleSeed.trim().slice(0, 40) : c.title;
          return { ...c, title, updatedAt: Date.now() };
        }),
      );
    },
    [persist],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      const next = title.trim();
      if (!next) return;
      persist(readList().map((c) => (c.id === id ? { ...c, title: next.slice(0, 60), titled: true } : c)));
    },
    [persist],
  );

  const updateContext = useCallback(
    (id: string, patch: ConversationContextPatch) => {
      persist(readList().map((c) => (c.id === id ? applyConversationContextPatch(c, patch) : c)));
    },
    [persist],
  );

  const clearAll = useCallback(() => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key === LIST_KEY || key?.startsWith(MSGS_PREFIX)) {
          keys.push(key);
        }
      }
      for (const key of keys) {
        localStorage.removeItem(key);
      }
      clearAllComposerDrafts();
    } catch {
      /* best-effort */
    }
    setList([]);
  }, []);

  const loadSnapshot = useCallback((id: string): ConversationSnapshot => {
    try {
      const raw = localStorage.getItem(`${MSGS_PREFIX}${id}`);
      const parsed = raw ? (JSON.parse(raw) as Partial<ConversationSnapshot>) : {};
      return {
        messages: Array.isArray(parsed.messages) ? normalizeDisplayMessages(parsed.messages) : [],
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      };
    } catch {
      return { messages: [], workspaces: [] };
    }
  }, []);

  const saveSnapshot = useCallback((id: string, snapshot: ConversationSnapshot) => {
    try {
      localStorage.setItem(`${MSGS_PREFIX}${id}`, JSON.stringify({ ...snapshot, messages: normalizeDisplayMessages(snapshot.messages) }));
    } catch {
      /* best-effort */
    }
  }, []);

  const started = list.filter(isStartedConversation);
  const visible = started.filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const archivedConversations = started.filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    conversations: visible,
    archivedConversations,
    ensure,
    remove,
    archive,
    unarchive,
    touch,
    rename,
    updateContext,
    refresh,
    clearAll,
    loadSnapshot,
    saveSnapshot,
  };
}

function remoteConversation(item: unknown, defaultAgentId: string, archived: boolean): Conversation | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const record = item as RemoteConversation;
  const id = stringField(record.conversationId);
  if (!id) return undefined;
  const workspaceKind = record.workspaceKind === 'project' || record.workspaceKind === 'artifact' ? record.workspaceKind : undefined;
  return {
    id,
    title: stringField(record.title) ?? UNTITLED,
    source: stringField(record.source),
    agentId: stringField(record.avatarId) ?? defaultAgentId,
    projectId: stringField(record.projectId),
    workspaceRoot: stringField(record.workspaceRoot),
    workspaceKind,
    updatedAt: dateMs(record.updatedAt),
    archived,
  };
}

function mergeRemoteConversations(local: Conversation[], remote: Conversation[]): Conversation[] {
  const localById = new Map(local.map((conversation) => [conversation.id, conversation]));
  const remoteIds = new Set(remote.map((conversation) => conversation.id));
  const mergedRemote = remote.map((conversation) => {
    const localConversation = localById.get(conversation.id);
    return {
      ...localConversation,
      ...conversation,
      title: localConversation?.titled ? localConversation.title : conversation.title,
      titled: localConversation?.titled,
    };
  });
  return [...mergedRemote, ...local.filter((conversation) => !remoteIds.has(conversation.id))];
}

export function applyConversationContextPatch(conversation: Conversation, patch: ConversationContextPatch): Conversation {
  const next: Conversation = {
    ...conversation,
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId || undefined } : {}),
    ...(patch.workspaceRoot !== undefined ? { workspaceRoot: patch.workspaceRoot || undefined } : {}),
    ...(patch.workspaceKind !== undefined ? { workspaceKind: patch.workspaceKind } : {}),
  };
  return next;
}

function isStartedConversation(conversation: Conversation): boolean {
  if (conversation.title !== UNTITLED || conversation.titled) return true;
  return snapshotHasContent(conversation.id);
}

function snapshotHasContent(id: string): boolean {
  try {
    const raw = localStorage.getItem(`${MSGS_PREFIX}${id}`);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<ConversationSnapshot>;
    return Boolean(
      (Array.isArray(parsed.messages) && parsed.messages.length > 0) ||
      (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0),
    );
  } catch {
    return false;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateMs(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Date.now();
}

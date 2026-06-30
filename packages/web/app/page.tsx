'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { SPRING_PANEL } from "@/lib/motion";
import { Menu, PanelRight, PanelRightOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Composer, type GoalComposerState } from '../components/Composer';
import { ConfirmCard } from '../components/ConfirmCard';
import { Conversation } from '../components/Conversation';
import { RunRecovery } from '../components/RunRecovery';
import { Sidebar } from '../components/Sidebar';
import { SettingsPage } from '../components/SettingsPage';
import { Wordmark } from '../components/Wordmark';
import { WorkspaceFilesDrawer } from '../components/WorkspaceFilesDrawer';
import { CollapsedPill } from '../components/console/CollapsedPill';
import { WorkspacePanel } from '../components/console/WorkspacePanel';
import { OnboardingRedirect } from '../components/OnboardingRedirect';
import { ProjectDialog } from '../components/manage/ProjectDialog';
import { deleteJson, webApiFetch } from '../lib/api';
import { mockEngine } from '../lib/engine';
import { sseEngine } from '../lib/sseEngine';
import { dropAllConversationRuntimes, dropConversationRuntime, getConversationRuntime, newConversationId, useConversation, useRunningConversationIds } from '../lib/conversationRuntime';
import { defaultModelId, llmModels } from '../lib/models';
import { useConversations } from '../lib/useConversations';
import { useResources } from '../lib/useResources';
import { useSpaces } from '../lib/useSpaces';
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, type PermissionMode } from '../lib/permissions';
import { normalizeDisplayMessages } from '../lib/displayMessages';
import { composerDraftIdForConversation, initialComposerDraftsForHydration, readComposerDraft, writeComposerDraft } from '../lib/composerDrafts';
import type { ChatSendOptions, RunMode } from '../lib/runModes';
import { latestPlanReplyPrompt } from '../lib/planOptions';
import { RESOURCE_PAGES, type PageKey } from '../components/manage/pages';
import { EDIT_PAGES, type EditKind } from '../components/manage/edit';
import type { DisplayMessage, WorkPane } from '../lib/types';
import type { WorkspaceFileTarget } from '../lib/workspaceFiles';

// Flip to `true` to drive the UI from the offline mock (multi-space demo)
// instead of the real agent served by /api/chat.
const USE_MOCK = false;
const engine = USE_MOCK ? mockEngine : sseEngine;
const MODEL_LABEL = USE_MOCK ? 'mock engine' : 'zleap engine';
type MainView = 'chat' | 'settings' | PageKey;
type ConversationGoals = Record<string, GoalComposerState>;
const CONVERSATION_PAGE_SIZE = 40;
type PersistedConversationResponse = {
  messages?: DisplayMessage[];
  workspaces?: WorkPane[];
  hasMore?: boolean;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
  projectId?: string;
};

type ConversationPage = {
  messages: DisplayMessage[];
  workspaces: WorkPane[];
  hasMore: boolean;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
  projectId?: string;
};

type ConversationEnsureResponse = {
  conversationId: string;
  avatarId?: string;
  title?: string;
  projectId?: string;
  workspaceRoot?: string;
  workspaceKind?: 'project' | 'artifact';
};

async function loadConversationSnapshot(
  conversationId: string,
  avatarId: string,
  options: { before?: string; source?: string } = {},
): Promise<ConversationPage> {
  const params = new URLSearchParams({ conversationId, avatarId, source: options.source ?? 'api', limit: String(CONVERSATION_PAGE_SIZE) });
  if (options.before) params.set('before', options.before);
  const response = await webApiFetch(`/api/chat/conversation?${params.toString()}`);
  const body = (await response.json().catch(() => ({}))) as PersistedConversationResponse & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return {
    messages: Array.isArray(body.messages) ? normalizeDisplayMessages(body.messages) : [],
    workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
    hasMore: body.hasMore === true,
    workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : undefined,
    workspaceKind: body.workspaceKind === 'project' || body.workspaceKind === 'artifact' ? body.workspaceKind : undefined,
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
  };
}

async function ensureServerConversation(input: {
  conversationId: string;
  avatarId: string;
  projectId?: string;
  title?: string;
}): Promise<ConversationEnsureResponse> {
  const response = await webApiFetch('/api/chat/conversation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: input.conversationId,
      source: 'web',
      avatarId: input.avatarId,
      projectId: input.projectId ?? null,
      title: input.title,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as ConversationEnsureResponse & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

async function deleteServerConversation(input: {
  conversationId: string;
  source?: string;
  avatarId?: string;
}): Promise<void> {
  await deleteJson('/api/chat/conversation', {
    conversationId: input.conversationId,
    source: input.source ?? 'web',
    avatarId: input.avatarId,
  });
}

export default function Page() {
  const { t } = useTranslation();
  const [activeAvatarId, setActiveAvatarId] = useState('zleap-default');
  /** The active conversation id — always set (a fresh one = the home/new chat).
   *  The page owns this; each id maps to a background-surviving runtime. */
  const [activeConvId, setActiveConvId] = useState(newConversationId);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>(initialComposerDraftsForHydration);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [spacesRefreshKey, setSpacesRefreshKey] = useState(0);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const spaces = useSpaces(spacesRefreshKey, activeAvatarId);
  const resources = useResources(activeAvatarId);
  const runningConversationIds = useRunningConversationIds();
  const conversations = useConversations('zleap-default');
  const activeConv = conversations.conversations.find((conversation) => conversation.id === activeConvId);
  const activeComposerDraftId = composerDraftIdForConversation(activeConvId, Boolean(activeConv));
  /** Project picker state when the thread is not yet in the conversation list. */
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(undefined);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [composerRunMode, setComposerRunMode] = useState<RunMode>('normal');
  const [composerSkillId, setComposerSkillId] = useState<string | undefined>(undefined);
  const [conversationGoals, setConversationGoals] = useState<ConversationGoals>({});
  const [dismissedPlanReplyIds, setDismissedPlanReplyIds] = useState<Set<string>>(() => new Set());
  const composerDraft = composerDrafts[activeComposerDraftId] ?? '';
  useEffect(() => {
    setComposerDrafts((previous) => {
      if (Object.prototype.hasOwnProperty.call(previous, activeComposerDraftId)) return previous;
      const draft = readComposerDraft(activeComposerDraftId);
      return draft ? { ...previous, [activeComposerDraftId]: draft } : previous;
    });
  }, [activeComposerDraftId]);
  const updateComposerDraft = useCallback((text: string) => {
    setComposerDrafts((previous) => {
      if (!text) {
        if (!Object.prototype.hasOwnProperty.call(previous, activeComposerDraftId)) return previous;
        const next = { ...previous };
        delete next[activeComposerDraftId];
        return next;
      }
      if (previous[activeComposerDraftId] === text) return previous;
      return { ...previous, [activeComposerDraftId]: text };
    });
    writeComposerDraft(activeComposerDraftId, text);
  }, [activeComposerDraftId]);
  useEffect(() => {
    const def = defaultModelId(resources.models, 'llm');
    if (def && !selectedModelId) setSelectedModelId(def);
  }, [resources.models, selectedModelId]);
  useEffect(() => {
    if (!composerSkillId) return;
    if (!resources.skills.some((skill) => skill.id === composerSkillId)) {
      setComposerSkillId(undefined);
    }
  }, [composerSkillId, resources.skills]);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ avatarId: activeAvatarId });
    void webApiFetch(`/api/preferences/permissions?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) return undefined;
        return (await response.json()) as { mode?: unknown };
      })
      .then((body) => {
        if (!cancelled) setPermissionModeState(normalizePermissionMode(body?.mode));
      })
      .catch(() => {
        if (!cancelled) setPermissionModeState(DEFAULT_PERMISSION_MODE);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAvatarId]);
  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setPermissionModeState(mode);
    void webApiFetch('/api/preferences/permissions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatarId: activeAvatarId, mode }),
    })
      .then(async (response) => (response.ok ? ((await response.json()) as { mode?: unknown }) : undefined))
      .then((body) => {
        if (body?.mode) setPermissionModeState(normalizePermissionMode(body.mode));
      })
      .catch(() => undefined);
  }, [activeAvatarId]);
  const chatModels = useMemo(() => llmModels(resources.models), [resources.models]);
  const conversationContext = useMemo(
    () => ({
      avatarId: activeConv?.agentId ?? activeAvatarId,
      projectId: activeConv?.projectId ?? selectedProjectId,
      modelId: selectedModelId,
      permissionMode,
    }),
    [activeConv?.agentId, activeConv?.projectId, activeAvatarId, selectedProjectId, selectedModelId, permissionMode],
  );
  const wb = useConversation(activeConvId, engine, spaces, conversationContext);
  const ensureActiveServerConversation = useCallback(
    async (title?: string): Promise<ConversationEnsureResponse> => {
      conversations.ensure(activeConvId, conversationContext.avatarId, conversationContext.projectId);
      const record = await ensureServerConversation({
        conversationId: activeConvId,
        avatarId: conversationContext.avatarId,
        projectId: conversationContext.projectId,
        title: title ?? activeConv?.title,
      });
      conversations.updateContext(activeConvId, {
        agentId: record.avatarId ?? conversationContext.avatarId,
        projectId: record.projectId ?? null,
        workspaceRoot: record.workspaceRoot,
        workspaceKind: record.workspaceKind,
      });
      return record;
    },
    [activeConv?.title, activeConvId, conversationContext.avatarId, conversationContext.projectId, conversations],
  );
  const activeGoal = conversationGoals[activeConvId];
  /** Which main-area view: the chat, settings, or a full resource page. */
  const [view, setView] = useState<MainView>('chat');
  /** Resource pages return to settings when opened from settings; otherwise chat. */
  const [resourceBackView, setResourceBackView] = useState<'chat' | 'settings'>('chat');
  /** When set, the main area shows a full edit page (takes precedence over view). */
  const [editing, setEditing] = useState<{ kind: EditKind; id: string } | null>(null);
  // Entering a conversation starts with the right workspace panel tucked away;
  // active runs can still reveal it when they produce new workspace output.
  const [collapsed, setCollapsed] = useState(true);
  const [workspaceFilesOpen, setWorkspaceFilesOpen] = useState(false);
  const [workspaceFileTarget, setWorkspaceFileTarget] = useState<WorkspaceFileTarget | null>(null);
  const [workspaceFilesRefreshToken, setWorkspaceFilesRefreshToken] = useState(0);
  const [workspaceDrawerWidth, setWorkspaceDrawerWidth] = useState(360);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Once a run has opened the console, keep it open for the session so the
  // conversation layout stays fixed across turns (no open/close reflow).
  const [consoleActivated, setConsoleActivated] = useState(false);
  const prevWorkspaceCount = useRef(wb.workspaces.length);
  const prevWorkspaceConversationId = useRef(activeConvId);
  useEffect(() => {
    const count = wb.workspaces.length;
    if (prevWorkspaceConversationId.current !== activeConvId) {
      prevWorkspaceConversationId.current = activeConvId;
      prevWorkspaceCount.current = count;
      setWorkspaceFilesOpen(false);
      setCollapsed(true);
      return;
    }
    // A newly produced workspace in the active run opens the shared panel onto
    // that space tab; loading an existing conversation stays collapsed.
    if (wb.status === 'running' && count > prevWorkspaceCount.current) {
      setConsoleActivated(true);
      setCollapsed(false);
      setWorkspaceFilesOpen(false);
    }
    prevWorkspaceCount.current = count;
  }, [activeConvId, wb.status, wb.workspaces.length]);

  useEffect(() => {
    setWorkspaceDrawerWidth(defaultSidePanelWidth());
  }, []);

  const consoleOpen = consoleActivated && !collapsed && !workspaceFilesOpen;
  const filesPanelOpen = workspaceFilesOpen && view === 'chat' && !editing;
  const filesPanelWide = workspaceDrawerWidth >= 720;
  // The shared right sidebar shows the directory tab or a space tab; it is open
  // whenever either the directory or the console would have been visible.
  const rightPanelOpen = (consoleOpen || filesPanelOpen) && view === 'chat' && !editing;
  const resetWorkspaceFilesPanel = useCallback(() => {
    setWorkspaceFileTarget(null);
    setWorkspaceFilesOpen(false);
  }, []);
  const openWorkspaceFiles = useCallback(() => {
    setWorkspaceFileTarget(null);
    void ensureActiveServerConversation()
      .then(() => {
        setWorkspaceFilesRefreshToken((value) => value + 1);
        setWorkspaceFilesOpen(true);
      })
      .catch(() => undefined);
  }, [ensureActiveServerConversation]);
  const selectWorkspaceTab = (id: string) => {
    setWorkspaceFilesOpen(false);
    setCollapsed(false);
    wb.selectWorkspace(id);
  };
  const collapseRightPanel = () => {
    setWorkspaceFilesOpen(false);
    setCollapsed(true);
  };
  const openWorkspaceFile = useCallback((target: WorkspaceFileTarget) => {
    void ensureActiveServerConversation()
      .then(() => {
        setWorkspaceFileTarget((current) => ({
          ...target,
          requestId: (current?.requestId ?? 0) + 1,
        }));
        setCollapsed(true);
        setWorkspaceFilesOpen(true);
      })
      .catch(() => undefined);
  }, [ensureActiveServerConversation]);
  const startWorkspaceDrawerResize = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = workspaceDrawerWidth;
      const onMouseMove = (moveEvent: MouseEvent) => {
        setWorkspaceDrawerWidth(clampSidePanelWidth(startWidth + startX - moveEvent.clientX));
      };
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [workspaceDrawerWidth],
  );
  const activePlanReply = useMemo(
    () => (wb.status === 'running' ? undefined : latestPlanReplyPrompt(wb.messages, dismissedPlanReplyIds)),
    [wb.messages, wb.status, dismissedPlanReplyIds],
  );
  const dismissPlanReply = useCallback((messageId: string) => {
    setDismissedPlanReplyIds((previous) => {
      const next = new Set(previous);
      next.add(messageId);
      return next;
    });
  }, []);

  useEffect(() => {
    setDismissedPlanReplyIds(new Set());
  }, [activeConvId]);

  useEffect(() => {
    resetWorkspaceFilesPanel();
  }, [activeConvId, view, editing, resetWorkspaceFilesPanel]);

  const clearActiveGoal = useCallback(() => {
    setConversationGoals((previous) => {
      if (!previous[activeConvId]) return previous;
      const next = { ...previous };
      delete next[activeConvId];
      return next;
    });
  }, [activeConvId]);

  const handleComposerRunModeChange = useCallback(
    (mode: RunMode) => {
      setComposerRunMode(mode);
      if (mode !== 'goal') {
        clearActiveGoal();
      } else {
        setConversationGoals((previous) => {
          const goal = previous[activeConvId];
          if (!goal || goal.status === 'active') return previous;
          return { ...previous, [activeConvId]: { ...goal, status: 'active' } };
        });
      }
    },
    [activeConvId, clearActiveGoal],
  );

  const updateActiveGoal = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        clearActiveGoal();
        setComposerRunMode('normal');
        return;
      }
      setConversationGoals((previous) => {
        const goal = previous[activeConvId];
        if (!goal) return previous;
        return { ...previous, [activeConvId]: { ...goal, text: trimmed } };
      });
    },
    [activeConvId, clearActiveGoal],
  );

  const deleteActiveGoal = useCallback(() => {
    clearActiveGoal();
    setComposerRunMode('normal');
    if (wb.status === 'running') wb.abort();
  }, [clearActiveGoal, wb]);

  const pauseActiveGoal = useCallback(() => {
    setConversationGoals((previous) => {
      const goal = previous[activeConvId];
      if (!goal) return previous;
      return { ...previous, [activeConvId]: { ...goal, status: 'paused' } };
    });
    // Pausing a goal only disables the next goal-driven continuation; it must
    // not abort the run that is already streaming.
    setComposerRunMode('normal');
  }, [activeConvId]);

  const resumeActiveGoal = useCallback(() => {
    setConversationGoals((previous) => {
      const goal = previous[activeConvId];
      if (!goal) return previous;
      return { ...previous, [activeConvId]: { ...goal, status: 'active' } };
    });
    setComposerRunMode('goal');
  }, [activeConvId]);

  // Home = nothing in flight and no committed messages. The composer lives
  // centered under the wordmark; once a turn starts it docks toward the bottom.
  const isHome = wb.messages.length === 0 && !wb.live && !wb.activeTool && wb.status !== 'running';
  const handleSend = useCallback(
    (text: string, options?: ChatSendOptions) => {
      const selectedSkill = composerSkillId ? resources.skills.find((skill) => skill.id === composerSkillId) : undefined;
      const sendOptions: ChatSendOptions = {
        runMode: composerRunMode,
        ...(selectedSkill ? { skillId: selectedSkill.id, skillLabel: selectedSkill.label } : {}),
        ...options,
      };
      if (sendOptions.runMode === 'goal' && text.trim()) {
        setConversationGoals((previous) => {
          const existing = previous[activeConvId];
          if (existing?.text.trim()) {
            return { ...previous, [activeConvId]: { ...existing, status: 'active' } };
          }
          return {
            ...previous,
            [activeConvId]: {
              text: text.trim(),
              status: 'active',
              startedAt: Date.now(),
            },
          };
        });
      }
      setCollapsed(false);
      setMobileSidebarOpen(false);
      // Keep the local list and the server thread aligned before the run starts.
      conversations.ensure(activeConvId, conversationContext.avatarId, conversationContext.projectId);
      conversations.touch(activeConvId, text);
      void ensureActiveServerConversation(text)
        .then(() => wb.send(text, sendOptions))
        .catch((error) => {
          // A failure here (e.g. /api/chat/conversation rejecting) means wb.send
          // never runs, so the view silently stays on home. Surface it instead.
          toast.error(error instanceof Error ? error.message : t('chat.sendFailed', { defaultValue: '发送失败，请重试' }));
        });
    },
    [wb, conversations, activeConvId, conversationContext, composerRunMode, composerSkillId, resources.skills, ensureActiveServerConversation],
  );

  // Persist the active conversation's full state (transcript + workspace-console panes) for
  // reload survival. Background switch survival is handled by the runtime
  // registry — switching away never aborts the stream.
  const { saveSnapshot } = conversations;
  useEffect(() => {
    saveSnapshot(activeConvId, { messages: wb.messages, workspaces: wb.workspaces });
  }, [wb.messages, wb.workspaces, activeConvId, saveSnapshot]);

  const openSpace = useCallback(
    (id: string) => {
      setWorkspaceFilesOpen(false);
      setCollapsed(false);
      wb.selectWorkspace(id);
    },
    [wb],
  );

  const handleAgentChange = useCallback(
    (avatarId: string) => {
      setActiveAvatarId(avatarId);
      if (conversations.conversations.some((conversation) => conversation.id === activeConvId)) {
        conversations.updateContext(activeConvId, { agentId: avatarId });
        void ensureServerConversation({
          conversationId: activeConvId,
          avatarId,
          projectId: conversationContext.projectId,
          title: activeConv?.title,
        })
          .then((record) => {
            conversations.updateContext(activeConvId, {
              agentId: record.avatarId ?? avatarId,
              projectId: record.projectId ?? null,
              workspaceRoot: record.workspaceRoot,
              workspaceKind: record.workspaceKind,
            });
          })
          .catch(() => undefined);
      }
      setSpacesRefreshKey((value) => value + 1);
    },
    [activeConv?.title, activeConvId, conversationContext.projectId, conversations],
  );

  const handleProjectChange = useCallback(
    (projectId: string | undefined) => {
      resetWorkspaceFilesPanel();
      setSelectedProjectId(projectId);
      if (conversations.conversations.some((conversation) => conversation.id === activeConvId)) {
        conversations.updateContext(activeConvId, { projectId: projectId ?? null });
        void ensureServerConversation({
          conversationId: activeConvId,
          avatarId: conversationContext.avatarId,
          projectId,
          title: activeConv?.title,
        })
          .then((record) => {
            conversations.updateContext(activeConvId, {
              agentId: record.avatarId ?? conversationContext.avatarId,
              projectId: record.projectId ?? null,
              workspaceRoot: record.workspaceRoot,
              workspaceKind: record.workspaceKind,
            });
          })
          .catch(() => undefined);
      }
    },
    [activeConv?.title, activeConvId, conversationContext.avatarId, conversations, resetWorkspaceFilesPanel],
  );

  const handleNewChat = useCallback(() => {
    resetWorkspaceFilesPanel();
    // A fresh id = a new runtime; any prior conversation keeps streaming in the
    // background (NOT aborted).
    const id = newConversationId();
    setActiveConvId(id);
    setHistoryHasMore(false);
    setHistoryLoading(false);
    setSelectedProjectId(undefined);
    setComposerRunMode('normal');
    setComposerSkillId(undefined);
    setConsoleActivated(false);
    setCollapsed(true);
    setMobileSidebarOpen(false);
    setView('chat');
    setEditing(null);
  }, [resetWorkspaceFilesPanel]);

  const handleNewProjectChat = useCallback((projectId: string) => {
    resetWorkspaceFilesPanel();
    const id = newConversationId();
    setActiveConvId(id);
    setHistoryHasMore(false);
    setHistoryLoading(false);
    setSelectedProjectId(projectId);
    setComposerRunMode('normal');
    setComposerSkillId(undefined);
    setConsoleActivated(false);
    setCollapsed(true);
    setMobileSidebarOpen(false);
    setView('chat');
    setEditing(null);
  }, [resetWorkspaceFilesPanel]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      resetWorkspaceFilesPanel();
      const conv = conversations.conversations.find((conversation) => conversation.id === id);
      if (conv) {
        setHistoryLoading(false);
        setActiveAvatarId(conv.agentId);
        setSelectedProjectId(conv.projectId);
        let snapshot = conversations.loadSnapshot(id);
        let replaceSnapshot = false;
        let hasMore = false;
        try {
          const persisted = await loadConversationSnapshot(id, conv.agentId, { source: conv.source });
          if (persisted.workspaceRoot || persisted.workspaceKind || persisted.projectId !== undefined) {
            conversations.updateContext(id, {
              projectId: persisted.projectId ?? null,
              workspaceRoot: persisted.workspaceRoot,
              workspaceKind: persisted.workspaceKind,
            });
            setSelectedProjectId(persisted.projectId);
          }
          if (persisted.messages.length > 0 || persisted.workspaces.length > 0) {
            snapshot = persisted;
            replaceSnapshot = true;
            conversations.saveSnapshot(id, persisted);
          }
          hasMore = persisted.hasMore;
        } catch {
          // Fall back to the local snapshot; brand-new local conversations may not be persisted yet.
        }
        setHistoryHasMore(hasMore);
        // Hydrate from the saved snapshot — a no-op if the runtime is already
        // running or populated this session (so we never clobber a live stream).
        const runtime = getConversationRuntime(id, engine, { avatarId: conv.agentId, projectId: conv.projectId, modelId: selectedModelId, permissionMode });
        runtime.hydrate(snapshot.messages, snapshot.workspaces, { replace: replaceSnapshot });
        setConsoleActivated(runtime.getSnapshot().workspaces.length > 0);
      }
      setActiveConvId(id);
      setComposerRunMode(conversationGoals[id]?.status === 'active' ? 'goal' : 'normal');
      setComposerSkillId(undefined);
      setCollapsed(true);
      setMobileSidebarOpen(false);
      setView('chat');
      setEditing(null);
    },
    [conversations, conversationGoals, permissionMode, resetWorkspaceFilesPanel, selectedModelId],
  );

  const loadOlderMessages = useCallback(async () => {
    if (historyLoading || !historyHasMore) return;
    const before = wb.messages.find((message) => (message.role === 'user' || message.role === 'assistant') && message.entryId)?.entryId;
    if (!before) {
      setHistoryHasMore(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const avatarId = activeConv?.agentId ?? activeAvatarId;
      const page = await loadConversationSnapshot(activeConvId, avatarId, { before, source: activeConv?.source });
      const seenEntryIds = new Set(wb.messages.flatMap((message) => (message.entryId ? [message.entryId] : [])));
      const seenLocalIds = new Set(wb.messages.map((message) => message.id));
      const olderMessages = page.messages.filter((message) =>
        message.entryId ? !seenEntryIds.has(message.entryId) : !seenLocalIds.has(message.id),
      );
      if (olderMessages.length > 0) {
        const nextMessages = [...olderMessages, ...wb.messages];
        wb.hydrate(nextMessages, wb.workspaces, { replace: true });
        conversations.saveSnapshot(activeConvId, { messages: nextMessages, workspaces: wb.workspaces });
      }
      setHistoryHasMore(page.hasMore && page.messages.length > 0);
    } catch (error) {
      // Keep the current page intact, but surface the failure so the click/scroll
      // doesn't appear to silently do nothing — the user can retry.
      toast.error(error instanceof Error ? error.message : t('chat.loadEarlierFailed', { defaultValue: '加载更早消息失败' }));
    } finally {
      setHistoryLoading(false);
    }
  }, [
    activeAvatarId,
    activeConv?.agentId,
    activeConv?.source,
    activeConvId,
    conversations,
    historyHasMore,
    historyLoading,
    wb,
  ]);

  const handleDeleteConversation = useCallback(
    (id: string) => {
      const conv = conversations.conversations.find((conversation) => conversation.id === id);
      conversations.remove(id);
      void deleteServerConversation({ conversationId: id, source: conv?.source, avatarId: conv?.agentId })
        .then(() => conversations.refresh())
        .catch(() => {
          void conversations.refresh().catch(() => undefined);
          toast.error(t('chat.deleteFailed'));
        });
      dropConversationRuntime(id);
      setConversationGoals((previous) => {
        if (!previous[id]) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
      if (id === activeConvId) {
        resetWorkspaceFilesPanel();
        setActiveConvId(newConversationId());
        setHistoryHasMore(false);
        setHistoryLoading(false);
        setComposerRunMode('normal');
        setComposerSkillId(undefined);
        setConsoleActivated(false);
        setView('chat');
      }
    },
    [conversations, activeConvId, resetWorkspaceFilesPanel, t],
  );

  const handleArchiveConversation = useCallback(
    (id: string) => {
      conversations.archive(id);
      if (id === activeConvId) {
        resetWorkspaceFilesPanel();
        setActiveConvId(newConversationId());
        setHistoryHasMore(false);
        setHistoryLoading(false);
        setComposerRunMode('normal');
        setComposerSkillId(undefined);
        setConsoleActivated(false);
        setView('chat');
      }
    },
    [conversations, activeConvId, resetWorkspaceFilesPanel],
  );

  const handleUnarchiveConversation = useCallback(
    (id: string) => {
      conversations.unarchive(id);
    },
    [conversations],
  );

  const handleAvatarSelected = useCallback((avatarId: string) => {
    resetWorkspaceFilesPanel();
    setActiveAvatarId(avatarId);
    setActiveConvId(newConversationId());
    setHistoryHasMore(false);
    setHistoryLoading(false);
    setComposerRunMode('normal');
    setComposerSkillId(undefined);
    setConversationGoals({});
    setConsoleActivated(false);
    setCollapsed(true);
    setMobileSidebarOpen(false);
    setSpacesRefreshKey((value) => value + 1);
    setEditing(null);
    setView('chat');
  }, [resetWorkspaceFilesPanel]);

  const handleNavigate = useCallback((next: MainView) => {
    setView(next);
    if (next !== 'chat' && next !== 'settings') setResourceBackView('chat');
    setEditing(null);
    setMobileSidebarOpen(false);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setView('settings');
    setResourceBackView('settings');
    setEditing(null);
    setMobileSidebarOpen(false);
  }, []);

  const handleSettingsNavigate = useCallback((next: PageKey) => {
    setView(next);
    setResourceBackView('settings');
    setEditing(null);
    setMobileSidebarOpen(false);
  }, []);

  const handleEdit = useCallback((kind: EditKind, id: string) => {
    // Edit pages replace the main area; leave resource pages so back returns to chat.
    setView('chat');
    setEditing({ kind, id });
    setMobileSidebarOpen(false);
  }, []);

  const handleEditBack = useCallback(() => {
    setEditing(null);
    setView('chat');
  }, []);

  const handleOpenToolPageFromEdit = useCallback(() => {
    setEditing(null);
    setView('tool');
    setResourceBackView('chat');
    setMobileSidebarOpen(false);
  }, []);

  const refreshResources = useCallback(() => {
    void resources.reload();
    setSpacesRefreshKey((value) => value + 1);
  }, [resources]);

  const handleProjectCreated = useCallback(
    (projectId: string) => {
      resetWorkspaceFilesPanel();
      setSelectedProjectId(projectId);
      if (conversations.conversations.some((conversation) => conversation.id === activeConvId)) {
        conversations.updateContext(activeConvId, { projectId });
      }
      void resources.reload();
      setSpacesRefreshKey((value) => value + 1);
    },
    [activeConvId, conversations, resetWorkspaceFilesPanel, resources],
  );

  const handleProjectDialogSaved = useCallback(
    (project: { id: string; name: string }) => {
      handleProjectCreated(project.id);
    },
    [handleProjectCreated],
  );

  const handleClearRecords = useCallback(async () => {
    const result = (await deleteJson('/api/conversations/clear')) as {
      removedCount?: number;
      history?: { removedCount?: number };
      database?: { enabled?: boolean; tablesCleared?: number };
    };
    clearClientFactoryState();
    conversations.clearAll();
    dropAllConversationRuntimes();
    setActiveConvId(newConversationId());
    setSelectedProjectId(undefined);
    setSelectedModelId(undefined);
    setPermissionModeState(DEFAULT_PERMISSION_MODE);
    setComposerRunMode('normal');
    setComposerSkillId(undefined);
    setConversationGoals({});
    setDismissedPlanReplyIds(new Set());
    resetWorkspaceFilesPanel();
    setConsoleActivated(false);
    setCollapsed(true);
    setMobileSidebarOpen(false);
    setEditing(null);
    await resources.reload();
    setSpacesRefreshKey((value) => value + 1);
    return result;
  }, [conversations, resetWorkspaceFilesPanel, resources]);

  // 仅保留 ⌘K（搜索面板，在 Sidebar 内绑定）。⌘N / ⌘, / ⌘1-9 等与浏览器系统级快捷键冲突，
  // web 端 preventDefault 无法可靠拦截，故不绑定、也不在 UI 上提示。

  const activePageKey = view !== 'chat' && view !== 'settings' ? view : null;
  const ActivePage = activePageKey ? RESOURCE_PAGES[activePageKey] : null;
  const ActiveEdit = editing ? EDIT_PAGES[editing.kind] : null;
  const createTaskConversation = useCallback((title: string, projectId?: string) => {
    const id = newConversationId();
    conversations.ensure(id, activeAvatarId, projectId);
    conversations.rename(id, title.trim() || 'Task');
    void ensureServerConversation({ conversationId: id, avatarId: activeAvatarId, projectId, title: title.trim() || 'Task' })
      .then((record) => {
        conversations.updateContext(id, {
          agentId: record.avatarId ?? activeAvatarId,
          projectId: record.projectId ?? null,
          workspaceRoot: record.workspaceRoot,
          workspaceKind: record.workspaceKind,
        });
      })
      .catch(() => undefined);
    return id;
  }, [activeAvatarId, conversations]);
  const openTaskConversation = useCallback(async (input: { conversationId: string; title: string; prompt?: string; avatarId?: string; projectId?: string }) => {
    resetWorkspaceFilesPanel();
    const avatarId = input.avatarId ?? activeAvatarId;
    conversations.ensure(input.conversationId, avatarId, input.projectId);
    conversations.rename(input.conversationId, input.title);
    const record = await ensureServerConversation({
      conversationId: input.conversationId,
      avatarId,
      projectId: input.projectId,
      title: input.title,
    }).catch(() => undefined);
    if (record) {
      conversations.updateContext(input.conversationId, {
        agentId: record.avatarId ?? avatarId,
        projectId: record.projectId ?? input.projectId ?? null,
        workspaceRoot: record.workspaceRoot,
        workspaceKind: record.workspaceKind,
      });
      void conversations.refresh().catch(() => undefined);
    }
    if (input.projectId !== undefined || input.avatarId !== undefined) {
      conversations.updateContext(input.conversationId, { agentId: avatarId, projectId: input.projectId });
    }
    setActiveAvatarId(avatarId);
    setSelectedProjectId(input.projectId);
    const snapshot = await loadConversationSnapshot(input.conversationId, avatarId).catch(() => ({
      ...conversations.loadSnapshot(input.conversationId),
      hasMore: false,
    }));
    if ('workspaceRoot' in snapshot || 'workspaceKind' in snapshot || 'projectId' in snapshot) {
      conversations.updateContext(input.conversationId, {
        projectId: snapshot.projectId ?? input.projectId ?? null,
        workspaceRoot: snapshot.workspaceRoot,
        workspaceKind: snapshot.workspaceKind,
      });
    }
    if (snapshot.messages.length === 0 && input.prompt?.trim()) {
      snapshot.messages = [{ id: 1, role: 'user', text: input.prompt.trim(), ts: Date.now() }];
    }
    if (snapshot.messages.length > 0 || snapshot.workspaces.length > 0) {
      conversations.saveSnapshot(input.conversationId, snapshot);
    }
    const runtime = getConversationRuntime(input.conversationId, engine, {
      avatarId,
      projectId: input.projectId,
      modelId: selectedModelId,
      permissionMode,
    });
    runtime.hydrate(snapshot.messages, snapshot.workspaces, { replace: snapshot.messages.length > 0 || snapshot.workspaces.length > 0 });
    setConsoleActivated(runtime.getSnapshot().workspaces.length > 0);
    setActiveConvId(input.conversationId);
    setHistoryHasMore(snapshot.hasMore);
    setHistoryLoading(false);
    setComposerRunMode(conversationGoals[input.conversationId]?.status === 'active' ? 'goal' : 'normal');
    setComposerSkillId(undefined);
    setCollapsed(true);
    setMobileSidebarOpen(false);
    setView('chat');
    setEditing(null);
  }, [activeAvatarId, conversations, conversationGoals, permissionMode, resetWorkspaceFilesPanel, selectedModelId]);

  const workspacePanelEl = (presentation: 'inline' | 'overlay') => (
    <WorkspacePanel
      presentation={presentation}
      filesActive={filesPanelOpen}
      onSelectFiles={openWorkspaceFiles}
      onSelectWorkspace={selectWorkspaceTab}
      onCollapse={collapseRightPanel}
      conversationId={activeConvId}
      conversationTitle={activeConv?.title}
      projectId={conversationContext.projectId}
      projects={resources.projects}
      fileTarget={workspaceFileTarget}
      filesRefreshToken={workspaceFilesRefreshToken}
      spaces={spaces}
      workspaces={wb.workspaces}
      activeWorkspaceId={wb.activeWorkspaceId}
      status={wb.status}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-foreground">
      <OnboardingRedirect />
      <div className="hidden h-full md:block">
        <Sidebar
          model={MODEL_LABEL}
          resources={resources}
          activeAvatarId={activeAvatarId}
          activeView={view}
          onAvatarSelected={handleAvatarSelected}
          onNavigate={handleNavigate}
          onEdit={handleEdit}
          activeEdit={editing}
          onNewChat={handleNewChat}
          onNewProjectChat={handleNewProjectChat}
          onOpenSettings={handleOpenSettings}
          conversations={conversations.conversations}
          archivedConversations={conversations.archivedConversations}
          activeConversationId={activeConvId}
          runningConversationIds={runningConversationIds}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onArchiveConversation={handleArchiveConversation}
          onUnarchiveConversation={handleUnarchiveConversation}
          onRenameConversation={conversations.rename}
          onCreateProject={() => setProjectDialogOpen(true)}
          onResourcesChanged={() => setSpacesRefreshKey((value) => value + 1)}
          onEntityDeleted={(kind, id) => {
            if (editing?.kind === kind && editing.id === id) handleEditBack();
          }}
        />
      </div>

      <AnimatePresence>
        {mobileSidebarOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/35 backdrop-blur-xs"
              onClick={() => setMobileSidebarOpen(false)}
            />
            <motion.div
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={SPRING_PANEL}
              className="absolute inset-y-0 left-0 w-72 overflow-hidden border-r border-border bg-card shadow-lg"
            >
              <Sidebar
                model={MODEL_LABEL}
                resources={resources}
                activeAvatarId={activeAvatarId}
                activeView={view}
                onAvatarSelected={handleAvatarSelected}
                onNavigate={handleNavigate}
                onEdit={handleEdit}
                activeEdit={editing}
                onNewChat={handleNewChat}
                onNewProjectChat={handleNewProjectChat}
                onOpenSettings={handleOpenSettings}
                conversations={conversations.conversations}
                archivedConversations={conversations.archivedConversations}
                activeConversationId={activeConvId}
                runningConversationIds={runningConversationIds}
                onSelectConversation={handleSelectConversation}
                onDeleteConversation={handleDeleteConversation}
                onArchiveConversation={handleArchiveConversation}
                onUnarchiveConversation={handleUnarchiveConversation}
                onRenameConversation={conversations.rename}
                onCreateProject={() => setProjectDialogOpen(true)}
                onResourcesChanged={() => setSpacesRefreshKey((value) => value + 1)}
                onEntityDeleted={(kind, id) => {
                  if (editing?.kind === kind && editing.id === id) handleEditBack();
                }}
                forceExpanded
              />
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/85 px-3 backdrop-blur-sm md:hidden">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t('common.openSidebar')}
              title={t('common.openSidebar')}
            >
              <Menu className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-foreground">Zleap</span>
            <button
              type="button"
              onClick={openWorkspaceFiles}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t('workspace.open')}
              title={t('workspace.open')}
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
            {consoleActivated ? (
              <button
                type="button"
                onClick={() => {
                  setWorkspaceFilesOpen(false);
                  setCollapsed((value) => !value);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={t('common.toggleConsole')}
                title={t('common.toggleConsole')}
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          {ActiveEdit && editing ? (
            <div className="min-h-0 flex-1">
              <ActiveEdit
                id={editing.id}
                resources={resources}
                avatarId={activeAvatarId}
                onChanged={refreshResources}
                onBack={handleEditBack}
                onOpenToolPage={handleOpenToolPageFromEdit}
              />
            </div>
          ) : view === 'settings' ? (
            <div className="min-h-0 flex-1">
              <SettingsPage
                resources={resources}
                onBack={() => setView('chat')}
                onNavigate={handleSettingsNavigate}
                onClearRecords={handleClearRecords}
              />
            </div>
          ) : ActivePage ? (
            <div className="min-h-0 flex-1">
              <ActivePage
                resources={resources}
                avatarId={activeAvatarId}
                currentProjectId={conversationContext.projectId}
                conversations={conversations.conversations}
                onCreateTaskConversation={createTaskConversation}
                onOpenTaskConversation={openTaskConversation}
                onEdit={handleEdit}
                onChanged={refreshResources}
                onBack={() => setView(resourceBackView)}
              />
            </div>
          ) : isHome ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
              <div className="animate-msg-in w-full max-w-3xl">
                <Wordmark className="mb-8" />
                <Composer
                  status={wb.status}
                  onSend={handleSend}
                  onStop={wb.abort}
                  draftValue={composerDraft}
                  onDraftChange={updateComposerDraft}
                  variant="hero"
                  showContextPickers
                  agents={resources.avatars}
                  projects={resources.projects}
                  spaces={spaces}
                  models={chatModels}
                  skills={resources.skills}
                  agentId={conversationContext.avatarId}
                  projectId={conversationContext.projectId}
                  modelId={selectedModelId}
                  permissionMode={permissionMode}
                  contextSnapshot={wb.contextSnapshot}
                  contextCompaction={wb.contextCompaction}
                  runMode={composerRunMode}
                  selectedSkillId={composerSkillId}
                  goal={activeGoal}
                  projectPickerPlacement="below"
                  onAgentChange={handleAgentChange}
                  onProjectChange={handleProjectChange}
                  onProjectCreated={handleProjectCreated}
                  onCreateProject={() => setProjectDialogOpen(true)}
                  onModelChange={setSelectedModelId}
                  onPermissionModeChange={setPermissionMode}
                  onRunModeChange={handleComposerRunModeChange}
                  onSelectedSkillChange={setComposerSkillId}
                  onGoalChange={updateActiveGoal}
                  onGoalPause={pauseActiveGoal}
                  onGoalResume={resumeActiveGoal}
                  onGoalDelete={deleteActiveGoal}
                />
              </div>
            </div>
          ) : (
            <>
              <Conversation
                conversationId={activeConvId}
                messages={wb.messages}
                live={wb.live}
                activeTool={wb.activeTool}
                activeSpaceId={wb.activeWorkspaceId}
                workspaces={wb.workspaces}
                spaces={spaces}
                status={wb.status}
                hasOlderMessages={historyHasMore}
                loadingOlderMessages={historyLoading}
                onOpenSpace={openSpace}
                onLoadOlderMessages={loadOlderMessages}
                onOpenWorkspaceFile={openWorkspaceFile}
                onDeleteMessage={wb.deleteMessage}
                onResendMessage={wb.resendMessage}
              />

              {consoleActivated && collapsed ? (
                <div className="shrink-0 px-4 pb-1">
                  <CollapsedPill
                    spaces={spaces}
                    workspaces={wb.workspaces}
                    activeWorkspaceId={wb.activeWorkspaceId}
                    status={wb.status}
                    onExpand={() => {
                      setWorkspaceFilesOpen(false);
                      setCollapsed(false);
                    }}
                  />
                </div>
              ) : null}

              {wb.pendingApproval || wb.approvalNotice ? (
                <div className="shrink-0 px-4 pb-1">
                  <div className="mx-auto max-w-3xl">
                    <ConfirmCard
                      request={wb.pendingApproval ?? wb.approvalNotice!}
                      onApprove={() => wb.respondApproval(true)}
                      onDeny={() => wb.respondApproval(false)}
                      onDismiss={wb.dismissApprovalNotice}
                    />
                  </div>
                </div>
              ) : null}

              {wb.lastRunError ? (
                <div className="shrink-0 px-4 pb-1">
                  <RunRecovery status={wb.status} onRetry={wb.retryLast} onClear={handleNewChat} />
                </div>
              ) : null}

              <Composer
                status={wb.status}
                onSend={handleSend}
                onStop={wb.abort}
                draftValue={composerDraft}
                onDraftChange={updateComposerDraft}
                showContextPickers
                agents={resources.avatars}
                projects={resources.projects}
                spaces={spaces}
                models={chatModels}
                skills={resources.skills}
                agentId={conversationContext.avatarId}
                projectId={conversationContext.projectId}
                modelId={selectedModelId}
                permissionMode={permissionMode}
                contextSnapshot={wb.contextSnapshot}
                contextCompaction={wb.contextCompaction}
                runMode={composerRunMode}
                selectedSkillId={composerSkillId}
                goal={activeGoal}
                planReply={activePlanReply}
                projectPickerPlacement="none"
                onAgentChange={handleAgentChange}
                onProjectChange={handleProjectChange}
                onProjectCreated={handleProjectCreated}
                onCreateProject={() => setProjectDialogOpen(true)}
                onModelChange={setSelectedModelId}
                onPermissionModeChange={setPermissionMode}
                onRunModeChange={handleComposerRunModeChange}
                onSelectedSkillChange={setComposerSkillId}
                onGoalChange={updateActiveGoal}
                onGoalPause={pauseActiveGoal}
                onGoalResume={resumeActiveGoal}
                onGoalDelete={deleteActiveGoal}
                onDismissPlanReply={dismissPlanReply}
              />
            </>
          )}
        </main>

        <AnimatePresence>
          {rightPanelOpen ? (
            <>
              <motion.aside
                key="workspace-panel"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: workspaceDrawerWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={SPRING_PANEL}
                style={{ minWidth: 0 }}
                className="hidden shrink-0 overflow-hidden lg:block"
              >
                <div className="relative h-full min-w-[420px]">
                  <button
                    type="button"
                    onMouseDown={startWorkspaceDrawerResize}
                    className="absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-col-resize transition hover:bg-primary/25"
                    aria-label={t('workspace.resize')}
                    title={t('workspace.resize')}
                  />
                  <div className="h-full overflow-hidden border-l border-border bg-background">
                    {workspacePanelEl('inline')}
                  </div>
                </div>
              </motion.aside>
              <div className="fixed inset-0 z-40 lg:hidden">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-black/40 backdrop-blur-xs"
                  onClick={collapseRightPanel}
                />
                <motion.div
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={SPRING_PANEL}
                  className="absolute inset-y-0 right-0 w-full max-w-md overflow-hidden border-l border-border bg-background shadow-lg"
                >
                  {workspacePanelEl('overlay')}
                </motion.div>
              </div>
            </>
          ) : null}
        </AnimatePresence>
      </div>

      {view === 'chat' && !editing && !rightPanelOpen ? (
        <button
          type="button"
          onClick={openWorkspaceFiles}
          className="fixed right-2.5 top-1 z-50 hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground md:flex"
          aria-label={t('workspace.expand')}
          title={t('workspace.expand')}
        >
          <PanelRight className="h-4 w-4" />
        </button>
      ) : null}
      <ProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} onSaved={handleProjectDialogSaved} />
    </div>
  );
}

function clearClientFactoryState(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith('zleap-')) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
    }
    window.sessionStorage.clear();
  } catch {
    /* best-effort: server-side reset already completed. */
  }
}

function defaultSidePanelWidth(): number {
  if (typeof window === 'undefined') return 560;
  return clampSidePanelWidth(Math.min(window.innerWidth * 0.42, 720));
}

function clampSidePanelWidth(width: number): number {
  if (typeof window === 'undefined') return Math.max(420, Math.min(820, width));
  const max = Math.max(420, Math.min(1100, window.innerWidth - 360));
  return Math.max(420, Math.min(max, Math.round(width)));
}

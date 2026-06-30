'use client';

import { useSyncExternalStore } from 'react';
import type { ChatTurn, ContextSnapshot, Engine } from './engine';
import { spaceMeta, type SpaceItem } from './spaces';
import type { PermissionMode } from './permissions';
import { bypassesToolApproval, DEFAULT_PERMISSION_MODE } from './permissions';
import { artifactFromToolResult, artifactsFromExitWorkspace, artifactsFromReferences, dedupeArtifactViews, upsertArtifactView } from './workspaceArtifacts';
import type { ChatSendOptions } from './runModes';
import { appendNormalizedDisplayMessage, normalizeDisplayMessages } from './displayMessages';
import { deleteJson } from './api';
import { normalizeAssistantDisplayText, sanitizeDisplayText } from './messageText';
import { requestToDisplayAttachments } from './chatAttachments';
import type {
  ArtifactView,
  DisplayMessage,
  Envelope,
  RunStatus,
  ToolApprovalRequest,
  ToolCallView,
  WorkPane,
} from './types';

const MAIN_PANE_ID = 'main';
const MAIN_SPACE_ID = 'main';

/**
 * The streaming runtime for ONE conversation — a plain object, NOT a hook, so it
 * lives in a module registry independent of any React component's lifecycle.
 *
 * Why: switching conversations in the UI must not abort an in-flight generation.
 * Each conversation owns its own runtime; the stream loop writes into that
 * runtime's state and keeps going when the user views another conversation.
 * Components subscribe to the active runtime via `useSyncExternalStore`; the only
 * things that abort a stream are explicit user actions (stop / delete), never a
 * view switch. (See docs research: AI chat "background generation" pattern —
 * keep streaming state out of component state.)
 */
export type WorkbenchSnapshot = {
  messages: DisplayMessage[];
  status: RunStatus;
  live: string;
  activeTool: ToolCallView | null;
  workspaces: WorkPane[];
  activeWorkspaceId: string | null;
  pendingApproval: ToolApprovalRequest | null;
  approvalNotice: ToolApprovalRequest | null;
  queuedInputCount: number;
  lastRunError: boolean;
  /** Latest MAIN context-window snapshot for the inspector (null until first turn). */
  contextSnapshot: ContextSnapshot | null;
  contextCompaction: ContextCompactionState;
};

export type ContextCompactionState = {
  status: 'idle' | 'running' | 'retrying' | 'failed';
  spaceId?: string;
  attempt?: number;
  maxAttempts?: number;
  message?: string;
};

const EMPTY: WorkbenchSnapshot = {
  messages: [],
  status: 'idle',
  live: '',
  activeTool: null,
  workspaces: [],
  activeWorkspaceId: null,
  pendingApproval: null,
  approvalNotice: null,
  queuedInputCount: 0,
  lastRunError: false,
  contextSnapshot: null,
  contextCompaction: { status: 'idle' },
};
const APPROVAL_CLIENT_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_NOTICE_TTL_MS = 8_000;

type QueuedInput = {
  text: string;
  options?: ChatSendOptions;
  resolve: () => void;
  reject: (error: unknown) => void;
};

class ConversationRuntime {
  readonly conversationId: string;
  private readonly engine: Engine;
  private avatarId?: string;
  private projectId?: string;
  private modelId?: string;
  private permissionMode?: PermissionMode;
  /** Kept fresh by the hook so pane labels resolve against current spaces. */
  spaces: SpaceItem[] = [];

  // ── live state (mirrored into an immutable snapshot for useSyncExternalStore) ──
  private messages: DisplayMessage[] = [];
  private status: RunStatus = 'idle';
  private live = '';
  private activeTool: ToolCallView | null = null;
  private workspaces: WorkPane[] = [];
  private activeWorkspaceId: string | null = null;
  private pendingApproval: ToolApprovalRequest | null = null;
  private approvalNotice: ToolApprovalRequest | null = null;
  private lastRunError = false;
  private contextSnapshot: ContextSnapshot | null = null;
  private contextCompaction: ContextCompactionState = { status: 'idle' };
  private workspaceRoot: string | undefined;

  // ── internals ──
  private idCounter = 1;
  private controller: AbortController | null = null;
  private approvalResolve: ((approved: boolean) => void) | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSpace: string | null = null;
  private runSeq = 0;
  private queuedInputs: QueuedInput[] = [];

  private snap: WorkbenchSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(conversationId: string, engine: Engine, avatarId?: string, projectId?: string, modelId?: string, permissionMode?: PermissionMode) {
    this.conversationId = conversationId;
    this.engine = engine;
    this.avatarId = avatarId;
    this.projectId = projectId;
    this.modelId = modelId;
    this.permissionMode = permissionMode;
    this.rebuild();
  }

  /** Sync thread context; permission mode applies immediately (including mid-run). */
  bindContext(avatarId?: string, projectId?: string, modelId?: string, permissionMode?: PermissionMode): void {
    if (avatarId !== undefined && this.status !== 'running') {
      this.avatarId = avatarId;
    }
    if (this.status !== 'running') {
      this.projectId = projectId || undefined;
    }
    if (modelId !== undefined) this.modelId = modelId || undefined;
    if (permissionMode !== undefined) {
      const prev = this.permissionMode;
      this.permissionMode = permissionMode;
      if (permissionMode !== prev && bypassesToolApproval(permissionMode) && this.pendingApproval) {
        this.respondApproval(true);
      }
    }
  }

  // ── store interface (stable refs so useSyncExternalStore is happy) ──
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): WorkbenchSnapshot => this.snap;

  private rebuild(): void {
    this.snap = {
      messages: this.messages,
      status: this.status,
      live: this.live,
      activeTool: this.activeTool,
      workspaces: this.workspaces,
      activeWorkspaceId: this.activeWorkspaceId,
      pendingApproval: this.pendingApproval,
      approvalNotice: this.approvalNotice,
      queuedInputCount: this.queuedInputs.length,
      lastRunError: this.lastRunError,
      contextSnapshot: this.contextSnapshot,
      contextCompaction: this.contextCompaction,
    };
  }
  private emit(): void {
    this.rebuild();
    for (const listener of this.listeners) listener();
    emitRegistry();
  }

  /** Hydrate a not-yet-run conversation from its saved snapshot (transcript + panes). */
  hydrate(messages: DisplayMessage[], workspaces: WorkPane[], options: { replace?: boolean } = {}): void {
    if (this.status === 'running') return;
    if (this.messages.length > 0 && !options.replace) return;
    this.messages = normalizeDisplayMessages(messages);
    this.workspaces = normalizeFinishedPanes(workspaces);
    this.activeWorkspaceId = workspaces[0]?.id ?? null;
    this.idCounter = messages.reduce((max, message) => Math.max(max, message.id + 1), 1);
    this.emit();
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  // ── actions ──
  selectWorkspace = (id: string): void => {
    this.activeWorkspaceId = id;
    this.emit();
  };

  respondApproval = (approved: boolean): void => {
    const resolve = this.approvalResolve;
    const request = this.pendingApproval;
    this.clearApprovalTimer();
    this.approvalResolve = null;
    this.pendingApproval = null;
    this.setApprovalNotice(request ? { ...request, status: approved ? 'approved' : 'rejected' } : null);
    this.emit();
    resolve?.(approved);
  };

  dismissApprovalNotice = (): void => {
    this.setApprovalNotice(null);
    this.emit();
  };

  abort = (): void => {
    this.approvalResolve?.(false);
    this.clearApprovalTimer();
    this.clearApprovalNoticeTimer();
    this.approvalResolve = null;
    this.pendingApproval = null;
    this.approvalNotice = null;
    this.resolveQueuedInputs();
    this.controller?.abort();
    this.emit();
  };

  send = (text: string, options?: ChatSendOptions): Promise<void> => {
    if (!this.controller) {
      return this.run(text, true, options);
    }
    return new Promise<void>((resolve, reject) => {
      this.queuedInputs = [...this.queuedInputs, { text, options, resolve, reject }];
      this.emit();
    });
  };

  retryLast = async (): Promise<void> => {
    if (this.controller) return;
    const lastUser = [...this.messages].reverse().find((message) => message.role === 'user' && message.text?.trim());
    if (!lastUser?.text) return;
    const lastUserIndex = this.messages.findIndex((message) => message.id === lastUser.id);
    if (lastUserIndex >= 0) {
      this.messages = this.messages.slice(0, lastUserIndex + 1);
      this.emit();
    }
    await this.run(lastUser.text, false);
  };

  deleteMessage = async (id: number): Promise<void> => {
    if (this.controller) return;
    const message = this.messages.find((item) => item.id === id);
    if (!message) return;
    if (message.entryId) {
      try {
        await this.deleteDurableEntries([message.entryId]);
      } catch {
        return;
      }
    }
    const next = this.messages.filter((message) => message.id !== id);
    if (next.length === this.messages.length) return;
    this.messages = next;
    this.emit();
  };

  resendMessage = async (id: number): Promise<void> => {
    if (this.controller) return;
    const index = this.messages.findIndex((message) => message.id === id && message.role === 'user' && message.text?.trim());
    const message = index >= 0 ? this.messages[index] : undefined;
    const text = message?.text?.trim();
    if (!text) return;
    const deletedEntryIds = this.messages.slice(index + 1).flatMap((item) => (item.entryId ? [item.entryId] : []));
    if (deletedEntryIds.length) {
      try {
        await this.deleteDurableEntries(deletedEntryIds);
      } catch {
        return;
      }
    }
    this.messages = this.messages.slice(0, index + 1);
    this.emit();
    await this.run(text, false);
  };

  private async deleteDurableEntries(entryIds: string[]): Promise<void> {
    if (!entryIds.length) return;
    await deleteJson('/api/chat/conversation', {
      conversationId: this.conversationId,
      avatarId: this.avatarId,
      entryIds,
    });
  }

  private commit(message: Omit<DisplayMessage, 'id'>): DisplayMessage {
    const nextMessage = { id: this.idCounter++, ts: Date.now(), ...message };
    this.messages = appendNormalizedDisplayMessage(this.messages, nextMessage);
    this.emit();
    return this.messages.find((item) => item.id === nextMessage.id) ?? this.messages.at(-1) ?? nextMessage;
  }

  private hasPendingSpaceMessage(spaceId: string, paneId: string): boolean {
    return this.messages.some(
      (message) => message.role === 'space' && message.space?.spaceId === spaceId && message.space.id === paneId && !message.envelope,
    );
  }

  private setPanes(next: WorkPane[]): void {
    this.workspaces = next;
    this.emit();
  }

  private confirm = (request: ToolApprovalRequest): Promise<boolean> => {
    if (bypassesToolApproval(this.permissionMode ?? DEFAULT_PERMISSION_MODE)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.clearApprovalTimer();
      this.pendingApproval = { ...request, status: 'waiting' };
      this.setApprovalNotice(null);
      this.approvalResolve = resolve;
      this.approvalTimer = setTimeout(() => {
        if (this.pendingApproval?.approvalId !== request.approvalId) return;
        this.pendingApproval = null;
        this.approvalResolve = null;
        this.setApprovalNotice({ ...request, status: 'timeout' });
        this.emit();
        resolve(false);
      }, APPROVAL_CLIENT_TIMEOUT_MS);
      this.emit();
    });
  };

  private clearApprovalTimer(): void {
    if (!this.approvalTimer) return;
    clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  }

  private clearApprovalNoticeTimer(): void {
    if (!this.approvalNoticeTimer) return;
    clearTimeout(this.approvalNoticeTimer);
    this.approvalNoticeTimer = null;
  }

  private setApprovalNotice(notice: ToolApprovalRequest | null): void {
    this.clearApprovalNoticeTimer();
    this.approvalNotice = notice;
    if (!notice) return;
    this.approvalNoticeTimer = setTimeout(() => {
      if (this.approvalNotice?.approvalId !== notice.approvalId || this.approvalNotice.status !== notice.status) return;
      this.approvalNotice = null;
      this.approvalNoticeTimer = null;
      this.emit();
    }, APPROVAL_NOTICE_TTL_MS);
  }

  private async run(text: string, commitUser: boolean, options: ChatSendOptions = {}): Promise<void> {
    if (this.controller) return;

    const history: ChatTurn[] = this.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.text ?? '' }));
    let currentUserMessageId: number | undefined;
    const currentAssistantMessageIds: number[] = [];
    let pendingUserEntryId: string | undefined;
    let pendingAssistantEntryIds: string[] = [];
    const applyPendingEntryIds = () => {
      let changed = false;
      if (pendingUserEntryId && currentUserMessageId !== undefined) {
        this.messages = this.messages.map((message) => {
          if (message.id !== currentUserMessageId || message.entryId) return message;
          changed = true;
          return { ...message, entryId: pendingUserEntryId };
        });
        if (changed) {
          pendingUserEntryId = undefined;
        }
      }
      if (pendingAssistantEntryIds.length && currentAssistantMessageIds.length) {
        const remaining = [...pendingAssistantEntryIds];
        this.messages = this.messages.map((message) => {
          if (!currentAssistantMessageIds.includes(message.id) || message.entryId || remaining.length === 0) {
            return message;
          }
          changed = true;
          return { ...message, entryId: remaining.shift() };
        });
        pendingAssistantEntryIds = remaining;
      }
      if (changed) {
        this.emit();
      }
    };
    const receiveEntryIds = (input: { userEntryId?: string; assistantEntryIds: string[] }) => {
      if (input.userEntryId) {
        pendingUserEntryId = input.userEntryId;
      }
      if (input.assistantEntryIds.length) {
        pendingAssistantEntryIds = [...pendingAssistantEntryIds, ...input.assistantEntryIds];
      }
      applyPendingEntryIds();
    };
    const displayAttachments = requestToDisplayAttachments(options.attachments ?? []);
    if (commitUser) {
      history.push({ role: 'user', text });
      currentUserMessageId = this.commit({
        role: 'user',
        text,
        ...(displayAttachments.length ? { attachments: displayAttachments } : {}),
      }).id;
    }

    this.status = 'running';
    this.live = '';
    this.lastRunError = false;
    this.contextCompaction = { status: 'idle' };
    this.emit();

    const controller = new AbortController();
    this.controller = controller;
    const runSeq = ++this.runSeq;
    let acc = '';
    // The current work space's streamed prose, accumulated until a boundary (a
    // tool starts / the space returns), then committed as one console message.
    let spaceAcc = '';
    let runErrored = false;
    const flush = () => {
      const text = normalizeAssistantDisplayText(acc).trim();
      acc = '';
      this.live = '';
      if (text) {
        const message = this.commit({ role: 'assistant', text, ts: Date.now() });
        if (!currentAssistantMessageIds.includes(message.id)) {
          currentAssistantMessageIds.push(message.id);
        }
        applyPendingEntryIds();
      } else {
        this.emit();
      }
    };
    const flushSpaceText = () => {
      const text = normalizeAssistantDisplayText(spaceAcc).trim();
      spaceAcc = '';
      const id = this.activeSpace;
      if (!text || !id) return;
      this.setPanes(
        this.workspaces.map((pane) =>
          pane.id === id ? { ...pane, messages: [...(pane.messages ?? []), { text, after: pane.tools.length }] } : pane,
        ),
      );
    };

    // ── pane (调度台) mutators — Stage-Manager model: one pane per subspace ──
    const enterSpace = (spaceId: string, label: string, goal?: string): string => {
      const meta = spaceMeta(this.spaces, spaceId, label);
      const others = this.workspaces.filter((pane) => pane.spaceId !== spaceId);
      const existing = this.workspaces.find((pane) => pane.spaceId === spaceId);
      const fromPane = this.workspaces.find((pane) => pane.id === this.activeSpace && pane.spaceId !== spaceId);
      const context = fromPane
        ? { source: fromPane.label, detail: summarizePane(fromPane) }
        : existing?.context ?? { source: spaceMeta(this.spaces, 'session').label, detail: text };
      // The dispatched task streamed from the engine (`delta.goal`). It is THIS
      // dispatch's own objective — the real label to show, not the user's turn
      // message. Fall back to `text` only for the session pane (no goal handed down).
      const paneGoal = goal?.trim() || text;
      const pane: WorkPane = existing
        ? {
            ...existing,
            goal: paneGoal,
            context,
            startedAt: Date.now(),
            endedAt: undefined,
            status: 'running',
            statusLine: 'workspace 已进入,等待第一步',
            messages: [
              ...(existing.messages ?? []),
              {
                text: `重新进入 ${meta.label}\n\n任务：${paneGoal}`,
                after: existing.tools.length,
              },
            ],
            currentRunArtifactStart: existing.artifacts.length,
            envelope: undefined,
          }
        : {
            id: spaceId,
            spaceId,
            label: meta.label,
            goal: paneGoal,
            context,
            startedAt: Date.now(),
            budget: meta.budget,
            tools: [],
            messages: [],
            artifacts: [],
            currentRunArtifactStart: 0,
            statusLine: 'workspace 已进入,等待第一步',
            status: 'running',
          };
      this.workspaces = [pane, ...others];
      this.activeWorkspaceId = spaceId;
      this.activeSpace = spaceId;
      this.emit();
      return spaceId;
    };
    const recordMainDispatch = (spaceId: string, label: string, goal?: string) => {
      const now = Date.now();
      const targetMeta = spaceMeta(this.spaces, spaceId, label);
      const mainMeta = spaceMeta(this.spaces, MAIN_SPACE_ID, 'Main');
      const dispatchGoal = goal?.trim() || text;
      const tool: ToolCallView = {
        name: 'enterWorkspace',
        args: JSON.stringify({ space: spaceId, label: targetMeta.label, task: dispatchGoal }),
        result: `已进入 ${targetMeta.label}`,
        status: 'done',
      };
      const existing = this.workspaces.find((pane) => pane.id === MAIN_PANE_ID);
      const others = this.workspaces.filter((pane) => pane.id !== MAIN_PANE_ID);
      const pane: WorkPane = existing
        ? {
            ...existing,
            label: mainMeta.label,
            goal: '派发子空间',
            endedAt: now,
            status: 'done',
            statusLine: `已进入 ${targetMeta.label}`,
            tools: [...existing.tools, tool],
          }
        : {
            id: MAIN_PANE_ID,
            spaceId: MAIN_SPACE_ID,
            label: mainMeta.label,
            goal: '派发子空间',
            context: { source: mainMeta.label, detail: text },
            startedAt: now,
            endedAt: now,
            budget: mainMeta.budget,
            tools: [tool],
            messages: [],
            artifacts: [],
            statusLine: `已进入 ${targetMeta.label}`,
            status: 'done',
          };
      this.workspaces = [pane, ...others];
      this.emit();
    };
    const ensureMainPane = (): string => {
      const mainMeta = spaceMeta(this.spaces, MAIN_SPACE_ID, 'Main');
      const existing = this.workspaces.find((pane) => pane.id === MAIN_PANE_ID);
      if (existing) {
        this.workspaces = this.workspaces.map((pane) =>
          pane.id === MAIN_PANE_ID
            ? {
                ...pane,
                label: mainMeta.label,
                status: pane.status === 'running' ? pane.status : 'running',
                endedAt: undefined,
                statusLine: pane.statusLine ?? '主空间正在执行工具',
              }
            : pane,
        );
      } else {
        this.workspaces = [
          {
            id: MAIN_PANE_ID,
            spaceId: MAIN_SPACE_ID,
            label: mainMeta.label,
            goal: '主空间工具',
            context: { source: mainMeta.label, detail: text },
            startedAt: Date.now(),
            budget: mainMeta.budget,
            tools: [],
            messages: [],
            artifacts: [],
            statusLine: '主空间正在执行工具',
            status: 'running',
          },
          ...this.workspaces,
        ];
      }
      this.activeWorkspaceId = MAIN_PANE_ID;
      this.activeSpace = MAIN_PANE_ID;
      this.emit();
      return MAIN_PANE_ID;
    };
    const ensurePane = (): string => {
      if (!this.activeSpace) return ensureMainPane();
      return this.activeSpace as string;
    };
    const addRunningTool = (tool: ToolCallView) => {
      const id = ensurePane();
      this.setPanes(
        this.workspaces.map((pane) =>
          pane.id === id ? { ...pane, tools: [...pane.tools, tool], statusLine: `正在执行工具: ${tool.name}` } : pane,
        ),
      );
    };
    const finishTool = (name: string, result: string, toolStatus: ToolCallView['status'], toolCallId?: string) => {
      const id = this.activeSpace;
      if (!id) return;
      const displayResult = sanitizeDisplayText(result, toolStatus === 'error' ? 'Tool output is not displayable text.' : '');
      this.setPanes(
        this.workspaces.map((pane) => {
          if (pane.id !== id) return pane;
          const tools = [...pane.tools];
          let matched = false;
          if (toolCallId) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i]!.toolCallId === toolCallId) {
                tools[i] = { ...tools[i]!, result: displayResult, status: toolStatus };
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i]!.status === 'running' && tools[i]!.name === name) {
                tools[i] = { ...tools[i]!, result: displayResult, status: toolStatus };
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i]!.name === name) {
                tools[i] = { ...tools[i]!, result: displayResult, status: toolStatus };
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i]!.status === 'running') {
                tools[i] = { ...tools[i]!, result: displayResult, status: toolStatus };
                break;
              }
            }
          }
          return { ...pane, tools, statusLine: toolStatus === 'error' ? '工具执行失败,等待 workspace 收尾' : '工具已完成,等待 workspace 返回结果' };
        }),
      );
    };
    const updateSpaceStatus = (spaceId: string, message: string) => {
      const statusLine = sanitizeDisplayText(message, 'Workspace status updated.');
      this.setPanes(this.workspaces.map((pane) => (pane.spaceId === spaceId && pane.status === 'running' ? { ...pane, statusLine } : pane)));
    };
    const addArtifact = (artifact: ArtifactView) => {
      const id = this.activeSpace ?? 'session';
      this.setPanes(
        this.workspaces.map((pane) =>
          pane.id === id
            ? { ...pane, artifacts: upsertArtifactView(pane.artifacts, artifact, pane.currentRunArtifactStart ?? pane.artifacts.length) }
            : pane,
        ),
      );
    };
    const attachEnvelope = (spaceId: string, envelope: Envelope) => {
      const endedAt = Date.now();
      const displayEnvelope = sanitizeEnvelope(envelope);
      const paneId = resolveResultPaneId(this.workspaces, spaceId);
      const paneForResult = paneId ? this.workspaces.find((pane) => pane.id === paneId) : undefined;
      const artifactStart = paneForResult?.currentRunArtifactStart ?? 0;
      const referenceArtifacts = artifactsFromReferences(displayEnvelope.references, spaceId, () => this.idCounter++, this.workspaceRoot);
      const paneArtifacts = paneForResult
        ? referenceArtifacts.reduce((items, artifact) => upsertArtifactView(items, artifact, artifactStart), paneForResult.artifacts)
        : referenceArtifacts;
      const artifacts = paneArtifacts.slice(artifactStart);
      // Freeze this result onto its own breadcrumb card (the latest space card for
      // this space still awaiting a result), so each card keeps its own stats even
      // after the live pane is reset by a later dispatch to the same space.
      let tagged = false;
      this.messages = this.messages
        .slice()
        .reverse()
        .map((message) => {
          if (!tagged && message.role === 'space' && message.space?.spaceId === spaceId && !message.envelope) {
            tagged = true;
            return { ...message, envelope: displayEnvelope, artifacts };
          }
          return message;
        })
        .reverse();
      if (!paneId) {
        this.emit();
        return;
      }
      this.workspaces = this.workspaces.map((pane) =>
        pane.id === paneId
          ? {
              ...pane,
              envelope: displayEnvelope,
              status: envelope.status === 'failed' ? 'error' : 'done',
              statusLine: envelope.status === 'failed' ? 'workspace 失败' : 'workspace 已完成',
              endedAt,
              artifacts: paneArtifacts,
              tools: settleRunningTools(pane.tools, envelope.status === 'failed' ? 'error' : 'done', `Workspace finished: ${displayEnvelope.summary}`),
            }
          : pane,
      );
      this.emit();
    };

    try {
      for await (const delta of this.engine(history, controller.signal, {
        confirm: this.confirm,
        conversationId: this.conversationId,
        avatarId: this.avatarId,
        projectId: this.projectId,
        modelId: this.modelId,
        permissionMode: this.permissionMode,
        targetSpace: options.targetSpace,
        runMode: options.runMode,
        skillId: options.skillId,
        skillLabel: options.skillLabel,
        attachments: options.attachments,
      })) {
        if (runSeq !== this.runSeq) break;
        if (delta.type === 'delta') {
          acc += delta.text;
          this.live = normalizeAssistantDisplayText(acc);
          this.emit();
        } else if (delta.type === 'message_entries') {
          receiveEntryIds(delta);
        } else if (delta.type === 'context') {
          // Live context-window snapshot for the inspector — observational only.
          this.contextSnapshot = delta.snapshot;
          this.emit();
        } else if (delta.type === 'workspace_context') {
          this.workspaceRoot = delta.workspaceRoot;
        } else if (delta.type === 'context_compaction_start') {
          this.contextCompaction = {
            status: 'running',
            spaceId: delta.spaceId,
            attempt: delta.attempt,
            maxAttempts: delta.maxAttempts,
          };
          this.emit();
        } else if (delta.type === 'context_compaction_retry') {
          this.contextCompaction = {
            status: 'retrying',
            spaceId: delta.spaceId,
            attempt: delta.attempt,
            maxAttempts: delta.maxAttempts,
            ...(delta.message ? { message: delta.message } : {}),
          };
          this.emit();
        } else if (delta.type === 'context_compaction_done') {
          this.contextCompaction = { status: 'idle' };
          this.emit();
        } else if (delta.type === 'context_compaction_failed') {
          this.contextCompaction = {
            status: 'failed',
            spaceId: delta.spaceId,
            attempt: delta.attempts,
            maxAttempts: delta.attempts,
            message: delta.message,
          };
          this.emit();
        } else if (delta.type === 'tool') {
          if (delta.phase === 'start') {
            flush();
            flushSpaceText();
            const tool: ToolCallView = {
              ...(delta.toolCallId ? { toolCallId: delta.toolCallId } : {}),
              name: delta.name,
              args: delta.detail,
              result: '',
              status: 'running',
            };
            this.activeTool = tool;
            this.emit();
            addRunningTool(tool);
            if (delta.name === 'enterWorkspace' || delta.name === 'exitWorkspace') {
              for (const artifact of artifactsFromExitWorkspace(delta.detail, this.activeSpace, () => this.idCounter++, this.workspaceRoot)) {
                addArtifact(artifact);
              }
            }
          } else {
            this.activeTool = null;
            this.emit();
            const toolStatus: ToolCallView['status'] = delta.isError ? 'error' : 'done';
            const pane = this.activeSpace ? this.workspaces.find((item) => item.id === this.activeSpace) : undefined;
            const running = findLastRunningTool(pane?.tools, delta.name, delta.toolCallId);
            const displayDetail = sanitizeDisplayText(delta.detail, toolStatus === 'error' ? 'Tool output is not displayable text.' : '');
            finishTool(delta.name, displayDetail, toolStatus, delta.toolCallId);
            this.commit({
              role: 'tool',
              tool: {
                ...(delta.toolCallId ? { toolCallId: delta.toolCallId } : {}),
                name: delta.name,
                args: running?.args ?? '',
                result: displayDetail,
                status: toolStatus,
              },
              spaceId: this.activeSpace ?? undefined,
            });
            maybeArtifact(delta.name, delta.detail, running?.args ?? '', this.activeSpace, addArtifact, () => this.idCounter++, this.workspaceRoot);
          }
        } else if (delta.type === 'space_message') {
          // A work space's own prose: buffer it and flush as a console message at
          // the next boundary (a tool starts / the space returns).
          spaceAcc += delta.text;
        } else if (delta.type === 'space_status') {
          updateSpaceStatus(delta.id, delta.message);
        } else if (delta.type === 'needs_approval') {
          flush();
          flushSpaceText();
          const id = this.activeSpace;
          if (id) {
            this.setPanes(
              this.workspaces.map((pane) =>
                pane.id === id
                  ? {
                      ...pane,
                      statusLine: `等待审批: ${delta.name}`,
                      artifacts: [
                        ...pane.artifacts,
                        {
                          id: this.idCounter++,
                          spaceId: id,
                          kind: 'diff',
                          title: `approval required: ${delta.name}`,
                          detail: delta.preview ?? delta.args,
                          preview: delta.preview ?? delta.args,
                        },
                      ],
                    }
                  : pane,
              ),
            );
          }
          this.pendingApproval = {
            approvalId: delta.approvalId,
            name: delta.name,
            args: delta.args,
            ...(delta.preview ? { preview: delta.preview } : {}),
            status: 'waiting',
            message: delta.message,
          };
          this.emit();
          this.commit({ role: 'system', text: delta.message });
        } else if (delta.type === 'approval_status') {
          this.pendingApproval = null;
          this.approvalResolve = null;
          this.clearApprovalTimer();
          this.setApprovalNotice({
            approvalId: delta.approvalId,
            name: delta.name,
            args: delta.args ?? '',
            ...(delta.preview ? { preview: delta.preview } : {}),
            status: delta.status,
            message: delta.message,
          });
          this.emit();
        } else if (delta.type === 'space') {
          flush();
          flushSpaceText();
          recordMainDispatch(delta.id, delta.label, delta.goal);
          const paneId = enterSpace(delta.id, delta.label, delta.goal);
          if (!this.hasPendingSpaceMessage(delta.id, paneId)) {
            this.commit({
              role: 'space',
              space: { id: paneId, spaceId: delta.id, label: spaceMeta(this.spaces, delta.id, delta.label).label },
              spaceId: paneId,
            });
          }
        } else if (delta.type === 'space_result') {
          flushSpaceText();
          attachEnvelope(delta.id, delta.envelope);
        } else if (delta.type === 'error') {
          flush();
          runErrored = true;
          this.lastRunError = true;
          this.emit();
          this.commit({ role: 'system', text: delta.message });
          break;
        } else {
          break;
        }
      }
    } finally {
      if (runSeq === this.runSeq) {
        flushSpaceText();
        flush();
        this.approvalResolve?.(false);
        this.clearApprovalTimer();
        this.approvalResolve = null;
        this.pendingApproval = null;
        this.live = '';
        this.activeTool = null;
        if (this.contextCompaction.status !== 'failed') {
          this.contextCompaction = { status: 'idle' };
        }
        this.workspaces = this.workspaces.map((pane) => {
          const status = pane.status === 'error' ? 'error' : runErrored && pane.status === 'running' ? 'error' : 'done';
          const statusLine =
            pane.envelope || pane.status !== 'running'
              ? pane.statusLine
              : runErrored
                ? 'run 已失败,workspace 没有返回结果'
                : 'run 已结束,但没有收到 workspace 结果';
          return {
            ...pane,
            status,
            statusLine,
            endedAt: pane.endedAt ?? Date.now(),
            tools: settleRunningTools(pane.tools, status === 'error' ? 'error' : 'done', statusLine ?? 'Workspace finished.'),
          };
        });
        this.activeSpace = null;
        this.status = 'idle';
        this.controller = null;
        this.emit();
        this.runNextQueuedInput();
      }
    }
  }

  private runNextQueuedInput(): void {
    const next = this.queuedInputs[0];
    if (!next || this.controller) return;
    this.queuedInputs = this.queuedInputs.slice(1);
    this.emit();
    void this.run(next.text, true, next.options).then(next.resolve, next.reject);
  }

  private resolveQueuedInputs(): void {
    const queued = this.queuedInputs;
    this.queuedInputs = [];
    for (const item of queued) {
      item.resolve();
    }
  }
}

// ── module registry: one runtime per conversation, surviving view switches ──
const registry = new Map<string, ConversationRuntime>();
const registryListeners = new Set<() => void>();

function emitRegistry(): void {
  for (const listener of registryListeners) listener();
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

function runningConversationIdsSnapshot(): string {
  return [...registry.values()]
    .filter((runtime) => runtime.isRunning())
    .map((runtime) => runtime.conversationId)
    .sort()
    .join('\0');
}

export function getConversationRuntime(
  conversationId: string,
  engine: Engine,
  context?: { avatarId?: string; projectId?: string; modelId?: string; permissionMode?: PermissionMode },
): ConversationRuntime {
  let runtime = registry.get(conversationId);
  if (!runtime) {
    runtime = new ConversationRuntime(conversationId, engine, context?.avatarId, context?.projectId, context?.modelId, context?.permissionMode);
    registry.set(conversationId, runtime);
    emitRegistry();
  } else if (context) {
    runtime.bindContext(context?.avatarId, context?.projectId, context?.modelId, context?.permissionMode);
  }
  return runtime;
}

export function dropConversationRuntime(conversationId: string): void {
  const runtime = registry.get(conversationId);
  runtime?.abort();
  registry.delete(conversationId);
  emitRegistry();
}

export function dropAllConversationRuntimes(): void {
  for (const runtime of registry.values()) {
    runtime.abort();
  }
  registry.clear();
  emitRegistry();
}

export type ConversationView = WorkbenchSnapshot & {
  conversationId: string;
  send: (text: string, options?: ChatSendOptions) => Promise<void>;
  retryLast: () => Promise<void>;
  deleteMessage: (id: number) => Promise<void>;
  resendMessage: (id: number) => Promise<void>;
  abort: () => void;
  respondApproval: (approved: boolean) => void;
  dismissApprovalNotice: () => void;
  selectWorkspace: (id: string) => void;
  hydrate: (messages: DisplayMessage[], workspaces: WorkPane[], options?: { replace?: boolean }) => void;
  isRunning: () => boolean;
};

/** Bind the active conversation's runtime to React. Switching `conversationId`
 *  just re-subscribes; the previous runtime keeps streaming in the background. */
export function useConversation(
  conversationId: string,
  engine: Engine,
  spaces: SpaceItem[],
  context?: { avatarId?: string; projectId?: string; modelId?: string; permissionMode?: PermissionMode },
): ConversationView {
  const runtime = getConversationRuntime(conversationId, engine, context);
  runtime.spaces = spaces;
  const snap = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, () => EMPTY);
  return {
    ...snap,
    conversationId,
    send: runtime.send,
    retryLast: runtime.retryLast,
    deleteMessage: runtime.deleteMessage,
    resendMessage: runtime.resendMessage,
    abort: runtime.abort,
    respondApproval: runtime.respondApproval,
    dismissApprovalNotice: runtime.dismissApprovalNotice,
    selectWorkspace: runtime.selectWorkspace,
    hydrate: runtime.hydrate.bind(runtime),
    isRunning: () => runtime.isRunning(),
  };
}

export function useRunningConversationIds(): string[] {
  const raw = useSyncExternalStore(subscribeRegistry, runningConversationIdsSnapshot, () => '');
  return raw ? raw.split('\0') : [];
}

export function newConversationId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── pure helpers (unchanged from the previous hook) ──
function maybeArtifact(
  name: string,
  result: string,
  _args: string,
  spaceId: string | null,
  addArtifact: (artifact: ArtifactView) => void,
  nextId: () => number,
  workspaceRoot?: string,
): void {
  const artifact = artifactFromToolResult({ id: -1, name, result, spaceId, workspaceRoot });
  if (artifact) {
    addArtifact({ ...artifact, id: nextId() });
  }
}

function findLastRunningTool(tools: ToolCallView[] | undefined, name: string, toolCallId?: string): ToolCallView | undefined {
  if (!tools) return undefined;
  if (toolCallId) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const tool = tools[index];
      if (tool?.toolCallId === toolCallId) {
        return tool;
      }
    }
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (tool?.name === name && tool.status === 'running') {
      return tool;
    }
  }
  return undefined;
}

function summarizePane(pane: WorkPane): string {
  if (pane.envelope?.summary) return pane.envelope.summary;
  const lastArtifact = pane.artifacts.at(-1);
  if (lastArtifact) return lastArtifact.title;
  const finished = pane.tools.filter((tool) => tool.status !== 'running');
  if (finished.length) {
    const last = finished.at(-1)!;
    const head = (last.result.split('\n').find((line) => line.trim()) ?? last.name).trim();
    return `${last.name}: ${head}`;
  }
  return pane.goal ?? pane.label;
}

function resolveResultPaneId(panes: WorkPane[], spaceId: string): string | null {
  const matching = [...panes].reverse().find((pane) => pane.spaceId === spaceId && pane.status === 'running');
  return matching?.id ?? [...panes].reverse().find((pane) => pane.spaceId === spaceId)?.id ?? null;
}

function normalizeFinishedPanes(panes: WorkPane[]): WorkPane[] {
  return mergePanesBySpace(panes).map((pane) =>
    pane.status === 'running'
      ? pane
      : {
          ...pane,
          tools: settleRunningTools(
            pane.tools,
            pane.status === 'error' ? 'error' : 'done',
            pane.statusLine ?? (pane.status === 'error' ? 'Workspace failed.' : 'Workspace finished.'),
          ),
        },
  );
}

function mergePanesBySpace(panes: WorkPane[]): WorkPane[] {
  const grouped = new Map<string, WorkPane[]>();
  for (const pane of panes) {
    grouped.set(pane.spaceId, [...(grouped.get(pane.spaceId) ?? []), pane]);
  }
  return [...grouped.values()]
    .map(mergeSameSpacePanes)
    .sort((a, b) => paneSortTime(b) - paneSortTime(a));
}

function mergeSameSpacePanes(panes: WorkPane[]): WorkPane {
  if (panes.length === 1) return normalizePaneArtifactIds(panes[0]!);
  const chronological = [...panes].sort((a, b) => a.startedAt - b.startedAt);
  const latest = [...panes].sort((a, b) => paneSortTime(b) - paneSortTime(a))[0]!;
  const tools: ToolCallView[] = [];
  const messages: WorkPane['messages'] = [];
  const artifacts: ArtifactView[] = [];
  const transitions: WorkPane['transitions'] = [];
  let toolOffset = 0;

  for (const pane of chronological) {
    messages.push(...(pane.messages ?? []).map((message) => ({ ...message, after: message.after + toolOffset })));
    tools.push(...pane.tools);
    artifacts.push(...pane.artifacts);
    transitions.push(...(pane.transitions ?? []));
    toolOffset += pane.tools.length;
  }

  const mergedArtifacts = reindexArtifacts(dedupeArtifactViews(artifacts));
  return {
    ...latest,
    id: latest.spaceId,
    startedAt: Math.min(...panes.map((pane) => pane.startedAt)),
    endedAt: latest.status === 'running' ? undefined : Math.max(...panes.map((pane) => pane.endedAt ?? pane.startedAt)),
    tools,
    messages,
    artifacts: mergedArtifacts,
    transitions: dedupeTransitions(transitions),
    currentRunArtifactStart: mergedArtifacts.length,
  };
}

function dedupeTransitions(transitions: NonNullable<WorkPane['transitions']>): NonNullable<WorkPane['transitions']> {
  const seen = new Set<string>();
  const result: NonNullable<WorkPane['transitions']> = [];
  for (const transition of transitions) {
    const key = [
      transition.fromSpace,
      transition.toSpace,
      transition.status,
      transition.message,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(transition);
  }
  return result.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function paneSortTime(pane: WorkPane): number {
  return pane.endedAt ?? pane.startedAt;
}

function normalizePaneArtifactIds(pane: WorkPane): WorkPane {
  const artifacts = reindexArtifacts(dedupeArtifactViews(pane.artifacts));
  return {
    ...pane,
    artifacts,
    currentRunArtifactStart: Math.min(pane.currentRunArtifactStart ?? artifacts.length, artifacts.length),
  };
}

function reindexArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return artifacts.map((artifact, index) => ({ ...artifact, id: index + 1 }));
}

function settleRunningTools(tools: ToolCallView[], status: Exclude<ToolCallView['status'], 'running'>, fallbackResult: string): ToolCallView[] {
  const displayFallback = sanitizeDisplayText(fallbackResult, status === 'error' ? 'Workspace failed.' : 'Workspace finished.');
  let changed = false;
  const next = tools.map((tool) => {
    if (tool.status !== 'running') {
      return tool;
    }
    changed = true;
    return {
      ...tool,
      status,
      result: sanitizeDisplayText(tool.result || displayFallback, displayFallback),
    };
  });
  return changed ? next : tools;
}

function sanitizeEnvelope(envelope: Envelope): Envelope {
  const fallback = envelope.status === 'failed' ? 'Workspace failed.' : 'Workspace finished.';
  return {
    ...envelope,
    summary: sanitizeDisplayText(envelope.summary, fallback),
    ...(envelope.content ? { content: sanitizeDisplayText(envelope.content, '') } : {}),
  };
}

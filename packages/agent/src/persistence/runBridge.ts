import { randomUUID } from 'node:crypto';
import type { Message } from '@zleap/ai';
import {
  DEFAULT_AVATAR_ID,
  LOCAL_DEV_ACTOR_TENANT_ID,
  LOCAL_DEV_ACTOR_USER_ID,
  toCanonicalSpaceId,
  type ActorContext,
  type AgentEvent,
  type InboundChannel,
  type InboundDisplayImageAttachment,
  type Artifact,
  type Run,
  type SpaceCapabilitySnapshot,
  type ToolCall,
  type Work,
  type WorkspaceResult,
  type WorkspaceResultStatus,
  type WorkStep,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { summarizeError } from '../errors.js';

type StoreProvider = () => Promise<ZleapStore | null>;

export type BeginReplyPersistenceInput = {
  conversationId?: string;
  source: InboundChannel;
  goal: string;
  messages: Message[];
  actor?: ActorContext;
  workspaceRoot?: string;
  displayAttachments?: InboundDisplayImageAttachment[];
};

export type EndReplyPersistenceInput = {
  status: 'completed' | 'failed' | 'aborted';
  reason?: string;
  error?: unknown;
};

export type ReplyEntryIds = {
  userEntryId?: string;
  assistantEntryIds: string[];
};

/** The canonical dispatch verdict the engine hands back for durable storage. */
export type FinalizedTask = {
  taskId: string;
  space: string;
  status: 'success' | 'failed';
  workspaceStatus?: WorkspaceResultStatus;
  workspaceResult?: WorkspaceResult;
  summary: string;
  content: string;
  references: unknown;
  meta?: unknown;
};

type ActiveReply = {
  source: InboundChannel;
  conversationId: string;
  threadId: string;
  mainSessionId: string;
  goal: string;
  actor?: ActorContext;
  workspaceRoot?: string;
};

type StepState = {
  sessionId: string;
  buffer: string;
  runId: string;
  workId: string;
  workspaceId: string;
  capabilitySnapshotId?: string;
};

type SessionEntryProjectionKind =
  | 'user_message'
  | 'workspace_user_message'
  | 'workspace_assistant_message'
  | 'workspace_tool_preview'
  | 'approval_request'
  | 'approval_decision'
  | 'tool_execution_record'
  | 'workspace_artifact'
  | 'artifact_handoff'
  | 'capability_snapshot'
  | 'compaction';

type SessionEntrySourceRef = {
  table: string;
  ids: string[];
};

type SessionEntryProjection = {
  projectionKind: SessionEntryProjectionKind;
  source: string;
  sourceRefs?: SessionEntrySourceRef[];
};

export type DurableProjectionFailure = {
  phase: 'begin_reply' | 'event_projection' | 'finalize_task' | 'end_reply';
  operation?: string;
  message: string;
  code?: string;
  occurredAt: Date;
};

export type DurableProjectionStatus = {
  failureCount: number;
  lastFailure?: DurableProjectionFailure;
};

export type CompactionMemoryAuditInput = {
  status: 'pending' | 'written' | 'rejected' | 'failed';
  sourceId: string;
  conversationId?: string;
  foldedMessages: number;
  summarizedMessages: number;
  sourceRefs: unknown[];
  fromHook: boolean;
  memoryId?: string;
  reason?: string;
  error?: unknown;
};

export type CompactionSummaryDetails = {
  facts: string[];
  decisions: string[];
  files: string[];
  openTasks: string[];
};

export type CompactionSessionEntryInput = {
  spaceId?: string;
  summaryKind?: 'workspace_summary' | 'event_refresh';
  summary: string;
  summaryDetails?: CompactionSummaryDetails;
  sourceId: string;
  conversationId?: string;
  foldStart: number;
  foldEnd: number;
  foldedMessages: number;
  summarizedMessages: number;
  sourceRefs: unknown[];
  firstKeptEntryId?: string;
  charactersBefore?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  tailTokens?: number;
  triggerTokens?: number;
  compactionAttempt?: number;
  reason: string;
  fromHook: boolean;
  memoryStatus?: CompactionMemoryAuditInput['status'];
  memoryReason?: string;
  memoryId?: string;
  error?: unknown;
};

/**
 * Projects runtime events into the Super Agent durable model. The runtime stays
 * storage-agnostic; this bridge is owned by the surface/avatar layer that knows
 * the active conversation and default avatar.
 */
export class RunPersistenceBridge {
  private readonly getStore: StoreProvider;
  private readonly avatarId: string;
  private localConversationId: string;
  private active?: ActiveReply;
  private ledgerSeq = 0;
  private readonly parentBySession = new Map<string, string | undefined>();
  private readonly workById = new Map<string, Work>();
  private readonly stepById = new Map<string, StepState>();
  private failureCount = 0;
  private lastFailure?: DurableProjectionFailure;
  private currentReplyEntryIds: ReplyEntryIds = { assistantEntryIds: [] };
  private readonly onFailure: (failure: DurableProjectionFailure) => void;

  constructor(options: {
    getStore: StoreProvider;
    avatarId?: string;
    localConversationId?: string;
    /** Surface durable-projection failures. Defaults to a stderr warning so a
     *  failed `beginReply` (which drops the whole turn's persistence) is never a
     *  silent black hole. */
    onFailure?: (failure: DurableProjectionFailure) => void;
  }) {
    this.getStore = options.getStore;
    this.avatarId = options.avatarId ?? DEFAULT_AVATAR_ID;
    this.localConversationId = options.localConversationId ?? `cli-${Date.now().toString(36)}`;
    this.onFailure = options.onFailure ?? defaultOnFailure;
  }

  /** Continue an existing thread after a DB resume by reusing its
   *  conversationId, so later turns append to the same thread/session. */
  adoptConversation(conversationId: string): void {
    this.localConversationId = sanitizeId(conversationId);
  }

  inspect(): DurableProjectionStatus {
    return { failureCount: this.failureCount, ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}) };
  }

  replyEntryIds(): ReplyEntryIds {
    return {
      ...(this.currentReplyEntryIds.userEntryId ? { userEntryId: this.currentReplyEntryIds.userEntryId } : {}),
      assistantEntryIds: [...this.currentReplyEntryIds.assistantEntryIds],
    };
  }

  activeMainSessionWindowRef(input: { start: number; end: number }):
    | { type: 'session_entries'; threadId: string; sessionId: string; leafEntryId?: string; start: number; end: number }
    | undefined {
    if (!this.active) {
      return undefined;
    }
    const leafEntryId = this.parentBySession.get(this.active.mainSessionId);
    return {
      type: 'session_entries',
      threadId: this.active.threadId,
      sessionId: this.active.mainSessionId,
      ...(leafEntryId ? { leafEntryId } : {}),
      start: input.start,
      end: input.end,
    };
  }

  activeMainSessionRef(): { threadId: string; sessionId: string; conversationId: string } | undefined {
    if (!this.active) {
      return undefined;
    }
    return {
      threadId: this.active.threadId,
      sessionId: this.active.mainSessionId,
      conversationId: this.active.conversationId,
    };
  }

  activeWorkspaceSessionRef(spaceId: string): { threadId: string; sessionId: string; conversationId: string } | undefined {
    if (!this.active) {
      return undefined;
    }
    const canonicalSpaceId = toCanonicalSpaceId(spaceId);
    return {
      threadId: this.active.threadId,
      sessionId: canonicalSpaceId === 'main'
        ? this.active.mainSessionId
        : workspaceSessionId(this.active.threadId, canonicalSpaceId),
      conversationId: this.active.conversationId,
    };
  }

  async recordCompactionMemoryAudit(input: CompactionMemoryAuditInput): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    try {
      const store = await this.getStore();
      if (!store) {
        return;
      }
      await this.persistLifecycleAuditEvent(store, {
        id: `${active.mainSessionId}:memory_compaction_event:${(this.ledgerSeq += 1)}`,
        type: 'memory_compaction_event',
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        data: {
          status: input.status,
          sourceId: input.sourceId,
          conversationId: input.conversationId,
          foldedMessages: input.foldedMessages,
          summarizedMessages: input.summarizedMessages,
          sourceRefs: input.sourceRefs,
          fromHook: input.fromHook,
          memoryId: input.memoryId,
          reason: input.reason,
          error: errorSummary(input.error),
        },
      }, active);
    } catch (error) {
      this.recordFailure('event_projection', error, 'memory_compaction_event');
    }
  }

  async recordCompactionSessionEntry(input: CompactionSessionEntryInput): Promise<string | undefined> {
    const active = this.active;
    const summary = input.summary.trim();
    const recordsFailureProjection = !summary && input.memoryStatus && input.memoryStatus !== 'written';
    if (!active || input.foldedMessages <= 0 || (!summary && !recordsFailureProjection)) {
      return undefined;
    }
    try {
      const store = await this.getStore();
      if (!store) {
        return undefined;
      }
      const targetSpaceId = toCanonicalSpaceId(input.spaceId ?? 'main');
      const targetSessionId = targetSpaceId === 'main'
        ? active.mainSessionId
        : workspaceSessionId(active.threadId, targetSpaceId);
      return await this.appendEntry(store, targetSessionId, {
        type: 'compaction',
        role: 'system',
        content: summary,
        data: entryData({
          conversationId: input.conversationId,
          sourceId: input.sourceId,
          spaceId: targetSpaceId,
          summaryKind: input.summaryKind ?? 'event_refresh',
          foldStart: input.foldStart,
          foldEnd: input.foldEnd,
          foldedMessages: input.foldedMessages,
          summarizedMessages: input.summarizedMessages,
          summaryDetails: input.summaryDetails,
          sourceRefs: input.sourceRefs,
          firstKeptEntryId: input.firstKeptEntryId,
          charactersBefore: input.charactersBefore,
          tokensBefore: input.tokensBefore,
          tokensAfter: input.tokensAfter,
          tailTokens: input.tailTokens,
          triggerTokens: input.triggerTokens,
          compactionAttempt: input.compactionAttempt,
          reason: input.reason,
          fromHook: input.fromHook,
          memoryStatus: input.memoryStatus,
          memoryReason: input.memoryReason,
          memoryId: input.memoryId,
          memoryError: errorSummary(input.error),
        }, {
          projectionKind: 'compaction',
          source: 'compaction',
        }),
      });
    } catch (error) {
      this.recordFailure('event_projection', error, 'compaction_session_entry');
      return undefined;
    }
  }

  async beginReply(input: BeginReplyPersistenceInput): Promise<void> {
    this.currentReplyEntryIds = { assistantEntryIds: [] };
    try {
      const store = await this.getStore();
      if (!store) {
        return;
      }
      const rawConversationId = input.conversationId ?? this.localConversationId;
      const conversationId = sanitizeId(rawConversationId);
      const threadId = `${input.source}:${conversationId}`;
      const mainSessionId = `${threadId}:main`;
      const now = new Date();
      const existingThread = await store.threads.getThread(threadId);
      if (
        existingThread &&
        !recordBelongsToActor(existingThread, input.actor, { source: input.source, conversationId: rawConversationId })
      ) {
        throw new Error('thread_forbidden');
      }
      const owner = ownerFromActor(input.actor);
      const existingSession = await store.sessions.getSession(mainSessionId, owner);

      const actorMetadata = metadataFromActor(input.actor);
      const runtimeMetadata = metadataFromRuntime(input);
      const threadMetadata = { ...(existingThread?.metadata ?? {}), conversationId: rawConversationId, ...actorMetadata, ...runtimeMetadata };
      const sessionMetadata = { ...(existingSession?.metadata ?? existingThread?.metadata ?? {}), conversationId: rawConversationId, ...actorMetadata, ...runtimeMetadata };

      await store.transaction(async (tx) => {
        await tx.threads.createThread({
          id: threadId,
          avatarId: this.avatarId,
          userId: input.actor?.userId,
          tenantId: input.actor?.tenantId,
          title: firstLine(input.goal) || 'Conversation',
          status: 'active',
          source: input.source,
          createdAt: existingSession?.createdAt ?? now,
          updatedAt: now,
          metadata: threadMetadata,
        });
        await tx.sessions.createSession({
          id: mainSessionId,
          threadId,
          avatarId: this.avatarId,
          userId: input.actor?.userId,
          tenantId: input.actor?.tenantId,
          spaceId: this.spaceStorageId('main'),
          kind: 'main',
          status: 'active',
          rootGoal: input.goal,
          source: input.source,
          createdAt: existingSession?.createdAt ?? now,
          updatedAt: now,
          metadata: sessionMetadata,
        });
      });

      this.active = {
        source: input.source,
        conversationId,
        threadId,
        mainSessionId,
        goal: input.goal,
        actor: input.actor,
        workspaceRoot: normalizedWorkspaceRoot(input.workspaceRoot),
      };
      this.parentBySession.set(mainSessionId, existingSession?.currentLeafEntryId);
      const userEntryId = await this.appendEntry(store, mainSessionId, {
        type: 'message',
        role: 'user',
        content: lastUserText(input.messages) || input.goal,
        data: entryData({
          conversationId,
          ...(input.displayAttachments?.length ? { displayAttachments: input.displayAttachments } : {}),
        }, {
          projectionKind: 'user_message',
          source: 'reply_input',
          sourceRefs: [{ table: 'threads', ids: [threadId] }],
        }),
      });
      this.currentReplyEntryIds.userEntryId = userEntryId;
    } catch (error) {
      if (isThreadForbiddenError(error)) {
        throw error;
      }
      this.recordFailure('begin_reply', error);
      this.active = undefined;
    }
  }

  /**
   * Persist the canonical TaskResult (the evaluated dispatch verdict) as an
   * authoritative `task_result` artifact on the main session, keyed by the
   * dispatch run id. Distinct from the raw `workspace_result` artifact (the
   * producer's output) — this one carries the final status + summary for UI and
   * ledger inspection.
   */
  async finalizeTask(result: FinalizedTask): Promise<void> {
    const canonicalSpace = toCanonicalSpaceId(result.space);
    try {
      const store = await this.getStore();
      if (!store || !this.active) {
        return;
      }
      const active = this.active;
      await store.ledger.saveArtifact({
        id: `${result.taskId}:result`,
        workspaceId: canonicalSpace,
        title: `Task result · ${canonicalSpace}`,
        summary: result.summary,
        data: {
          references: result.references,
          meta: result.meta,
          workspaceStatus: result.workspaceStatus,
          workspaceResult: result.workspaceResult,
        },
        createdAt: new Date(),
        runId: result.taskId,
        threadId: active.threadId,
        producerSessionId: active.mainSessionId,
        kind: 'task_result',
        status: result.status === 'success' ? 'success' : 'failed',
        content: result.content,
      });
    } catch (error) {
      this.recordFailure('finalize_task', error);
      // Best-effort, same policy as handle().
    }
  }

  async endReply(input: EndReplyPersistenceInput): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }
    try {
      const store = await this.getStore();
      if (!store) {
        return;
      }
      await this.persistLifecycleAuditEvent(store, {
        id: `${active.mainSessionId}:session_shutdown:${(this.ledgerSeq += 1)}`,
        type: 'session_shutdown',
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        data: {
          status: input.status,
          source: active.source,
          conversationId: active.conversationId,
          reason: input.reason,
          error: errorSummary(input.error),
        },
      }, active);
    } catch (error) {
      this.recordFailure('end_reply', error);
      // Same best-effort policy as runtime event projection.
    } finally {
      this.active = undefined;
      this.workById.clear();
      this.stepById.clear();
    }
  }

  async handle(event: AgentEvent): Promise<void> {
    try {
      const store = await this.getStore();
      if (!store || !this.active) {
        return;
      }
      await this.persistEvent(store, event, this.active);
    } catch (error) {
      this.recordFailure('event_projection', error, event.type);
      // Durable projection is best-effort for the current CLI/Web MVP. Store
      // readiness is still surfaced by /status; a write miss must not break a run.
    }
  }

  private recordFailure(phase: DurableProjectionFailure['phase'], error: unknown, operation?: string): void {
    const summary = errorSummary(error) ?? { message: 'Unknown persistence error' };
    this.failureCount += 1;
    this.lastFailure = {
      phase,
      operation,
      message: truncateFailureMessage(summary.message),
      ...(summary.code ? { code: summary.code } : {}),
      occurredAt: new Date(),
    };
    try {
      this.onFailure(this.lastFailure);
    } catch {
      // Never let a misbehaving sink mask the original persistence failure.
    }
  }

  private async persistEvent(store: ZleapStore, event: AgentEvent, active: ActiveReply): Promise<void> {
    if (event.type === 'agent_start' || event.type === 'agent_end') {
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.run.id}:${event.type}`,
        type: event.type,
        runId: event.run.id,
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        createdAt: event.type === 'agent_end' ? (event.run.endedAt ?? new Date()) : event.run.startedAt,
        data: {
          status: event.run.status,
          runtimeAgentId: event.run.agentId,
          runtimeSessionId: event.run.session?.id,
          workCount: event.run.works.length,
          artifactCount: event.run.artifacts.length,
          error: errorSummary(event.run.error),
        },
      }, active);
      await store.ledger.saveRun(this.runRecord(event.run, active));
      return;
    }
    if (event.type === 'run_status') {
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:run_status:${event.status}`,
        type: event.type,
        runId: event.runId,
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        data: { status: event.status },
      }, active);
      await store.ledger.saveRun({
        id: event.runId,
        avatarId: this.avatarId,
        avatarVersion: 1,
        threadId: active.threadId,
        mainSessionId: active.mainSessionId,
        status: event.status,
        goal: active.goal,
        startedAt: new Date(),
      });
      return;
    }
    if (event.type === 'before_work' || event.type === 'after_work') {
      this.workById.set(event.work.id, event.work);
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:${event.work.id}:${event.type}`,
        type: event.type,
        runId: event.runId,
        workId: event.work.id,
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        createdAt: event.type === 'after_work' ? (event.work.endedAt ?? new Date()) : event.work.startedAt,
        data: {
          status: event.work.status,
          runtimeAgentId: event.work.agentId,
          runtimeSessionId: event.work.session?.id,
          spaces: event.work.spaces.map(toCanonicalSpaceId),
          skillIds: event.work.skillIds,
          toolIds: event.work.toolIds,
          stepCount: event.work.steps.length,
          artifactCount: event.work.artifacts.length,
          error: errorSummary(event.work.error),
        },
      }, active);
      await store.ledger.saveWork(this.workRecord(event.runId, event.work, active));
      return;
    }
    if (event.type === 'work_status') {
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:${event.workId}:work_status:${event.status}`,
        type: event.type,
        runId: event.runId,
        workId: event.workId,
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        data: { status: event.status },
      }, active);
      const work = this.workById.get(event.workId);
      if (work) {
        await store.ledger.saveWork(this.workRecord(event.runId, { ...work, status: event.status }, active));
      }
      return;
    }
    if (event.type === 'work_step_status') {
      const stepState = this.stepById.get(event.stepId);
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:${event.workId}:${event.stepId}:work_step_status:${event.status}`,
        type: event.type,
        runId: event.runId,
        workId: event.workId,
        workStepId: event.stepId,
        threadId: active.threadId,
        sessionId: stepState?.sessionId,
        data: { status: event.status, workspaceId: toCanonicalSpaceId(event.workspaceId), runtimeWorkspaceId: event.workspaceId },
      }, active);
      await store.ledger.saveWorkStep({
        id: event.stepId,
        workId: event.workId,
        workspaceId: toCanonicalSpaceId(event.workspaceId),
        sessionId: stepState?.sessionId,
        status: event.status,
        capabilitySnapshotId: stepState?.capabilitySnapshotId,
        metadata: { runtimeWorkspaceId: event.workspaceId },
      });
      return;
    }
    if (event.type === 'space_enter') {
      await this.enterSpace(store, event.runId, event.workId, event.step, active);
      await this.persistLifecycleAuditEvent(store, this.spaceLifecycleAuditEvent(event.type, event.runId, event.workId, event.step, active), active);
      return;
    }
    if (event.type === 'workspace_delta') {
      const state = this.stepById.get(event.stepId);
      if (!state) {
        return;
      }
      if (event.delta.kind === 'turn_lifecycle') {
        await this.persistTurnAuditEvent(store, event.runId, event.workId, event.stepId, event.workspaceId, event.delta, active);
      } else if (event.delta.kind === 'provider_lifecycle') {
        await this.persistProviderAuditEvent(store, event.runId, event.workId, event.stepId, event.workspaceId, event.delta, active);
      } else if (event.delta.kind === 'text') {
        state.buffer += event.delta.text;
      } else if (event.delta.kind === 'approval') {
        const projectionKind = event.delta.status === 'needs_approval' ? 'approval_request' : 'approval_decision';
        await this.appendEntry(store, state.sessionId, {
          type: 'tool_result',
          role: 'tool',
          content: event.delta.message,
          runId: event.runId,
          workId: event.workId,
          workStepId: event.stepId,
          data: entryData({
            approvalId: event.delta.approvalId,
            toolName: event.delta.name,
            status: event.delta.status,
            ...(event.delta.preview ? { preview: event.delta.preview } : {}),
          }, {
            projectionKind,
            source: 'workspace_delta',
          }),
        });
      } else if (event.delta.phase === 'start') {
        await this.appendEntry(store, state.sessionId, {
          type: 'tool_call',
          role: 'assistant',
          content: event.delta.detail,
          runId: event.runId,
          workId: event.workId,
          workStepId: event.stepId,
          toolCallId: event.delta.toolCallId,
          data: entryData({
            toolName: event.delta.name,
            phase: event.delta.phase,
          }, {
            projectionKind: 'workspace_tool_preview',
            source: 'workspace_delta',
          }),
        });
      } else {
        await this.appendEntry(store, state.sessionId, {
          type: 'tool_result',
          role: 'tool',
          content: event.delta.detail,
          runId: event.runId,
          workId: event.workId,
          workStepId: event.stepId,
          toolCallId: event.delta.toolCallId,
          data: entryData({
            toolName: event.delta.name,
            phase: event.delta.phase,
            isError: event.delta.isError ?? false,
          }, {
            projectionKind: 'workspace_tool_preview',
            source: 'workspace_delta',
          }),
        });
      }
      return;
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      await this.persistToolAuditEvent(store, event.type, event.runId, event.workId, event.stepId, event.call, active);
      if (event.type === 'tool_execution_end') {
        await this.persistToolCall(store, event.runId, event.workId, event.stepId, event.call);
      }
      return;
    }
    if (event.type === 'artifact_produced') {
      const state = this.stepById.get(event.stepId);
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:${event.workId}:${event.stepId}:artifact:${event.artifact.id}`,
        type: event.type,
        runId: event.runId,
        workId: event.workId,
        workStepId: event.stepId,
        threadId: active.threadId,
        sessionId: state?.sessionId,
        createdAt: event.artifact.createdAt,
        data: {
          artifactId: event.artifact.id,
          workspaceId: toCanonicalSpaceId(event.artifact.workspaceId),
          hasData: event.artifact.data !== undefined,
        },
      }, active);
      await this.persistArtifact(store, event.runId, event.workId, event.stepId, event.artifact, active);
      return;
    }
    if (event.type === 'space_exit') {
      await this.persistLifecycleAuditEvent(store, this.spaceLifecycleAuditEvent(event.type, event.runId, event.workId, event.step, active), active);
      await this.exitSpace(store, event.runId, event.workId, event.step, active);
      return;
    }
    if (event.type === 'error') {
      await this.persistLifecycleAuditEvent(store, {
        id: `${event.runId}:error:${(this.ledgerSeq += 1)}`,
        type: event.type,
        runId: event.runId,
        threadId: active.threadId,
        sessionId: active.mainSessionId,
        data: { error: errorSummary(event.error) },
      }, active);
    }
  }

  private async enterSpace(store: ZleapStore, runId: string, workId: string, step: WorkStep, active: ActiveReply): Promise<void> {
    const canonicalSpaceId = toCanonicalSpaceId(step.workspaceId);
    const isMain = canonicalSpaceId === 'main';
    const sessionId = isMain ? active.mainSessionId : workspaceSessionId(active.threadId, canonicalSpaceId);
    const now = new Date();
    const existingSession = isMain
      ? undefined
      : await store.sessions.getSession(sessionId, ownerFromActor(active.actor));
    if (!isMain) {
      await store.sessions.createSession({
        id: sessionId,
        threadId: active.threadId,
        avatarId: this.avatarId,
        userId: active.actor?.userId,
        tenantId: active.actor?.tenantId,
        spaceId: this.spaceStorageId(canonicalSpaceId),
        kind: 'work',
        parentSessionId: active.mainSessionId,
        rootGoal: active.goal,
        task: this.workById.get(workId)?.goal,
        status: 'active',
        currentLeafEntryId: existingSession?.currentLeafEntryId,
        source: active.source,
        createdAt: existingSession?.createdAt ?? now,
        updatedAt: now,
        metadata: {
          runId,
          workId,
          stepId: step.id,
          runtimeWorkspaceId: step.workspaceId,
          ...metadataFromActor(active.actor),
          ...metadataFromRuntime(active),
        },
      });
    }
    this.parentBySession.set(sessionId, isMain ? this.parentBySession.get(active.mainSessionId) : existingSession?.currentLeafEntryId);
    const task = this.workById.get(workId)?.goal?.trim();
    if (!isMain && task) {
      await this.appendEntry(store, sessionId, {
        type: 'message',
        role: 'user',
        content: task,
        runId,
        workId,
        workStepId: step.id,
        data: entryData({
          workspaceId: canonicalSpaceId,
          runtimeWorkspaceId: step.workspaceId,
        }, {
          projectionKind: 'workspace_user_message',
          source: 'space_enter',
        }),
      });
    }
    const capabilitySnapshot = await this.captureCapabilitySnapshot(store, runId, workId, step.id, canonicalSpaceId);
    this.stepById.set(step.id, {
      sessionId,
      buffer: '',
      runId,
      workId,
      workspaceId: step.workspaceId,
      capabilitySnapshotId: capabilitySnapshot?.id,
    });
    if (capabilitySnapshot) {
      await this.appendEntry(store, sessionId, {
        type: 'capability_snapshot',
        role: 'system',
        content: `Capability snapshot for ${canonicalSpaceId}`,
        runId,
        workId,
        workStepId: step.id,
        data: entryData(capabilitySnapshot as unknown as Record<string, unknown>, {
          projectionKind: 'capability_snapshot',
          source: 'space_enter',
          sourceRefs: [{ table: 'capability_snapshots', ids: [capabilitySnapshot.id] }],
        }),
      });
    }
    await store.ledger.saveWorkStep({
      id: step.id,
      workId,
      workspaceId: canonicalSpaceId,
      sessionId,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      error: errorSummary(step.error),
      capabilitySnapshotId: capabilitySnapshot?.id,
      metadata: { runtimeWorkspaceId: step.workspaceId },
    });
  }

  private async exitSpace(store: ZleapStore, runId: string, workId: string, step: WorkStep, active: ActiveReply): Promise<void> {
    const state = this.stepById.get(step.id);
    if (state?.buffer.trim()) {
      const assistantEntryId = await this.appendEntry(store, state.sessionId, {
        type: 'message',
        role: 'assistant',
        content: state.buffer,
        runId,
        workId,
        workStepId: step.id,
        data: entryData({
          workspaceId: toCanonicalSpaceId(step.workspaceId),
          runtimeWorkspaceId: step.workspaceId,
        }, {
          projectionKind: 'workspace_assistant_message',
          source: 'workspace_delta_buffer',
        }),
      });
      if (state.sessionId === active.mainSessionId) {
        this.currentReplyEntryIds.assistantEntryIds.push(assistantEntryId);
      }
      state.buffer = '';
    }
    await store.ledger.saveWorkStep({
      id: step.id,
      workId,
      workspaceId: toCanonicalSpaceId(step.workspaceId),
      sessionId: state?.sessionId,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      error: errorSummary(step.error),
      capabilitySnapshotId: state?.capabilitySnapshotId,
      metadata: {
        runtimeWorkspaceId: step.workspaceId,
        hookFailures: serializeStepHookFailures(step),
      },
    });
    if (state && toCanonicalSpaceId(step.workspaceId) !== 'main') {
      const workspaceResult = readWorkspaceResult(step.artifact?.data);
      await store.sessions.createSession({
        id: state.sessionId,
        threadId: active.threadId,
        avatarId: this.avatarId,
        userId: active.actor?.userId,
        tenantId: active.actor?.tenantId,
        spaceId: this.spaceStorageId(toCanonicalSpaceId(step.workspaceId)),
        kind: 'work',
        parentSessionId: active.mainSessionId,
        rootGoal: active.goal,
	        task: this.workById.get(workId)?.goal,
	        status: sessionStatusFromStep(step, workspaceResult),
	        currentLeafEntryId: this.parentBySession.get(state.sessionId),
	        source: active.source,
	        updatedAt: step.endedAt ?? new Date(),
	        metadata: {
	          runId,
	          workId,
	          stepId: step.id,
	          runtimeWorkspaceId: step.workspaceId,
	          workspaceResultStatus: workspaceResult?.status,
	          workspaceResultSummary: workspaceResult?.summary ? truncateMetadataText(workspaceResult.summary) : undefined,
	          ...metadataFromActor(active.actor),
	          ...metadataFromRuntime(active),
	        },
	      });
    }
  }

  private async captureCapabilitySnapshot(
    store: ZleapStore,
    runId: string,
    workId: string,
    stepId: string,
    canonicalSpaceId: string,
  ): Promise<SpaceCapabilitySnapshot | undefined> {
    try {
      const snapshot = await store.spaces.getSpaceSnapshot({
        avatarId: this.avatarId,
        spaceId: this.spaceStorageId(canonicalSpaceId),
      });
      const record: SpaceCapabilitySnapshot = {
        ...snapshot,
        id: `${runId}:${workId}:${stepId}:capability_snapshot`,
        createdAt: new Date(),
      };
      await store.ledger.saveCapabilitySnapshot(record);
      return record;
    } catch {
      return undefined;
    }
  }

  private async persistToolCall(
    store: ZleapStore,
    runId: string,
    workId: string,
    stepId: string,
    call: ToolCall,
  ): Promise<void> {
    const state = this.stepById.get(stepId);
    if (!state || !call.endedAt) {
      return;
    }
    await this.appendEntry(store, state.sessionId, {
      type: call.error ? 'tool_result' : 'tool_call',
      role: call.error ? 'tool' : 'assistant',
      content: call.error ? call.error.message : JSON.stringify(call.result ?? call.input),
      runId,
      workId,
      workStepId: stepId,
      toolCallId: call.id,
      data: entryData({
        toolId: call.toolId,
        reason: call.reason,
        input: call.input,
        result: call.result,
        error: errorSummary(call.error),
        hookFailures: serializeToolHookFailures(call),
        startedAt: call.startedAt.toISOString(),
        endedAt: call.endedAt.toISOString(),
      }, {
        projectionKind: 'tool_execution_record',
        source: 'tool_execution_end',
        sourceRefs: [{ table: 'ledger_events', ids: [`${runId}:${workId}:${stepId}:${call.id}:tool_execution_end`] }],
      }),
    });
  }

  private async persistToolAuditEvent(
    store: ZleapStore,
    type: 'tool_execution_start' | 'tool_execution_end',
    runId: string,
    workId: string,
    stepId: string,
    call: ToolCall,
    active: ActiveReply,
  ): Promise<void> {
    const state = this.stepById.get(stepId);
    await store.ledger.saveEvent({
      id: `${runId}:${workId}:${stepId}:${call.id}:${type}`,
      runId,
      workId,
      workStepId: stepId,
      threadId: active.threadId,
      sessionId: state?.sessionId,
      userId: active.actor?.userId,
      tenantId: active.actor?.tenantId,
      type,
      data: {
        toolId: call.toolId,
        reason: call.reason,
        status: type === 'tool_execution_start' ? 'started' : call.error ? 'failed' : 'completed',
        startedAt: call.startedAt.toISOString(),
        endedAt: call.endedAt?.toISOString(),
        error: call.error ? { message: call.error.message } : undefined,
        hookFailures: serializeToolHookFailures(call),
      },
      createdAt: call.endedAt ?? call.startedAt,
    });
  }

  private async persistLifecycleAuditEvent(
    store: ZleapStore,
    event: {
      id: string;
      type: string;
      runId?: string;
      workId?: string;
      workStepId?: string;
      threadId?: string;
      sessionId?: string;
      data?: unknown;
      createdAt?: Date;
    },
    active: ActiveReply,
  ): Promise<void> {
    await store.ledger.saveEvent({
      id: event.id,
      runId: event.runId,
      workId: event.workId,
      workStepId: event.workStepId,
      threadId: event.threadId ?? active.threadId,
      sessionId: event.sessionId,
      userId: active.actor?.userId,
      tenantId: active.actor?.tenantId,
      type: event.type,
      data: event.data,
      createdAt: event.createdAt ?? new Date(),
    });
  }

  private async persistProviderAuditEvent(
    store: ZleapStore,
    runId: string,
    workId: string,
    stepId: string,
    workspaceId: string,
    delta: Extract<AgentEvent, { type: 'workspace_delta' }>['delta'] & { kind: 'provider_lifecycle' },
    active: ActiveReply,
  ): Promise<void> {
    const state = this.stepById.get(stepId);
    const eventType = delta.phase === 'request' ? 'before_provider_request' : 'after_provider_response';
    await store.ledger.saveEvent({
      id: `${runId}:${workId}:${stepId}:provider:${delta.requestId}:${delta.phase}`,
      runId,
      workId,
      workStepId: stepId,
      threadId: active.threadId,
      sessionId: state?.sessionId,
      userId: active.actor?.userId,
      tenantId: active.actor?.tenantId,
      type: eventType,
      data: {
        requestId: delta.requestId,
        modelId: delta.modelId,
        status: delta.status,
        workspaceId: toCanonicalSpaceId(workspaceId),
        runtimeWorkspaceId: workspaceId,
        messageCount: delta.messageCount,
        toolCount: delta.toolCount,
        cacheBreakpointCount: delta.cacheBreakpointCount,
        finishReason: delta.finishReason,
        textLength: delta.textLength,
        toolCallCount: delta.toolCallCount,
        toolCalls: delta.toolCalls,
        usage: delta.usage,
        error: delta.error,
        hookFailures: delta.hookFailures,
      },
      createdAt: new Date(),
    });
  }

  private async persistTurnAuditEvent(
    store: ZleapStore,
    runId: string,
    workId: string,
    stepId: string,
    workspaceId: string,
    delta: Extract<AgentEvent, { type: 'workspace_delta' }>['delta'] & { kind: 'turn_lifecycle' },
    active: ActiveReply,
  ): Promise<void> {
    const state = this.stepById.get(stepId);
    const eventType = delta.phase === 'start' ? 'turn_start' : 'turn_end';
    await store.ledger.saveEvent({
      id: `${runId}:${workId}:${stepId}:turn:${delta.turnId}:${delta.phase}`,
      runId,
      workId,
      workStepId: stepId,
      threadId: active.threadId,
      sessionId: state?.sessionId,
      userId: active.actor?.userId,
      tenantId: active.actor?.tenantId,
      type: eventType,
      data: {
        turnId: delta.turnId,
        modelId: delta.modelId,
        status: delta.status,
        workspaceId: toCanonicalSpaceId(workspaceId),
        runtimeWorkspaceId: workspaceId,
        messageCount: delta.messageCount,
        toolCount: delta.toolCount,
        cacheBreakpointCount: delta.cacheBreakpointCount,
        finishReason: delta.finishReason,
        textLength: delta.textLength,
        toolCallCount: delta.toolCallCount,
        toolResultCount: delta.toolResultCount,
        workspaceResultStatus: delta.workspaceResultStatus,
        outcome: delta.outcome,
        error: delta.error,
        hookFailures: delta.hookFailures,
      },
      createdAt: new Date(),
    });
  }

  private spaceLifecycleAuditEvent(
    type: 'space_enter' | 'space_exit',
    runId: string,
    workId: string,
    step: WorkStep,
    active: ActiveReply,
  ) {
    const state = this.stepById.get(step.id);
    return {
      id: `${runId}:${workId}:${step.id}:${type}`,
      type,
      runId,
      workId,
      workStepId: step.id,
      threadId: active.threadId,
      sessionId: state?.sessionId ?? (type === 'space_enter' && toCanonicalSpaceId(step.workspaceId) === 'main' ? active.mainSessionId : undefined),
      createdAt: type === 'space_exit' ? (step.endedAt ?? new Date()) : step.startedAt,
      data: {
        status: step.status,
        workspaceId: toCanonicalSpaceId(step.workspaceId),
        runtimeWorkspaceId: step.workspaceId,
        toolCallCount: step.toolCalls.length,
        artifactCount: step.artifact ? 1 : 0,
        error: errorSummary(step.error),
        hookFailures: serializeStepHookFailures(step),
      },
    };
  }

  private async persistArtifact(
    store: ZleapStore,
    runId: string,
    workId: string,
    stepId: string,
    artifact: Artifact,
    active: ActiveReply,
  ): Promise<void> {
    const state = this.stepById.get(stepId);
    const producerSessionId = state?.sessionId ?? active.mainSessionId;
    const workspaceResult = readWorkspaceResult(artifact.data);
    await store.ledger.saveArtifact({
      ...artifact,
      runId,
      workId,
      workStepId: stepId,
      threadId: active.threadId,
      producerSessionId,
      targetSessionId: producerSessionId === active.mainSessionId ? undefined : active.mainSessionId,
      kind: 'workspace_result',
      status: artifactStorageStatus(workspaceResult?.status),
      content: artifact.summary,
    });
    await this.appendEntry(store, producerSessionId, {
      type: 'artifact',
      role: 'assistant',
      content: artifact.summary,
      runId,
      workId,
      workStepId: stepId,
      artifactId: artifact.id,
      data: entryData(payloadObject(artifact.data), {
        projectionKind: 'workspace_artifact',
        source: 'artifact_produced',
        sourceRefs: [{ table: 'artifacts', ids: [artifact.id] }],
      }),
    });
    if (producerSessionId !== active.mainSessionId) {
      await this.appendEntry(store, active.mainSessionId, {
        type: 'tool_result',
        role: 'tool',
        content: artifact.summary,
        runId,
        workId,
        workStepId: stepId,
        artifactId: artifact.id,
        data: entryData({
          sourceSessionId: producerSessionId,
          workspaceId: toCanonicalSpaceId(artifact.workspaceId),
          artifactId: artifact.id,
          artifactTitle: artifact.title,
          workspaceResultStatus: workspaceResult?.status,
        }, {
          projectionKind: 'artifact_handoff',
          source: 'artifact_produced',
          sourceRefs: [
            { table: 'artifacts', ids: [artifact.id] },
            { table: 'space_sessions', ids: [producerSessionId] },
          ],
        }),
      });
    }
  }

  private async appendEntry(
    store: ZleapStore,
    sessionId: string,
    entry: {
      type: 'message' | 'tool_call' | 'tool_result' | 'artifact' | 'capability_snapshot' | 'compaction';
      role?: 'system' | 'user' | 'assistant' | 'tool';
      content?: string;
      data?: unknown;
      runId?: string;
      workId?: string;
      workStepId?: string;
      toolCallId?: string;
      artifactId?: string;
    },
  ): Promise<string> {
    const id = `${sessionId}:entry:${randomUUID()}`;
    const record = await store.sessions.appendEntry({
      id,
      sessionId,
      parentEntryId: this.parentBySession.get(sessionId),
      ...entry,
      leafName: 'current',
    });
    this.parentBySession.set(sessionId, record.id);
    return record.id;
  }

  private runRecord(run: Run, active: ActiveReply) {
    return {
      id: run.id,
      avatarId: this.avatarId,
      avatarVersion: 1,
      threadId: active.threadId,
      mainSessionId: active.mainSessionId,
      status: run.status,
      goal: run.goal,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: errorSummary(run.error),
      metadata: {
        runtimeAgentId: run.agentId,
        runtimeSession: run.session,
      },
    };
  }

  private workRecord(runId: string, work: Work, active: ActiveReply) {
    return {
      id: work.id,
      runId,
      threadId: active.threadId,
      parentSessionId: active.mainSessionId,
      status: work.status,
      goal: work.goal,
      startedAt: work.startedAt,
      endedAt: work.endedAt,
      error: errorSummary(work.error),
      metadata: {
        runtimeAgentId: work.agentId,
        runtimeSession: work.session,
        spaces: work.spaces.map(toCanonicalSpaceId),
        skillIds: work.skillIds,
        toolIds: work.toolIds,
      },
    };
  }

  /** Spaces are global: the storage id IS the canonical slug (no avatar prefix). */
  private spaceStorageId(spaceId: string): string {
    return toCanonicalSpaceId(spaceId);
  }
}

function workspaceSessionId(threadId: string, canonicalSpaceId: string): string {
  return `${threadId}:${toCanonicalSpaceId(canonicalSpaceId)}`;
}

function sanitizeId(value: string): string {
  return value.trim().replace(/[^\w:.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user') {
      return typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    }
  }
  return '';
}

function metadataFromActor(actor: ActorContext | undefined): Record<string, string> {
  if (!actor) {
    return {};
  }
  return {
    userId: actor.userId,
    actorRole: actor.role,
    ...(actor.tenantId ? { tenantId: actor.tenantId } : {}),
  };
}

function metadataFromRuntime(input: { workspaceRoot?: string }): Record<string, string> {
  const workspaceRoot = normalizedWorkspaceRoot(input.workspaceRoot);
  return workspaceRoot ? { workspaceRoot } : {};
}

function normalizedWorkspaceRoot(workspaceRoot: string | undefined): string | undefined {
  const value = workspaceRoot?.trim();
  return value || undefined;
}

function entryData(data: Record<string, unknown>, projection: SessionEntryProjection): Record<string, unknown> {
  return {
    ...data,
    projectionKind: projection.projectionKind,
    source: projection.source,
    ...(projection.sourceRefs ? { sourceRefs: projection.sourceRefs } : {}),
  };
}

function serializeToolHookFailures(call: ToolCall): Array<{ phase: string; message: string; code?: string; occurredAt: string }> | undefined {
  if (!call.hookFailures?.length) {
    return undefined;
  }
  return call.hookFailures.map((failure) => ({
    phase: failure.phase,
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    occurredAt: failure.occurredAt.toISOString(),
  }));
}

function serializeStepHookFailures(step: WorkStep): Array<{ phase: string; message: string; code?: string; occurredAt: string }> | undefined {
  if (!step.hookFailures?.length) {
    return undefined;
  }
  return step.hookFailures.map((failure) => ({
    phase: failure.phase,
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    occurredAt: failure.occurredAt.toISOString(),
  }));
}

function payloadObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data === undefined ? {} : { payload: data };
  }
  return data as Record<string, unknown>;
}

function ownerFromActor(actor: ActorContext | undefined): { userId?: string; tenantId?: string } {
  return actor ? { userId: actor.userId, tenantId: actor.tenantId } : {};
}

const LOCAL_OWNER_USER_IDS = new Set([LOCAL_DEV_ACTOR_USER_ID, 'local-desktop-user']);
const LOCAL_OWNER_TENANT_IDS = new Set([LOCAL_DEV_ACTOR_TENANT_ID, 'local']);

function isLocalDevActor(actor: ActorContext | undefined): boolean {
  return Boolean(actor && LOCAL_OWNER_USER_IDS.has(actor.userId));
}

function sameOwnerUserId(recordUserId: string | undefined, actorUserId: string | undefined): boolean {
  if (!recordUserId || !actorUserId) {
    return false;
  }
  if (recordUserId === actorUserId) {
    return true;
  }
  return LOCAL_OWNER_USER_IDS.has(recordUserId) && LOCAL_OWNER_USER_IDS.has(actorUserId);
}

function sameOwnerTenantId(recordTenantId: string | undefined, actorTenantId: string | undefined): boolean {
  if (!recordTenantId || !actorTenantId) {
    return true;
  }
  if (recordTenantId === actorTenantId) {
    return true;
  }
  return LOCAL_OWNER_TENANT_IDS.has(recordTenantId) && LOCAL_OWNER_TENANT_IDS.has(actorTenantId);
}

function isLegacyImPlatformOwner(
  recordUserId: string | undefined,
  source: string | undefined,
  conversationId: string | undefined,
): boolean {
  if (!recordUserId || !source) {
    return false;
  }
  if (conversationId) {
    if (recordUserId === `${source}:${conversationId}`) {
      return true;
    }
    if (recordUserId === `${source}:${sanitizeId(conversationId)}`) {
      return true;
    }
  }
  // Older gateway builds stored `${channel}:${senderOpenId}` as the thread owner.
  return recordUserId.startsWith(`${source}:`);
}

function recordBelongsToActor(
  record: { userId?: string; tenantId?: string; metadata?: Record<string, unknown> },
  actor: ActorContext | undefined,
  context?: { source?: string; conversationId?: string },
): boolean {
  if (!actor) {
    return true;
  }
  const recordUserId = record.userId ?? (typeof record.metadata?.userId === 'string' ? record.metadata.userId : undefined);
  const recordTenantId = record.tenantId ?? (typeof record.metadata?.tenantId === 'string' ? record.metadata.tenantId : undefined);

  if (isLocalDevActor(actor) && isLegacyImPlatformOwner(recordUserId, context?.source, context?.conversationId)) {
    return true;
  }

  // Legacy threads without owner metadata — single-user local dev may adopt them.
  if (!recordUserId) {
    return isLocalDevActor(actor);
  }

  if (!sameOwnerUserId(recordUserId, actor.userId)) {
    return false;
  }

  return sameOwnerTenantId(recordTenantId, actor.tenantId);
}

function isThreadForbiddenError(error: unknown): boolean {
  return error instanceof Error && error.message === 'thread_forbidden';
}

function readWorkspaceResult(data: unknown): WorkspaceResult | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const result = (data as { workspaceResult?: unknown }).workspaceResult;
  return result && typeof result === 'object' ? (result as WorkspaceResult) : undefined;
}

function sessionStatusFromStep(step: WorkStep, workspaceResult?: WorkspaceResult): 'active' | 'suspended' | 'completed' | 'failed' {
  if (step.status === 'failed' || step.status === 'aborted' || workspaceResult?.status === 'failed') {
    return 'failed';
  }
  if (workspaceResult && workspaceResult.status !== 'completed') {
    return 'suspended';
  }
  if (step.status === 'exited') {
    return 'completed';
  }
  return 'active';
}

function truncateMetadataText(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function artifactStorageStatus(status: WorkspaceResultStatus | undefined): 'success' | 'failed' | 'partial' {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return status ? 'partial' : 'success';
}

function errorSummary(error: unknown) {
  return summarizeError(error);
}

function truncateFailureMessage(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function defaultOnFailure(failure: DurableProjectionFailure): void {
  const where = failure.operation ? `${failure.phase}/${failure.operation}` : failure.phase;
  process.stderr.write(`[persistence] ${where} failed: ${failure.message}\n`);
}

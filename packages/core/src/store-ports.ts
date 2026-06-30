import type {
  ArtifactReferenceRecord,
  AvatarRecord,
  AvatarVersionRecord,
  CapabilityDefinitionRecord,
  CapabilityOrigin,
  DurableArtifactRecord,
  GatewayIntegrationRecord,
  LedgerEventRecord,
  McpServerRecord,
  McpToolDefinitionRecord,
  ModelConfigRecord,
  RuntimeCacheEntryRecord,
  RunRecord,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskRunStatus,
  SessionEntryRecord,
  SessionLeafRecord,
  SkillDefinitionRecord,
  SpaceCapabilityBindingRecord,
  SpaceCapabilitySnapshot,
  SpaceRecord,
  SpaceSessionRecord,
  SpaceStatus,
  SpaceVersionRecord,
  ThreadRecord,
  ThreadStatus,
  WorkRecord,
  WorkStepRecord,
} from './records.js';

/**
 * Storage ports for the Super Agent domain model. A concrete adapter (SQLite,
 * Postgres, …) implements `SuperAgentStorageAdapter`; the runtime only depends
 * on these interfaces, never on a specific database.
 */

export type TransactionRunner = <T>(operation: (tx: SuperAgentStorageAdapter) => Promise<T>) => Promise<T>;

export type CreateThreadInput = Omit<ThreadRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: Date;
  updatedAt?: Date;
};

export type CreateSpaceSessionInput = Omit<SpaceSessionRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: Date;
  updatedAt?: Date;
};

export type AppendSessionEntryInput = Omit<SessionEntryRecord, 'createdAt'> & {
  createdAt?: Date;
  leafName?: string;
};

export type SessionEntryVisibility = 'active' | 'audit';

export type BuildConversationInput = {
  sessionId: string;
  leafEntryId?: string;
  leafName?: string;
  avatarId?: string;
  userId?: string;
  tenantId?: string;
  visibility?: SessionEntryVisibility;
  limit?: number;
};

export type ListSessionEntriesInput = {
  sessionId: string;
  leafEntryId?: string;
  leafName?: string;
  /** Return entries older than this session entry id. */
  beforeEntryId?: string;
  avatarId?: string;
  userId?: string;
  tenantId?: string;
  type?: SessionEntryRecord['type'];
  projectionKind?: string;
  visibility?: SessionEntryVisibility;
  limit?: number;
};

export type DeleteSessionEntryInput = {
  sessionId: string;
  entryId: string;
  userId?: string;
  tenantId?: string;
};

export type ListSpaceSessionsInput = {
  threadId?: string;
  parentSessionId?: string;
  avatarId?: string;
  userId?: string;
  tenantId?: string;
  kind?: SpaceSessionRecord['kind'];
  status?: SpaceSessionRecord['status'] | SpaceSessionRecord['status'][];
  limit?: number;
};

export type CreateScheduledTaskInput = Omit<ScheduledTaskRecord, 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  createdAt?: Date;
  updatedAt?: Date;
};

export type UpdateScheduledTaskInput = Partial<
  Pick<
    ScheduledTaskRecord,
    | 'name'
    | 'type'
    | 'prompt'
    | 'payload'
    | 'cron'
    | 'timezone'
    | 'enabled'
    | 'avatarId'
    | 'permissionMode'
  >
> & {
  projectId?: string | null;
  conversationId?: string | null;
  modelConfigId?: string | null;
  targetSpace?: string | null;
};

export type ListScheduledTasksInput = {
  userId?: string;
  tenantId?: string;
  includeDeleted?: boolean;
  enabled?: boolean;
  limit?: number;
};

export type CreateScheduledTaskRunInput = Omit<ScheduledTaskRunRecord, 'startedAt' | 'finishedAt'> & {
  startedAt?: Date;
  finishedAt?: Date;
};

export type UpdateScheduledTaskRunInput = Partial<
  Pick<
    ScheduledTaskRunRecord,
    'queueJobId' | 'status' | 'scheduledFor' | 'startedAt' | 'finishedAt' | 'conversationId' | 'agentRunId' | 'summary' | 'error' | 'metadata'
  >
>;

export type ListScheduledTaskRunsInput = {
  taskId: string;
  userId?: string;
  tenantId?: string;
  status?: ScheduledTaskRunStatus | ScheduledTaskRunStatus[];
  limit?: number;
  offset?: number;
};

export type BuiltConversationMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  data?: unknown;
};

export interface AvatarConfigStore {
  saveAvatar(record: AvatarRecord): Promise<void>;
  saveAvatarVersion(record: AvatarVersionRecord): Promise<void>;
  getAvatar(id: string): Promise<AvatarRecord | undefined>;
  getAvatarVersion(avatarId: string, version?: number): Promise<AvatarVersionRecord | undefined>;
  listAvatars(input?: { status?: AvatarRecord['status']; limit?: number }): Promise<AvatarRecord[]>;
}

export interface SpaceConfigStore {
  saveSpace(record: SpaceRecord): Promise<void>;
  saveSpaceVersion(record: SpaceVersionRecord): Promise<void>;
  saveCapability(record: CapabilityDefinitionRecord): Promise<void>;
  bindCapability(record: SpaceCapabilityBindingRecord): Promise<void>;
  getSpace(id: string): Promise<SpaceRecord | undefined>;
  /** All global spaces (the dispatch catalog source). */
  listSpaces(input?: { status?: SpaceStatus; limit?: number }): Promise<SpaceRecord[]>;
  getSpaceVersion(spaceId: string, version?: number): Promise<SpaceVersionRecord | undefined>;
  listCapabilityBindings(input: { spaceId: string; version?: number }): Promise<SpaceCapabilityBindingRecord[]>;
  getSpaceSnapshot(input: { avatarId: string; spaceId: string; version?: number }): Promise<SpaceCapabilitySnapshot>;
}

export interface ModelConfigStore {
  saveModelConfig(record: ModelConfigRecord): Promise<void>;
  getModelConfig(id: string): Promise<ModelConfigRecord | undefined>;
  listModelConfigs(input?: { purpose?: ModelConfigRecord['purpose']; limit?: number }): Promise<ModelConfigRecord[]>;
  deleteModelConfig(id: string): Promise<void>;
}

export interface SkillConfigStore {
  saveSkill(record: SkillDefinitionRecord): Promise<void>;
  getSkill(id: string, version?: number): Promise<SkillDefinitionRecord | undefined>;
  listSkills(input?: {
    origin?: CapabilityOrigin;
    sourceType?: SkillDefinitionRecord['sourceType'];
    trustStatus?: SkillDefinitionRecord['trustStatus'];
    limit?: number;
  }): Promise<SkillDefinitionRecord[]>;
  deleteSkill(id: string, version?: number): Promise<void>;
}

export interface McpConfigStore {
  saveServer(record: McpServerRecord): Promise<void>;
  getServer(id: string, input?: { userId?: string; tenantId?: string }): Promise<McpServerRecord | undefined>;
  listServers(input?: { status?: McpServerRecord['status']; userId?: string; tenantId?: string; limit?: number }): Promise<McpServerRecord[]>;
  deleteServer(id: string, input?: { userId?: string; tenantId?: string }): Promise<void>;
  saveTool(record: McpToolDefinitionRecord): Promise<void>;
  getTool(id: string, version?: number): Promise<McpToolDefinitionRecord | undefined>;
  listTools(input?: { serverId?: string; limit?: number }): Promise<McpToolDefinitionRecord[]>;
  /** Drop a cached tool snapshot — used by discovery reconcile when a server no
   *  longer exposes a tool. Dangling space bindings are skipped at runtime. */
  deleteTool(id: string, version?: number): Promise<void>;
}

export interface GatewayIntegrationStore {
  getIntegration(channel: string): Promise<GatewayIntegrationRecord | undefined>;
  saveIntegration(record: GatewayIntegrationRecord): Promise<void>;
  deleteIntegration(channel: string): Promise<void>;
}

export interface ThreadStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getThread(id: string, input?: { userId?: string; tenantId?: string }): Promise<ThreadRecord | undefined>;
  listThreads(input?: { avatarId?: string; status?: ThreadStatus; userId?: string; tenantId?: string; limit?: number }): Promise<ThreadRecord[]>;
  deleteThread(id: string, input?: { userId?: string; tenantId?: string }): Promise<boolean>;
}

export interface SpaceSessionStore {
  createSession(input: CreateSpaceSessionInput): Promise<SpaceSessionRecord>;
  getSession(id: string, input?: { avatarId?: string; userId?: string; tenantId?: string }): Promise<SpaceSessionRecord | undefined>;
  appendEntry(input: AppendSessionEntryInput): Promise<SessionEntryRecord>;
  deleteEntry(input: DeleteSessionEntryInput): Promise<boolean>;
  setLeaf(input: SessionLeafRecord): Promise<void>;
  listSessions(input?: ListSpaceSessionsInput): Promise<SpaceSessionRecord[]>;
  listEntries(input: ListSessionEntriesInput): Promise<SessionEntryRecord[]>;
  buildConversation(input: BuildConversationInput): Promise<BuiltConversationMessage[]>;
  buildSessionContext(input: BuildConversationInput): Promise<BuiltConversationMessage[]>;
}

export interface RuntimeLedgerStore {
  saveRun(record: RunRecord): Promise<void>;
  saveWork(record: WorkRecord): Promise<void>;
  saveWorkStep(record: WorkStepRecord): Promise<void>;
  saveEvent(record: LedgerEventRecord): Promise<void>;
  listEvents(input?: {
    runId?: string;
    workId?: string;
    workStepId?: string;
    threadId?: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    type?: string;
    limit?: number;
  }): Promise<LedgerEventRecord[]>;
  saveArtifact(record: DurableArtifactRecord): Promise<void>;
  getArtifact(id: string, input?: { userId?: string; tenantId?: string }): Promise<DurableArtifactRecord | undefined>;
  saveArtifactReference(record: ArtifactReferenceRecord): Promise<void>;
  saveCapabilitySnapshot(record: SpaceCapabilitySnapshot): Promise<void>;
}

export type RuntimeCacheListInput = {
  userId?: string;
  agentId?: string;
  threadId?: string;
  conversationId?: string;
  runId?: string;
  workspaceId?: string;
  limit?: number;
};

export interface RuntimeCacheStore {
  saveEntry(record: RuntimeCacheEntryRecord): Promise<void>;
  listEntries(input?: RuntimeCacheListInput): Promise<RuntimeCacheEntryRecord[]>;
  getEntry(input: {
    id: string;
    userId?: string;
    agentId?: string;
    threadId?: string;
    conversationId?: string;
  }): Promise<RuntimeCacheEntryRecord | undefined>;
  deleteByThread(input: { threadId: string; userId?: string; agentId?: string }): Promise<void>;
}

export interface ScheduledTaskStore {
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  updateTask(id: string, patch: UpdateScheduledTaskInput, owner?: { userId?: string; tenantId?: string }): Promise<ScheduledTaskRecord>;
  getTask(id: string, owner?: { userId?: string; tenantId?: string; includeDeleted?: boolean }): Promise<ScheduledTaskRecord | undefined>;
  listTasks(input?: ListScheduledTasksInput): Promise<ScheduledTaskRecord[]>;
  softDeleteTask(id: string, owner?: { userId?: string; tenantId?: string }): Promise<void>;
  createRun(input: CreateScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  updateRun(id: string, patch: UpdateScheduledTaskRunInput): Promise<ScheduledTaskRunRecord>;
  getRun(id: string): Promise<ScheduledTaskRunRecord | undefined>;
  listRuns(input: ListScheduledTaskRunsInput): Promise<ScheduledTaskRunRecord[]>;
  /**
   * Fail audit rows stuck in `running` longer than `olderThanSeconds` (orphaned
   * by a crashed worker). Returns the number of reclaimed rows. Concurrency is
   * owned by pg-boss; this only repairs the audit projection.
   */
  reclaimStaleRuns(olderThanSeconds: number): Promise<number>;
}

export interface SuperAgentStorageAdapter {
  transaction: TransactionRunner;
  avatars: AvatarConfigStore;
  spaces: SpaceConfigStore;
  models: ModelConfigStore;
  skills: SkillConfigStore;
  mcp: McpConfigStore;
  threads: ThreadStore;
  sessions: SpaceSessionStore;
  ledger: RuntimeLedgerStore;
  runtimeCache: RuntimeCacheStore;
  tasks: ScheduledTaskStore;
  close(): Promise<void>;
}

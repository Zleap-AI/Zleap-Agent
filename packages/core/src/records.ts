import type {
  Artifact,
  MemoryPersistencePolicy,
  RuntimeCacheKind,
  RunStatus,
  SkillFrontmatter,
  SkillInvocationPolicy,
  SkillPackageFile,
  SkillRiskAudit,
  SkillSourceType,
  SkillTrustStatus,
  WorkStatus,
  WorkStepStatus,
} from './types.js';

/**
 * The Super Agent persistence domain model: every durable record the
 * configuration + runtime + memory closures read and write. These are the
 * TypeScript shape of the storage schema (see @zleap/store), kept decoupled
 * from any concrete adapter so the model can be reused across SQLite/PG.
 */

export type AvatarStatus = 'active' | 'archived';

export type SpaceKind = 'main' | 'work';

export type SpaceStatus = 'active' | 'archived' | 'disabled';

export type CapabilityType =
  | 'tool'
  | 'skill'
  | 'mcp_server'
  | 'mcp_tool'
  | 'model'
  | 'summary_model'
  | 'memory_policy'
  | 'permission_policy'
  | 'retriever'
  | 'evaluator'
  | 'sandbox'
  | 'notifier';

export type CapabilityOrigin = 'builtin' | 'project' | 'user' | 'runtime' | 'mcp' | 'plugin';

export type SpaceSessionKind = 'main' | 'work';

export type SpaceSessionStatus = 'active' | 'suspended' | 'completed' | 'failed' | 'archived';

export type SessionEntryType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'compaction'
  | 'branch_summary'
  | 'model_change'
  | 'capability_snapshot'
  | 'custom';

export type ThreadStatus = 'active' | 'archived';

export type ScheduledTaskRunTrigger = 'manual' | 'scheduled';

export type ScheduledTaskRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export type SecretRef = {
  provider: 'env' | 'keychain' | 'vault' | 'custom';
  key: string;
  metadata?: Record<string, unknown>;
};

export type AvatarRecord = {
  id: string;
  userId?: string;
  slug: string;
  name: string;
  currentVersion: number;
  status: AvatarStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type AvatarVersionRecord = {
  avatarId: string;
  version: number;
  name: string;
  description?: string;
  persona?: string;
  modelConfigId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

/** A space is a GLOBAL capability unit (not owned by any avatar). Its id is the
 *  slug (`main` / `explore` / …). See docs/core.md §3. */
export type SpaceRecord = {
  id: string;
  slug: string;
  kind: SpaceKind;
  currentVersion: number;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type SpaceVersionRecord = {
  spaceId: string;
  version: number;
  label: string;
  description?: string;
  routingCard?: string;
  instructions?: string;
  modelConfigId?: string;
  summaryModelConfigId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type CapabilityDefinitionRecord = {
  id: string;
  type: CapabilityType;
  version: number;
  origin: CapabilityOrigin;
  label?: string;
  description?: string;
  descriptor?: unknown;
  schemaHash?: string;
  implementationRef?: string;
  createdAt: Date;
};

export type SpaceCapabilityBindingRecord = {
  id: string;
  spaceId: string;
  spaceVersion: number;
  capabilityType: CapabilityType;
  capabilityId: string;
  capabilityVersion?: number;
  enabled: boolean;
  config?: Record<string, unknown>;
  orderIndex: number;
  createdAt: Date;
};

export type ScheduledTaskRecord = {
  id: string;
  userId?: string;
  tenantId?: string;
  avatarId: string;
  projectId?: string;
  conversationId?: string;
  modelConfigId?: string;
  permissionMode: 'request_approval' | 'full_access';
  targetSpace?: string;
  name: string;
  /** Handler type that runs this task. Defaults to 'agent'. */
  type: string;
  prompt: string;
  /** Handler-specific configuration (non-agent task types read from here). */
  payload?: Record<string, unknown>;
  cron: string;
  timezone: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type ScheduledTaskRunRecord = {
  id: string;
  taskId: string;
  queueJobId?: string;
  trigger: ScheduledTaskRunTrigger;
  status: ScheduledTaskRunStatus;
  scheduledFor?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  conversationId?: string;
  agentRunId?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type ModelConfigRecord = {
  id: string;
  providerId: string;
  model: string;
  purpose: 'main' | 'workspace' | 'summary' | 'embedding' | 'evaluation' | 'custom';
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * IM gateway channel credentials/config (e.g. Feishu app_id/app_secret), keyed
 * by channel. Read data-first by the gateway worker at startup; edited via the
 * web settings UI. Secrets are redacted on API read, not at the storage layer.
 */
export type GatewayIntegrationRecord = {
  /** Channel id, e.g. 'feishu'. */
  channel: string;
  /** Channel-specific config blob (appId/appSecret/domain/groupPolicy/...). */
  config: Record<string, unknown>;
  updatedAt: Date;
};

export type McpServerRecord = {
  id: string;
  userId?: string;
  tenantId?: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  config?: Record<string, unknown>;
  secretRefs?: SecretRef[];
  status: 'active' | 'disabled' | 'error';
  createdAt: Date;
  updatedAt: Date;
};

export const REDACTED_SECRET_VALUE = '[redacted]';

const SECRET_CONFIG_KEY = /(?:secret|token|password|credential|authorization|bearer|api[_-]?key)/i;

export function redactMcpServerRecord(record: McpServerRecord): McpServerRecord {
  return {
    ...record,
    config: redactMcpConfig(record.config),
    secretRefs: record.secretRefs?.map((ref) => ({ ...ref })),
  };
}

function redactMcpConfig(value: unknown, keyPath: string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return redactObject(value as Record<string, unknown>, keyPath);
}

function redactObject(value: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...keyPath, key];
    output[key] = shouldRedactMcpConfigValue(nextPath) ? REDACTED_SECRET_VALUE : redactUnknown(child, nextPath);
  }
  return output;
}

function redactUnknown(value: unknown, keyPath: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, keyPath));
  }
  if (value && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, keyPath);
  }
  return value;
}

function shouldRedactMcpConfigValue(keyPath: string[]): boolean {
  const key = keyPath.at(-1) ?? '';
  return keyPath.includes('env') || SECRET_CONFIG_KEY.test(key);
}

export type McpToolDefinitionRecord = {
  id: string;
  serverId: string;
  name: string;
  version: number;
  label?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  createdAt: Date;
};

export type SkillDefinitionRecord = {
  id: string;
  version: number;
  origin: CapabilityOrigin;
  label: string;
  description?: string;
  instructions?: string;
  toolIds: string[];
  metadata?: Record<string, unknown>;
  sourceType?: SkillSourceType;
  sourcePath?: string;
  packageRoot?: string;
  sourceName?: string;
  frontmatter?: SkillFrontmatter;
  body?: string;
  files?: SkillPackageFile[];
  openaiConfig?: Record<string, unknown>;
  claudeConfig?: Record<string, unknown>;
  license?: string;
  compatibility?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  invocationPolicy?: SkillInvocationPolicy;
  trustStatus?: SkillTrustStatus;
  riskAudit?: SkillRiskAudit;
  schemaHash?: string;
  updatedAt?: Date;
  createdAt: Date;
};

export type ThreadRecord = {
  id: string;
  avatarId: string;
  userId?: string;
  tenantId?: string;
  title?: string;
  mainSessionId?: string;
  status: ThreadStatus;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
};

export type SpaceSessionRecord = {
  id: string;
  threadId: string;
  avatarId: string;
  userId?: string;
  tenantId?: string;
  spaceId: string;
  kind: SpaceSessionKind;
  parentSessionId?: string;
  rootGoal?: string;
  task?: string;
  status: SpaceSessionStatus;
  currentLeafEntryId?: string;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
};

export type SessionEntryRecord = {
  id: string;
  sessionId: string;
  parentEntryId?: string;
  type: SessionEntryType;
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  data?: unknown;
  runId?: string;
  workId?: string;
  workStepId?: string;
  toolCallId?: string;
  artifactId?: string;
  tokenCount?: number;
  createdAt: Date;
  deletedAt?: Date;
};

export type SessionLeafRecord = {
  sessionId: string;
  name: string;
  entryId?: string;
  updatedAt: Date;
};

export type ArtifactReferenceRecord = {
  id: string;
  artifactId: string;
  kind: 'file' | 'url' | 'artifact' | 'memory' | 'custom';
  uri?: string;
  title?: string;
  data?: unknown;
  sourceSessionId?: string;
  createdAt: Date;
};

export type DurableArtifactRecord = Artifact & {
  runId: string;
  workId?: string;
  workStepId?: string;
  threadId: string;
  producerSessionId: string;
  targetSessionId?: string;
  kind: string;
  status: 'success' | 'failed' | 'partial';
  content?: string;
  contentUri?: string;
};

export type RuntimeCacheEntryRecord = {
  id: string;
  userId?: string;
  agentId?: string;
  threadId?: string;
  conversationId?: string;
  runId?: string;
  workId?: string;
  stepId?: string;
  workspaceId?: string;
  toolCallId?: string;
  toolId?: string;
  kind: RuntimeCacheKind;
  title: string;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;
};

export type CapabilitySnapshotItem = {
  type: CapabilityType;
  id: string;
  version?: number;
  schemaHash?: string;
  descriptorSummary?: string;
  mcpServerId?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
};

export type SpaceCapabilitySnapshot = {
  id: string;
  avatarId: string;
  avatarVersion: number;
  spaceId: string;
  spaceVersion: number;
  modelConfigId?: string;
  summaryModelConfigId?: string;
  capabilities: CapabilitySnapshotItem[];
  memoryPolicy?: MemoryPersistencePolicy;
  permissionPolicy?: Record<string, unknown>;
  createdAt: Date;
};

export type RunRecord = {
  id: string;
  avatarId: string;
  avatarVersion: number;
  threadId?: string;
  mainSessionId?: string;
  status: RunStatus;
  goal: string;
  startedAt: Date;
  endedAt?: Date;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

export type WorkRecord = {
  id: string;
  runId: string;
  threadId?: string;
  parentSessionId?: string;
  status: WorkStatus;
  goal: string;
  startedAt: Date;
  endedAt?: Date;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

export type WorkStepRecord = {
  id: string;
  workId: string;
  workspaceId: string;
  sessionId?: string;
  status: WorkStepStatus;
  startedAt?: Date;
  endedAt?: Date;
  error?: unknown;
  capabilitySnapshotId?: string;
  metadata?: Record<string, unknown>;
};

export type LedgerEventRecord = {
  id: string;
  runId?: string;
  workId?: string;
  workStepId?: string;
  threadId?: string;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  type: string;
  data?: unknown;
  createdAt: Date;
};

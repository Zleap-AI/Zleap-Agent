import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  DEFAULT_AGENT_NOTE_LIMIT,
  buildConversationFromEntries,
  buildSessionContextFromEntries as projectSessionContextFromEntries,
} from '@zleap/core';
import type {
  AgentNote,
  AgentNoteKind,
  AgentNoteScope,
  AgentNoteStatus,
  AgentNoteStore,
  AppendSessionEntryInput,
  ArtifactReferenceRecord,
  AvatarConfigStore,
  AvatarRecord,
  AvatarVersionRecord,
  CapabilityDefinitionRecord,
  CreateSpaceSessionInput,
  CreateThreadInput,
  DurableArtifactRecord,
  GatewayIntegrationRecord,
  GatewayIntegrationStore,
  LedgerEventRecord,
  McpConfigStore,
  McpServerRecord,
  McpToolDefinitionRecord,
  ModelConfigRecord,
  ModelConfigStore,
  RuntimeCacheEntryRecord,
  RuntimeCacheStore,
  RuntimeLedgerStore,
  RuntimePersistence,
  RunRecord,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskStore,
  Session,
  SessionEntryRecord,
  SessionLeafRecord,
  SkillConfigStore,
  SkillDefinitionRecord,
  SpaceCapabilityBindingRecord,
  SpaceCapabilitySnapshot,
  SpaceConfigStore,
  SpaceRecord,
  SpaceSessionRecord,
  SpaceSessionStore,
  SpaceVersionRecord,
  SuperAgentStorageAdapter,
  ThreadRecord,
  ThreadStore,
  WorkRecord,
  WorkStepRecord,
} from '@zleap/core';
import { schemaSql } from './schema.js';
import { mergeRrfRankings, type RrfContribution } from './core/rrf.js';
import { normalizeEntityName } from './core/types.js';
import type {
  CoreEntityRef,
  CoreEvent,
  CoreEventDetail,
  CoreEventStatus,
  CoreSource,
  CoreStore,
  RecallHit,
} from './core/types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
type PgQueryable = Pick<PgPool, 'query'>;

/** Batch embedder the store uses to vectorize memory text and recall queries. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export type StoreConfig = {
  connectionString: string;
  /** Embedding vector dimension — must match both the embedder and the schema. */
  dimension: number;
  embed: Embedder;
};

/** Durable persistence + vector recall backed by Postgres + pgvector. */
export interface ZleapStore extends RuntimePersistence, SuperAgentStorageAdapter {
  /** A 线 · agent_memory 对人笔记；experience kind only exists for legacy compatibility. */
  readonly notes: AgentNoteStore;
  /** B 线 · core 事件图引擎 (docs/store.md §3) — source/event/entity. */
  readonly core: CoreStore;
  /** IM gateway channel credentials/config (e.g. Feishu), keyed by channel. */
  readonly integrations: GatewayIntegrationStore;
  /** Embed one text with the store's configured embedder (for the memory service). */
  embedText(text: string): Promise<number[]>;
  readonly runtimeCache: RuntimeCacheStore;
  readonly tasks: ScheduledTaskStore;
  saveSession(session: Session): Promise<void>;
  touchSession(sessionId: string, runId: string, updatedAt: Date): Promise<void>;
  listArtifacts(input?: number | { userId?: string; tenantId?: string; limit?: number }): Promise<DurableArtifactRecord[]>;
  close(): Promise<void>;
}

export { buildSessionContextFromEntries } from '@zleap/core';

/**
 * Connect, ensure the schema exists, and return a store — or `null` if the
 * database is unreachable / unprovisionable, so the CLI degrades to in-memory.
 */
/** Fixed advisory-lock key serializing schema bootstrap across concurrent
 *  connects (multiple createStore calls otherwise race on CREATE INDEX). */
const SCHEMA_BOOTSTRAP_LOCK = 0x7a1ea9; // "zleap"

export async function createStore(config: StoreConfig): Promise<ZleapStore | null> {
  // Fail fast on an unreachable DB so the CLI degrades to in-memory instead of hanging.
  const pool = new Pool({ connectionString: config.connectionString, max: 4, connectionTimeoutMillis: 3000 });
  try {
    // Run the DDL under a session advisory lock on a single client so two
    // concurrent bootstraps can't race on `CREATE [UNIQUE] INDEX IF NOT EXISTS`
    // (Postgres can still throw "tuple concurrently updated" on the catalog).
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_BOOTSTRAP_LOCK]);
      try {
        await client.query(schemaSql(config.dimension));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_BOOTSTRAP_LOCK]).catch(() => { });
      }
    } finally {
      client.release();
    }
    return new PgStore(pool, config.dimension, config.embed);
  } catch {
    await pool.end().catch(() => { });
    return null;
  }
}

function toVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

function appendOwnerFilters(
  filters: string[],
  params: unknown[],
  query: { userId?: string; tenantId?: string },
): void {
  if (query.userId) {
    params.push(query.userId);
    const userParam = `$${params.length}`;
    filters.push(`(user_id = ${userParam} OR (user_id IS NULL AND metadata->>'userId' = ${userParam}))`);
  }
  if (query.tenantId) {
    params.push(query.tenantId);
    const tenantParam = `$${params.length}`;
    filters.push(`(tenant_id = ${tenantParam} OR (tenant_id IS NULL AND metadata->>'tenantId' = ${tenantParam}))`);
  }
}

function maybeDate(value: unknown): Date | undefined {
  return value ? new Date(value as string) : undefined;
}

function maybeString(value: unknown): string | undefined {
  return (value as string | null) ?? undefined;
}

function jsonParam(value: unknown): unknown {
  return value === undefined ? null : JSON.stringify(jsonSafeValue(value));
}

function jsonSafeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return jsonSafeString(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafeValue(item, seen) ?? null);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const safe = jsonSafeValue(item, seen);
    if (safe !== undefined) {
      output[jsonSafeString(key)] = safe;
    }
  }
  seen.delete(value);
  return output;
}

function jsonSafeString(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '�');
}

function assertLedgerUpsertApplied(rowCount: number | null, table: string, id: string): void {
  if (!rowCount) {
    throw new Error(`Durable ledger ${table} id conflict for ${id}`);
  }
}

function rowJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

const MCP_SECRET_CONFIG_KEY = /(?:secret|token|password|credential|authorization|bearer|api[_-]?key)/i;

export function sanitizeMcpConfigForStorage(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return pruneEmptyObject(sanitizeMcpConfigObject(value, []));
}

function sanitizeMcpConfigObject(value: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...keyPath, key];
    if (shouldStripMcpConfigValue(nextPath)) {
      continue;
    }
    const sanitized = sanitizeMcpConfigValue(child, nextPath);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }
  return output;
}

function sanitizeMcpConfigValue(value: unknown, keyPath: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMcpConfigValue(item, keyPath)).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    return pruneEmptyObject(sanitizeMcpConfigObject(value, keyPath));
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pruneEmptyObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(value).length ? value : undefined;
}

function shouldStripMcpConfigValue(keyPath: string[]): boolean {
  // `config.env` holds stdio env vars (often API keys); keep them for runtime spawn.
  if (keyPath[0] === 'env') {
    return false;
  }
  const key = keyPath[keyPath.length - 1] ?? '';
  return MCP_SECRET_CONFIG_KEY.test(key);
}

function rowToAvatar(row: Record<string, unknown>): AvatarRecord {
  return {
    id: String(row.id),
    userId: maybeString(row.user_id),
    slug: String(row.slug),
    name: String(row.name),
    currentVersion: Number(row.current_version),
    status: row.status as AvatarRecord['status'],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToAvatarVersion(row: Record<string, unknown>): AvatarVersionRecord {
  return {
    avatarId: String(row.avatar_id),
    version: Number(row.version),
    name: String(row.name),
    description: maybeString(row.description),
    persona: maybeString(row.persona),
    modelConfigId: maybeString(row.model_config_id),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
    createdAt: new Date(row.created_at as string),
  };
}

function rowToSpace(row: Record<string, unknown>): SpaceRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    kind: row.kind as SpaceRecord['kind'],
    currentVersion: Number(row.current_version),
    status: row.status as SpaceRecord['status'],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToSpaceVersion(row: Record<string, unknown>): SpaceVersionRecord {
  return {
    spaceId: String(row.space_id),
    version: Number(row.version),
    label: String(row.label),
    description: maybeString(row.description),
    routingCard: maybeString(row.routing_card),
    instructions: maybeString(row.instructions),
    modelConfigId: maybeString(row.model_config_id),
    summaryModelConfigId: maybeString(row.summary_model_config_id),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
    createdAt: new Date(row.created_at as string),
  };
}

function rowToSpaceCapabilityBinding(row: Record<string, unknown>): SpaceCapabilityBindingRecord {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    spaceVersion: Number(row.space_version),
    capabilityType: row.capability_type as SpaceCapabilityBindingRecord['capabilityType'],
    capabilityId: String(row.capability_id),
    capabilityVersion: row.capability_version === null || row.capability_version === undefined ? undefined : Number(row.capability_version),
    enabled: Boolean(row.enabled),
    config: rowJson<Record<string, unknown> | undefined>(row.config, undefined),
    orderIndex: Number(row.order_index),
    createdAt: new Date(row.created_at as string),
  };
}

function rowToModelConfig(row: Record<string, unknown>): ModelConfigRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    model: String(row.model),
    purpose: row.purpose as ModelConfigRecord['purpose'],
    config: rowJson<Record<string, unknown> | undefined>(row.config, undefined),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToGatewayIntegration(row: Record<string, unknown>): GatewayIntegrationRecord {
  return {
    channel: String(row.channel),
    config: rowJson<Record<string, unknown>>(row.config, {}),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToSkill(row: Record<string, unknown>): SkillDefinitionRecord {
  return {
    id: String(row.id),
    version: Number(row.version),
    origin: row.origin as SkillDefinitionRecord['origin'],
    label: String(row.label),
    description: maybeString(row.description),
    instructions: maybeString(row.instructions),
    toolIds: rowJson<string[]>(row.tool_ids, []),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
    sourceType: maybeString(row.source_type) as SkillDefinitionRecord['sourceType'],
    sourcePath: maybeString(row.source_path),
    packageRoot: maybeString(row.package_root),
    sourceName: maybeString(row.source_name),
    frontmatter: rowJson<SkillDefinitionRecord['frontmatter'] | undefined>(row.frontmatter, undefined),
    body: maybeString(row.body),
    files: rowJson<SkillDefinitionRecord['files'] | undefined>(row.files, undefined),
    openaiConfig: rowJson<SkillDefinitionRecord['openaiConfig'] | undefined>(row.openai_config, undefined),
    claudeConfig: rowJson<SkillDefinitionRecord['claudeConfig'] | undefined>(row.claude_config, undefined),
    license: maybeString(row.license),
    compatibility: rowJson<SkillDefinitionRecord['compatibility'] | undefined>(row.compatibility, undefined),
    allowedTools: rowJson<string[] | undefined>(row.allowed_tools, undefined),
    disallowedTools: rowJson<string[] | undefined>(row.disallowed_tools, undefined),
    invocationPolicy: maybeString(row.invocation_policy) as SkillDefinitionRecord['invocationPolicy'],
    trustStatus: maybeString(row.trust_status) as SkillDefinitionRecord['trustStatus'],
    riskAudit: rowJson<SkillDefinitionRecord['riskAudit'] | undefined>(row.risk_audit, undefined),
    schemaHash: maybeString(row.schema_hash),
    createdAt: new Date(row.created_at as string),
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : undefined,
  };
}

function rowToMcpServer(row: Record<string, unknown>): McpServerRecord {
  const config = sanitizeMcpConfigForStorage(rowJson<Record<string, unknown> | undefined>(row.config, undefined));
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : undefined,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    name: String(row.name),
    transport: row.transport as McpServerRecord['transport'],
    config,
    secretRefs: rowJson<McpServerRecord['secretRefs'] | undefined>(row.secret_refs, undefined),
    status: row.status as McpServerRecord['status'],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToMcpTool(row: Record<string, unknown>): McpToolDefinitionRecord {
  return {
    id: String(row.id),
    serverId: String(row.server_id),
    name: String(row.name),
    version: Number(row.version),
    label: maybeString(row.label),
    description: maybeString(row.description),
    inputSchema: rowJson<unknown | undefined>(row.input_schema, undefined),
    outputSchema: rowJson<unknown | undefined>(row.output_schema, undefined),
    createdAt: new Date(row.created_at as string),
  };
}

function rowToThread(row: Record<string, unknown>): ThreadRecord {
  return {
    id: String(row.id),
    avatarId: String(row.avatar_id),
    userId: maybeString(row.user_id),
    tenantId: maybeString(row.tenant_id),
    title: maybeString(row.title),
    mainSessionId: maybeString(row.main_session_id),
    status: row.status as ThreadRecord['status'],
    source: maybeString(row.source),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
  };
}

function rowToArtifact(row: Record<string, unknown>): DurableArtifactRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: maybeString(row.title) ?? '',
    summary: maybeString(row.summary) ?? '',
    data: rowJson<unknown>(row.data, undefined),
    createdAt: new Date(row.created_at as string),
    runId: String(row.run_id),
    workId: maybeString(row.work_id),
    workStepId: maybeString(row.work_step_id),
    threadId: String(row.thread_id),
    producerSessionId: String(row.producer_session_id),
    targetSessionId: maybeString(row.target_session_id),
    kind: String(row.kind),
    status: row.status as DurableArtifactRecord['status'],
    content: maybeString(row.content),
    contentUri: maybeString(row.content_uri),
  };
}

function rowToRuntimeCacheEntry(row: Record<string, unknown>): RuntimeCacheEntryRecord {
  return {
    id: String(row.id),
    userId: maybeString(row.user_id),
    agentId: maybeString(row.agent_id),
    threadId: maybeString(row.thread_id),
    conversationId: maybeString(row.conversation_id),
    runId: maybeString(row.run_id),
    workId: maybeString(row.work_id),
    stepId: maybeString(row.step_id),
    workspaceId: maybeString(row.workspace_id),
    toolCallId: maybeString(row.tool_call_id),
    toolId: maybeString(row.tool_id),
    kind: String(row.kind) as RuntimeCacheEntryRecord['kind'],
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
    createdAt: new Date(row.created_at as string),
    expiresAt: maybeDate(row.expires_at),
  };
}

function rowToSpaceSession(row: Record<string, unknown>): SpaceSessionRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    avatarId: String(row.avatar_id),
    userId: maybeString(row.user_id),
    tenantId: maybeString(row.tenant_id),
    spaceId: String(row.space_id),
    kind: row.kind as SpaceSessionRecord['kind'],
    parentSessionId: maybeString(row.parent_session_id),
    rootGoal: maybeString(row.root_goal),
    task: maybeString(row.task),
    status: row.status as SpaceSessionRecord['status'],
    currentLeafEntryId: maybeString(row.current_leaf_entry_id),
    source: maybeString(row.source),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
  };
}

function rowToSessionEntry(row: Record<string, unknown>): SessionEntryRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    parentEntryId: maybeString(row.parent_entry_id),
    type: row.type as SessionEntryRecord['type'],
    role: (row.role as SessionEntryRecord['role'] | null) ?? undefined,
    content: maybeString(row.content),
    data: rowJson<unknown | undefined>(row.data, undefined),
    runId: maybeString(row.run_id),
    workId: maybeString(row.work_id),
    workStepId: maybeString(row.work_step_id),
    toolCallId: maybeString(row.tool_call_id),
    artifactId: maybeString(row.artifact_id),
    tokenCount: row.token_count === null || row.token_count === undefined ? undefined : Number(row.token_count),
    createdAt: new Date(row.created_at as string),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : undefined,
  };
}

function rowToLedgerEvent(row: Record<string, unknown>): LedgerEventRecord {
  return {
    id: String(row.id),
    runId: maybeString(row.run_id),
    workId: maybeString(row.work_id),
    workStepId: maybeString(row.work_step_id),
    threadId: maybeString(row.thread_id),
    sessionId: maybeString(row.session_id),
    userId: maybeString(row.user_id),
    tenantId: maybeString(row.tenant_id),
    type: String(row.type),
    data: rowJson<unknown | undefined>(row.data, undefined),
    createdAt: new Date(row.created_at as string),
  };
}

function rowToScheduledTask(row: Record<string, unknown>): ScheduledTaskRecord {
  return {
    id: String(row.id),
    userId: maybeString(row.user_id),
    tenantId: maybeString(row.tenant_id),
    avatarId: String(row.avatar_id),
    projectId: maybeString(row.project_id),
    conversationId: maybeString(row.conversation_id),
    modelConfigId: maybeString(row.model_config_id),
    permissionMode: row.permission_mode === 'full_access' ? 'full_access' : 'request_approval',
    targetSpace: maybeString(row.target_space),
    name: String(row.name),
    type: maybeString(row.task_type) ?? 'agent',
    prompt: String(row.prompt),
    payload: rowJson<Record<string, unknown> | undefined>(row.payload, undefined),
    cron: String(row.cron),
    timezone: String(row.timezone),
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    deletedAt: maybeDate(row.deleted_at),
  };
}

function rowToScheduledTaskRun(row: Record<string, unknown>): ScheduledTaskRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    queueJobId: maybeString(row.queue_job_id),
    trigger: row.trigger === 'scheduled' ? 'scheduled' : 'manual',
    status: isScheduledTaskRunStatus(row.status) ? row.status : 'failed',
    scheduledFor: maybeDate(row.scheduled_for),
    startedAt: maybeDate(row.started_at),
    finishedAt: maybeDate(row.finished_at),
    conversationId: maybeString(row.conversation_id),
    agentRunId: maybeString(row.agent_run_id),
    summary: maybeString(row.summary),
    error: maybeString(row.error),
    metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
  };
}

function isScheduledTaskRunStatus(value: unknown): value is ScheduledTaskRunRecord['status'] {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'skipped';
}

class PgStore implements ZleapStore {
  readonly avatars: AvatarConfigStore;
  readonly spaces: SpaceConfigStore;
  readonly models: ModelConfigStore;
  readonly skills: SkillConfigStore;
  readonly mcp: McpConfigStore;
  readonly threads: ThreadStore;
  readonly sessions: SpaceSessionStore;
  readonly ledger: RuntimeLedgerStore;
  readonly runtimeCache: RuntimeCacheStore;
  readonly tasks: ScheduledTaskStore;
  readonly notes: AgentNoteStore;
  readonly core: CoreStore;
  readonly integrations: GatewayIntegrationStore;

  constructor(
    private readonly pool: PgQueryable,
    private readonly dimension: number,
    private readonly embed: Embedder,
    private readonly closePool = true,
  ) {
    this.avatars = this.createAvatarStore();
    this.spaces = this.createSpaceStore();
    this.models = this.createModelStore();
    this.skills = this.createSkillStore();
    this.mcp = this.createMcpStore();
    this.threads = this.createThreadStore();
    this.sessions = this.createSpaceSessionStore();
    this.ledger = this.createLedgerStore();
    this.runtimeCache = this.createRuntimeCacheStore();
    this.tasks = this.createScheduledTaskStore();
    this.notes = this.createNoteStore();
    this.core = this.createCoreStore();
    this.integrations = this.createGatewayIntegrationStore();
  }

  /** Run `fn` in a transaction when the pool supports it; else pass through. */
  private async runInTx<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    if (!('connect' in this.pool)) {
      return fn(this.pool);
    }
    const client = await (this.pool as PgPool).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { });
      throw error;
    } finally {
      client.release();
    }
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector ?? [];
  }

  private createScheduledTaskStore(): ScheduledTaskStore {
    const ownerClause = (owner: { userId?: string; tenantId?: string } | undefined, params: unknown[], table = ''): string[] => {
      if (!owner?.userId) {
        return [];
      }
      const prefix = table ? `${table}.` : '';
      params.push(owner.userId);
      const userParam = `$${params.length}`;
      params.push(owner.tenantId ?? null);
      const tenantParam = `$${params.length}`;
      return [`${prefix}user_id = ${userParam}`, `${prefix}tenant_id IS NOT DISTINCT FROM ${tenantParam}`];
    };

    return {
      createTask: async (input) => {
        const now = new Date();
        const createdAt = input.createdAt ?? now;
        const updatedAt = input.updatedAt ?? createdAt;
        const result = await this.pool.query(
          `INSERT INTO scheduled_tasks
             (id, user_id, tenant_id, avatar_id, project_id, conversation_id, model_config_id, permission_mode, target_space,
              name, prompt, cron, timezone, enabled, task_type, payload, created_at, updated_at, deleted_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NULL)
           RETURNING *`,
          [
            input.id,
            input.userId ?? null,
            input.tenantId ?? null,
            input.avatarId,
            input.projectId ?? null,
            input.conversationId ?? null,
            input.modelConfigId ?? null,
            input.permissionMode,
            input.targetSpace ?? null,
            input.name,
            input.prompt,
            input.cron,
            input.timezone,
            input.enabled,
            input.type ?? 'agent',
            input.payload === undefined ? null : jsonParam(input.payload),
            createdAt,
            updatedAt,
          ],
        );
        return rowToScheduledTask(result.rows[0]!);
      },
      updateTask: async (id, patch, owner) => {
        const assignments: string[] = [];
        const params: unknown[] = [];
        const columns: Array<[keyof typeof patch, string, unknown]> = [
          ['name', 'name', patch.name],
          ['type', 'task_type', patch.type],
          ['prompt', 'prompt', patch.prompt],
          ['payload', 'payload', patch.payload === undefined ? undefined : jsonParam(patch.payload)],
          ['cron', 'cron', patch.cron],
          ['timezone', 'timezone', patch.timezone],
          ['enabled', 'enabled', patch.enabled],
          ['avatarId', 'avatar_id', patch.avatarId],
          ['projectId', 'project_id', patch.projectId],
          ['conversationId', 'conversation_id', patch.conversationId],
          ['modelConfigId', 'model_config_id', patch.modelConfigId],
          ['permissionMode', 'permission_mode', patch.permissionMode],
          ['targetSpace', 'target_space', patch.targetSpace],
        ];
        for (const [, column, value] of columns) {
          if (value === undefined) continue;
          params.push(value);
          assignments.push(`${column} = $${params.length}`);
        }
        params.push(new Date());
        assignments.push(`updated_at = $${params.length}`);
        params.push(id);
        const filters = [`id = $${params.length}`, 'deleted_at IS NULL', ...ownerClause(owner, params)];
        const result = await this.pool.query(`UPDATE scheduled_tasks SET ${assignments.join(', ')} WHERE ${filters.join(' AND ')} RETURNING *`, params);
        if (!result.rows[0]) {
          throw new Error(`scheduled task "${id}" not found`);
        }
        return rowToScheduledTask(result.rows[0]);
      },
      getTask: async (id, owner) => {
        const params: unknown[] = [id];
        const filters = ['id = $1', ...ownerClause(owner, params)];
        if (!owner?.includeDeleted) {
          filters.push('deleted_at IS NULL');
        }
        const result = await this.pool.query(`SELECT * FROM scheduled_tasks WHERE ${filters.join(' AND ')} LIMIT 1`, params);
        return result.rows[0] ? rowToScheduledTask(result.rows[0]) : undefined;
      },
      listTasks: async (input = {}) => {
        const params: unknown[] = [];
        const filters = [...ownerClause(input, params)];
        if (!input.includeDeleted) {
          filters.push('deleted_at IS NULL');
        }
        if (input.enabled !== undefined) {
          params.push(input.enabled);
          filters.push(`enabled = $${params.length}`);
        }
        const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(`SELECT * FROM scheduled_tasks ${where} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
        return result.rows.map(rowToScheduledTask);
      },
      softDeleteTask: async (id, owner) => {
        const params: unknown[] = [new Date(), id];
        const filters = [`id = $2`, 'deleted_at IS NULL', ...ownerClause(owner, params)];
        await this.pool.query(`UPDATE scheduled_tasks SET deleted_at = $1, enabled = false, updated_at = $1 WHERE ${filters.join(' AND ')}`, params);
      },
      createRun: async (input) => {
        const result = await this.pool.query(
          `INSERT INTO scheduled_task_runs
             (id, task_id, queue_job_id, trigger, status, scheduled_for, started_at, finished_at,
              conversation_id, agent_run_id, summary, error, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            input.id,
            input.taskId,
            input.queueJobId ?? null,
            input.trigger,
            input.status,
            input.scheduledFor ?? null,
            input.startedAt ?? null,
            input.finishedAt ?? null,
            input.conversationId ?? null,
            input.agentRunId ?? null,
            input.summary ?? null,
            input.error ?? null,
            jsonParam(input.metadata),
          ],
        );
        return rowToScheduledTaskRun(result.rows[0]!);
      },
      updateRun: async (id, patch) => {
        const assignments: string[] = [];
        const params: unknown[] = [];
        const columns: Array<[string, unknown]> = [
          ['queue_job_id', patch.queueJobId],
          ['status', patch.status],
          ['scheduled_for', patch.scheduledFor],
          ['started_at', patch.startedAt],
          ['finished_at', patch.finishedAt],
          ['conversation_id', patch.conversationId],
          ['agent_run_id', patch.agentRunId],
          ['summary', patch.summary],
          ['error', patch.error],
          ['metadata', patch.metadata === undefined ? undefined : jsonParam(patch.metadata)],
        ];
        for (const [column, value] of columns) {
          if (value === undefined) continue;
          params.push(value);
          assignments.push(`${column} = $${params.length}`);
        }
        if (assignments.length === 0) {
          const existing = await this.tasks.getRun(id);
          if (!existing) throw new Error(`scheduled task run "${id}" not found`);
          return existing;
        }
        params.push(id);
        const result = await this.pool.query(`UPDATE scheduled_task_runs SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (!result.rows[0]) {
          throw new Error(`scheduled task run "${id}" not found`);
        }
        return rowToScheduledTaskRun(result.rows[0]);
      },
      getRun: async (id) => {
        const result = await this.pool.query(`SELECT * FROM scheduled_task_runs WHERE id = $1 LIMIT 1`, [id]);
        return result.rows[0] ? rowToScheduledTaskRun(result.rows[0]) : undefined;
      },
      listRuns: async (input) => {
        const params: unknown[] = [input.taskId];
        const filters = ['r.task_id = $1', ...ownerClause(input, params, 't')];
        if (input.status) {
          const statuses = Array.isArray(input.status) ? input.status : [input.status];
          params.push(statuses);
          filters.push(`r.status = ANY($${params.length}::text[])`);
        }
        const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
        const offset = Math.max(0, input.offset ?? 0);
        params.push(limit, offset);
        const result = await this.pool.query(
          `SELECT r.*
           FROM scheduled_task_runs AS r
           JOIN scheduled_tasks AS t ON t.id = r.task_id
           WHERE ${filters.join(' AND ')}
           ORDER BY COALESCE(r.started_at, r.scheduled_for) DESC NULLS LAST, r.id DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return result.rows.map(rowToScheduledTaskRun);
      },
      reclaimStaleRuns: async (olderThanSeconds) => {
        const seconds = Math.max(1, Math.floor(olderThanSeconds));
        const result = await this.pool.query(
          `UPDATE scheduled_task_runs
             SET status = 'failed',
                 finished_at = now(),
                 error = 'reclaimed: stale running run without completion'
           WHERE status = 'running'
             AND COALESCE(started_at, scheduled_for) < now() - ($1 || ' seconds')::interval`,
          [String(seconds)],
        );
        return result.rowCount ?? 0;
      },
    };
  }

  /** A 线 · agent_memory 笔记 (docs/store.md §2): people notes.
   *  experience kind is legacy-compatible only; new experience memory uses core. */
  private createNoteStore(): AgentNoteStore {
    const map = (row: Record<string, unknown>): AgentNote => ({
      id: row.id as string,
      kind: row.kind as AgentNoteKind,
      agentId: row.agent_id as string,
      userId: (row.user_id as string | null) ?? undefined,
      spaceId: (row.space_id as string | null) ?? undefined,
      threadId: (row.thread_id as string | null) ?? undefined,
      subject: row.kind === 'impression' ? ((row.subject as 'user' | 'agent' | null) ?? 'user') : undefined,
      memory: row.memory as string,
      status: row.status as AgentNoteStatus,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });

    // Scope predicate: agent + kind-specific column, value or IS NULL.
    const scopeWhere = (kind: AgentNoteKind, scope: AgentNoteScope, params: unknown[]): string => {
      params.push(scope.agentId);
      let where = `agent_id = $${params.length}`;
      if (kind === 'impression') {
        if (scope.userId === undefined || scope.userId === null) {
          where += ` AND user_id IS NULL`;
        } else {
          params.push(scope.userId);
          where += ` AND user_id = $${params.length}`;
        }
      }
      return where;
    };

    return {
      write: async (input, limit = DEFAULT_AGENT_NOTE_LIMIT) => {
        const now = new Date();
        const note: AgentNote = {
          id: input.id ?? randomUUID(),
          kind: input.kind,
          agentId: input.scope.agentId,
          userId: input.kind === 'impression' ? input.scope.userId : undefined,
          spaceId: undefined,
          threadId: input.scope.threadId,
          subject: input.kind === 'impression' ? (input.subject ?? 'user') : undefined,
          memory: input.memory,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        await this.pool.query(
          `INSERT INTO agent_memory
             (id, kind, agent_id, user_id, space_id, thread_id, subject, memory, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             subject = EXCLUDED.subject, memory = EXCLUDED.memory,
             status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
          [
            note.id, note.kind, note.agentId, note.userId ?? null, note.spaceId ?? null,
            note.threadId ?? null, note.subject ?? 'user', note.memory, note.status,
            note.createdAt.toISOString(), note.updatedAt.toISOString(),
          ],
        );
        // FIFO: archive anything beyond the newest `limit` in this scope.
        const params: unknown[] = [];
        const where = scopeWhere(
          note.kind,
          { agentId: note.agentId, userId: note.userId, spaceId: note.spaceId },
          params,
        );
        params.push(note.kind);
        const kindParam = `$${params.length}`;
        params.push(Math.max(0, limit));
        const offsetParam = `$${params.length}`;
        params.push(now.toISOString());
        const tsParam = `$${params.length}`;
        await this.pool.query(
          `UPDATE agent_memory SET status = 'archived', updated_at = ${tsParam}
           WHERE id IN (
             SELECT id FROM agent_memory
             WHERE status = 'active' AND kind = ${kindParam} AND ${where}
               AND ($${params.length + 1}::text IS NULL OR subject = $${params.length + 1})
             ORDER BY created_at DESC, id DESC
             OFFSET ${offsetParam}
           )`,
          [...params, note.kind === 'impression' ? note.subject ?? 'user' : null],
        );
        return note;
      },
      listRecent: async ({ kind, scope, limit }) => {
        const params: unknown[] = [];
        const where = scopeWhere(kind, scope, params);
        params.push(kind);
        const kindParam = `$${params.length}`;
        params.push(Math.max(1, Math.min(limit ?? DEFAULT_AGENT_NOTE_LIMIT, 200)));
        const limitParam = `$${params.length}`;
        const result = await this.pool.query(
          `SELECT * FROM agent_memory
           WHERE status = 'active' AND kind = ${kindParam} AND ${where}
           ORDER BY created_at DESC, id DESC LIMIT ${limitParam}`,
          params,
        );
        return result.rows.map(map);
      },
      getById: async (id) => {
        const result = await this.pool.query(`SELECT * FROM agent_memory WHERE id = $1 LIMIT 1`, [id]);
        return result.rows[0] ? map(result.rows[0]) : undefined;
      },
      archive: async (id) => {
        await this.pool.query(`UPDATE agent_memory SET status = 'archived', updated_at = $2 WHERE id = $1`, [
          id,
          new Date().toISOString(),
        ]);
      },
      purgeByAgent: async (agentId) => {
        await this.pool.query(`DELETE FROM agent_memory WHERE agent_id = $1`, [agentId]);
      },
      archiveBySpace: async ({ agentId, spaceId }) => {
        // Legacy cleanup only: new experience memories live in core kind='experience'
        // and are agent-scoped, not space-scoped agent_memory rows.
        await this.pool.query(
          `UPDATE agent_memory SET status = 'archived', updated_at = $3
           WHERE kind = 'experience' AND agent_id = $1 AND space_id = $2`,
          [agentId, spaceId, new Date().toISOString()],
        );
      },
      purgeByUser: async ({ agentId, userId }) => {
        await this.pool.query(`DELETE FROM agent_memory WHERE kind = 'impression' AND agent_id = $1 AND user_id = $2`, [
          agentId,
          userId,
        ]);
      },
    };
  }

  /** B 线 · core 事件图 (docs/store.md §3): source/event/entity. 身份在 source,
   *  event 纯净只挂 source_id, 实体按 source 共享去重. */
  private createCoreStore(): CoreStore {
    const dimension = this.dimension;
    const mapSource = (row: Record<string, unknown>): CoreSource => ({
      id: row.id as string,
      groupId: row.group_id as string,
      kind: row.kind as string,
      agentId: row.agent_id as string,
      userId: (row.user_id as string | null) ?? undefined,
      tenantId: (row.tenant_id as string | null) ?? undefined,
      spaceId: (row.space_id as string | null) ?? undefined,
      threadId: (row.thread_id as string | null) ?? undefined,
      name: (row.name as string | null) ?? undefined,
      metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
      status: row.status as CoreSource['status'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
    const mapEvent = (row: Record<string, unknown>): CoreEvent => ({
      id: row.id as string,
      sourceId: row.source_id as string,
      memory: (row.content as string | null) ?? (row.summary as string),
      metadata: rowJson<Record<string, unknown> | undefined>(row.metadata, undefined),
      keywords: (row.keywords as string[] | null) ?? [],
      messageIds: (row.message_ids as string[] | null) ?? undefined,
      contentHash: (row.content_hash as string | null) ?? undefined,
      relationId: (row.relation_id as string | null) ?? undefined,
      supersedesId: (row.supersedes_id as string | null) ?? undefined,
      supersededBy: (row.superseded_by as string | null) ?? undefined,
      supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
      confidence: (row.confidence as number | null) ?? undefined,
      status: row.status as CoreEventStatus,
      validUntil: row.valid_until ? new Date(row.valid_until as string) : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
    const mapEntity = (row: Record<string, unknown>): CoreEntityRef => ({
      id: row.id as string,
      sourceId: row.source_id as string,
      type: row.type as string,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      aliases: (row.aliases as string[] | null) ?? undefined,
      role: (row.role as string | null) ?? undefined,
      description: (row.description as string | null) ?? undefined,
      weight: (row.weight as number | null) ?? undefined,
      confidence: (row.confidence as number | null) ?? undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });

    const queryTokens = (text: string): string[] => {
      const set = new Set<string>();
      for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (raw.length >= 2) set.add(raw);
      }
      return [...set].slice(0, 16);
    };

    const findByHash = async (q: PgQueryable, sourceId: string, contentHash: string): Promise<CoreEvent | undefined> => {
      const result = await q.query(`SELECT * FROM event WHERE source_id = $1 AND content_hash = $2 LIMIT 1`, [
        sourceId,
        contentHash,
      ]);
      return result.rows[0] ? mapEvent(result.rows[0]) : undefined;
    };

    const store: CoreStore = {
      ensureSource: async (input) => {
        const now = new Date().toISOString();
        await this.pool.query(
          `INSERT INTO source_group (id, name, metadata, created_at, updated_at)
           VALUES ($1, $1, NULL, $2, $2) ON CONFLICT (id) DO NOTHING`,
          [input.groupId, now],
        );
        const s = input.scope;
        const result = await this.pool.query(
          `INSERT INTO source
             (id, group_id, kind, agent_id, user_id, tenant_id, space_id, thread_id, name, metadata, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$11)
           ON CONFLICT (group_id, agent_id, kind, COALESCE(user_id,''), COALESCE(space_id,''), COALESCE(thread_id,''))
           DO UPDATE SET name = COALESCE(EXCLUDED.name, source.name),
             metadata = COALESCE(EXCLUDED.metadata, source.metadata), updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            randomUUID(), input.groupId, input.kind, s.agentId, s.userId ?? null, s.tenantId ?? null,
            s.spaceId ?? null, s.threadId ?? null, input.name ?? null, jsonParam(input.metadata), now,
          ],
        );
        return mapSource(result.rows[0]);
      },
      getSource: async (id) => {
        const result = await this.pool.query(`SELECT * FROM source WHERE id = $1 LIMIT 1`, [id]);
        return result.rows[0] ? mapSource(result.rows[0]) : undefined;
      },
      findEventByHash: async (sourceId, contentHash) => findByHash(this.pool, sourceId, contentHash),
      insertEvent: async (input) => {
        if (input.contentHash) {
          const existing = await findByHash(this.pool, input.sourceId, input.contentHash);
          if (existing) return existing;
        }
        return this.runInTx(async (q) => {
          const id = input.id ?? randomUUID();
          const now = new Date().toISOString();
          const keywords = input.keywords ?? [];
          const searchText = [input.memory, keywords.join(' ')].filter(Boolean).join(' ');
          const embedding =
            input.embedding && input.embedding.length === dimension ? toVector(input.embedding) : null;
          const status = input.status ?? 'active';
          const eventRow = await q.query(
            `INSERT INTO event
               (id, source_id, summary, content, metadata, keywords, message_ids, content_hash,
                relation_id, supersedes_id, importance, confidence,
                status, valid_until, embedding, search_text, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector,to_tsvector('simple',$16),$17,$17)
             RETURNING *`,
            [
              id, input.sourceId, input.memory, input.memory, jsonParam(input.metadata), keywords, input.messageIds ?? null,
              input.contentHash ?? null, input.relationId ?? null, input.supersedesId ?? null,
              null, input.confidence ?? null, status,
              input.validUntil?.toISOString() ?? null, embedding, searchText, now,
            ],
          );
          for (const entity of input.entities ?? []) {
            const normalized = entity.normalizedName ?? normalizeEntityName(entity.name);
            const entEmbedding =
              entity.embedding && entity.embedding.length === dimension ? toVector(entity.embedding) : null;
            const entRow = await q.query(
              `INSERT INTO entity (id, source_id, type, name, normalized_name, aliases, embedding, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$8)
               ON CONFLICT (source_id, type, normalized_name)
               DO UPDATE SET name = EXCLUDED.name,
                 aliases = COALESCE(EXCLUDED.aliases, entity.aliases),
                 embedding = COALESCE(EXCLUDED.embedding, entity.embedding), updated_at = EXCLUDED.updated_at
               RETURNING id`,
              [randomUUID(), input.sourceId, entity.type, entity.name, normalized, entity.aliases ?? null, entEmbedding, now],
            );
            const entityId = entRow.rows[0].id as string;
            await q.query(
              `INSERT INTO event_entity (id, event_id, entity_id, role, description, weight, confidence)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (event_id, entity_id)
               DO UPDATE SET role = EXCLUDED.role, description = EXCLUDED.description,
                 weight = EXCLUDED.weight, confidence = EXCLUDED.confidence`,
              [randomUUID(), id, entityId, entity.role ?? null, entity.description ?? null, entity.weight ?? 1.0, entity.confidence ?? null],
            );
          }
          return mapEvent(eventRow.rows[0]);
        });
      },
      getEvent: async (id) => {
        const result = await this.pool.query(`SELECT * FROM event WHERE id = $1 LIMIT 1`, [id]);
        return result.rows[0] ? mapEvent(result.rows[0]) : undefined;
      },
      detail: async (id): Promise<CoreEventDetail | undefined> => {
        const eventResult = await this.pool.query(`SELECT * FROM event WHERE id = $1 LIMIT 1`, [id]);
        const eventRow = eventResult.rows[0];
        if (!eventRow) return undefined;
        const event = mapEvent(eventRow);
        const sourceResult = await this.pool.query(`SELECT * FROM source WHERE id = $1 LIMIT 1`, [event.sourceId]);
        if (!sourceResult.rows[0]) return undefined;
        const entityResult = await this.pool.query(
          `SELECT e.*, ee.role, ee.description, ee.weight, ee.confidence
           FROM event_entity ee JOIN entity e ON e.id = ee.entity_id
           WHERE ee.event_id = $1 ORDER BY ee.weight DESC NULLS LAST`,
          [id],
        );
        return { ...event, source: mapSource(sourceResult.rows[0]), entities: entityResult.rows.map(mapEntity) };
      },
      listEvents: async (query) => {
        const params: unknown[] = [query.groupId, query.scope.agentId];
        let where = `s.group_id = $1 AND s.agent_id = $2`;
        const addEq = (col: string, value: string | undefined) => {
          if (value === undefined) return;
          params.push(value);
          where += ` AND s.${col} = $${params.length}`;
        };
        addEq('kind', query.kind);
        addEq('user_id', query.scope.userId);
        addEq('space_id', query.scope.spaceId);
        addEq('thread_id', query.scope.threadId);
        if (query.scope.tenantId !== undefined) addEq('tenant_id', query.scope.tenantId);
        params.push(Math.max(1, Math.min(query.limit ?? 20, 200)));
        const result = await this.pool.query(
          `SELECT ev.* FROM event ev JOIN source s ON s.id = ev.source_id
           WHERE ${where} AND ev.status = 'active'
           ORDER BY ev.created_at DESC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(mapEvent);
      },
      recall: async (input) => {
        const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
        const candidateLimit = Math.max(limit, Math.min(input.candidateLimit ?? 30, 200));
        const mode = input.mode ?? 'fast';
        const hops = input.graphHops ?? 1;

        // 1) Isolation: pick the visible sources before touching any event.
        const sParams: unknown[] = [input.groupId, input.scope.agentId];
        let sWhere = `group_id = $1 AND agent_id = $2 AND status = 'active'`;
        const addEq = (col: string, value: string | undefined) => {
          if (value === undefined) return;
          sParams.push(value);
          sWhere += ` AND ${col} = $${sParams.length}`;
        };
        addEq('kind', input.kind);
        addEq('user_id', input.scope.userId);
        addEq('space_id', input.scope.spaceId);
        addEq('thread_id', input.scope.threadId);
        if (input.scope.tenantId !== undefined) addEq('tenant_id', input.scope.tenantId);
        const sourceRows = await this.pool.query(`SELECT id FROM source WHERE ${sWhere}`, sParams);
        const sourceIds = sourceRows.rows.map((r) => r.id as string);
        if (sourceIds.length === 0) return [];

        const seenEvents = new Map<string, CoreEvent>();
        const rrfContributions: RrfContribution<CoreEvent>[] = [];
        const bump = (row: Record<string, unknown>, path: string, score: number, rank: number) => {
          const event = mapEvent(row);
          if (!seenEvents.has(event.id)) seenEvents.set(event.id, event);
          rrfContributions.push({ item: event, path, rank, rawScore: score });
        };

        // 2) Vector path (skipped without a query embedding — graceful degrade).
        if (input.embedding && input.embedding.length === dimension) {
          const r = await this.pool.query(
            `SELECT *, 1 - (embedding <=> $1::vector) AS _score FROM event
             WHERE source_id = ANY($2) AND status = 'active' AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector LIMIT $3`,
            [toVector(input.embedding), sourceIds, candidateLimit],
          );
          r.rows.forEach((row, index) => bump(row, 'vector', Number(row._score), index + 1));
        }

        // 3) Lexical FTS (normalized by the batch max so it stays in [0,1]).
        const lex = await this.pool.query(
          `SELECT *, ts_rank(search_text, plainto_tsquery('simple', $1)) AS _score FROM event
           WHERE source_id = ANY($2) AND status = 'active' AND search_text @@ plainto_tsquery('simple', $1)
           ORDER BY _score DESC LIMIT $3`,
          [input.queryText, sourceIds, candidateLimit],
        );
        const maxLex = lex.rows.reduce((m, row) => Math.max(m, Number(row._score)), 0);
        lex.rows.forEach((row, index) => bump(row, 'lexical', maxLex > 0 ? Number(row._score) / maxLex : 0, index + 1));

        // 4) Entity match (normalized name exact + name fuzzy).
        const terms = queryTokens(input.queryText);
        if (terms.length) {
          const likeTerms = terms.map((t) => `%${t}%`);
          const ent = await this.pool.query(
            `SELECT DISTINCT e.* FROM event e
             JOIN event_entity ee ON ee.event_id = e.id
             JOIN entity en ON en.id = ee.entity_id
             WHERE e.source_id = ANY($1) AND e.status = 'active'
               AND (en.normalized_name = ANY($2) OR en.name ILIKE ANY($3))
             ORDER BY e.created_at DESC
             LIMIT $4`,
            [sourceIds, terms, likeTerms, candidateLimit],
          );
          ent.rows.forEach((row, index) => bump(row, 'entity', 1, index + 1));
        }

        // 5) Graph: 1–2 hop expansion over shared entities, within the same sources.
        if (hops >= 1 && seenEvents.size > 0) {
          let seedIds = [...seenEvents.keys()];
          for (let hop = 1; hop <= hops; hop += 1) {
            if (seedIds.length === 0) break;
            const g = await this.pool.query(
              `SELECT DISTINCT e.* FROM event e
               JOIN event_entity ee ON ee.event_id = e.id
               WHERE e.source_id = ANY($1) AND e.status = 'active'
                 AND ee.entity_id IN (SELECT ee2.entity_id FROM event_entity ee2 WHERE ee2.event_id = ANY($2))
                 AND e.id <> ALL($2)
               ORDER BY e.created_at DESC
               LIMIT $3`,
              [sourceIds, seedIds, candidateLimit],
            );
            const decay = 0.5 ** hop;
            const nextSeeds: string[] = [];
            for (let index = 0; index < g.rows.length; index += 1) {
              const row = g.rows[index];
              const id = row.id as string;
              if (!seenEvents.has(id)) nextSeeds.push(id);
              bump(row, 'graph', decay, ((hop - 1) * candidateLimit) + index + 1);
            }
            seedIds = nextSeeds;
          }
        }

        // 6) Combine + dedupe via reciprocal rank fusion across retrieval paths.
        const hits: RecallHit[] = mergeRrfRankings(rrfContributions).map((entry) => ({
          ...entry.item,
          vectorScore: entry.pathScores.vector,
          lexicalScore: entry.pathScores.lexical,
          entityScore: entry.pathScores.entity,
          graphScore: entry.pathScores.graph,
          paths: entry.paths,
          score: entry.score,
        }));

        // precise: LLM rerank over the coarse top-N (active recall only). fast: skip.
        if (mode === 'precise' && input.rerank) {
          try {
            const reranked = await input.rerank({ queryText: input.queryText, hits: hits.slice(0, candidateLimit), limit });
            return reranked.slice(0, limit);
          } catch {
            return hits.slice(0, limit);
          }
        }
        return hits.slice(0, limit);
      },
      setEventStatus: async (id, status, input) => {
        const now = new Date();
        const updatedAt = now.toISOString();
        const supersededAt = input?.supersededAt ?? (input?.supersededBy ? now : undefined);
        if (input?.supersededBy || supersededAt) {
          await this.pool.query(
            `UPDATE event
             SET status = $2,
                 superseded_by = COALESCE($3, superseded_by),
                 superseded_at = COALESCE($4, superseded_at),
                 updated_at = $5
             WHERE id = $1`,
            [
              id,
              status,
              input?.supersededBy ?? null,
              supersededAt?.toISOString() ?? null,
              updatedAt,
            ],
          );
          return;
        }
        await this.pool.query(`UPDATE event SET status = $2, updated_at = $3 WHERE id = $1`, [id, status, updatedAt]);
      },
      deleteByThread: async ({ groupId, agentId, threadId, kind }) => {
        const params: unknown[] = [groupId, agentId, threadId];
        let where = `group_id = $1 AND agent_id = $2 AND thread_id = $3`;
        if (kind) {
          params.push(kind);
          where += ` AND kind = $${params.length}`;
        }
        await this.pool.query(`DELETE FROM source WHERE ${where}`, params);
      },
      purgeByAgent: async ({ agentId, groupId }) => {
        const params: unknown[] = [agentId];
        let where = `agent_id = $1`;
        if (groupId) {
          params.push(groupId);
          where += ` AND group_id = $${params.length}`;
        }
        await this.pool.query(`DELETE FROM source WHERE ${where}`, params);
      },
    };
    return store;
  }

  async transaction<T>(operation: (tx: SuperAgentStorageAdapter) => Promise<T>): Promise<T> {
    if (!('connect' in this.pool)) {
      return operation(this);
    }
    const client = await (this.pool as PgPool).connect();
    try {
      await client.query('BEGIN');
      const result = await operation(new PgStore(client, this.dimension, this.embed, false));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { });
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions
         (id, agent_id, kind, trigger, title, parent_session_id, status, created_at, updated_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at, metadata = EXCLUDED.metadata`,
      [
        session.id,
        session.agentId ?? null,
        session.kind,
        session.trigger,
        session.title ?? null,
        session.parentSessionId ?? null,
        session.status,
        session.createdAt.toISOString(),
        session.updatedAt.toISOString(),
        session.metadata === undefined ? null : JSON.stringify(session.metadata),
      ],
    );
  }

  async touchSession(sessionId: string, runId: string, updatedAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_runs (session_id, run_id, appended_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [sessionId, runId, updatedAt.toISOString()],
    );
    await this.pool.query(`UPDATE sessions SET updated_at = $2 WHERE id = $1`, [sessionId, updatedAt.toISOString()]);
  }

  /** Recently produced artifacts, newest first — for the web Artifact gallery. */
  async listArtifacts(input: number | { userId?: string; tenantId?: string; limit?: number } = 50): Promise<DurableArtifactRecord[]> {
    const options = typeof input === 'number' ? { limit: input } : input;
    const params: unknown[] = [];
    const filters: string[] = [];
    appendOwnerFilters(filters, params, options);
    params.push(Math.max(1, Math.min(options.limit ?? 50, 200)));
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT a.*
       FROM artifacts a
       LEFT JOIN threads ON threads.id = a.thread_id
       ${where}
       ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(rowToArtifact);
  }

  async close(): Promise<void> {
    if (this.closePool && 'end' in this.pool) {
      await (this.pool as PgPool).end();
    }
  }

  private createAvatarStore(): AvatarConfigStore {
    return {
      saveAvatar: async (record) => {
        await this.pool.query(
          `INSERT INTO avatars (id, user_id, slug, name, current_version, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
             current_version = EXCLUDED.current_version, status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.userId ?? null,
            record.slug,
            record.name,
            record.currentVersion,
            record.status,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
          ],
        );
      },
      saveAvatarVersion: async (record) => {
        await this.pool.query(
          `INSERT INTO avatar_versions
             (avatar_id, version, name, description, persona, model_config_id, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (avatar_id, version) DO UPDATE SET
             name = EXCLUDED.name, description = EXCLUDED.description, persona = EXCLUDED.persona,
             model_config_id = EXCLUDED.model_config_id,
             metadata = EXCLUDED.metadata`,
          [
            record.avatarId,
            record.version,
            record.name,
            record.description ?? null,
            record.persona ?? null,
            record.modelConfigId ?? null,
            jsonParam(record.metadata),
            record.createdAt.toISOString(),
          ],
        );
      },
      getAvatar: async (id) => {
        const result = await this.pool.query(`SELECT * FROM avatars WHERE id = $1`, [id]);
        return result.rows[0] ? rowToAvatar(result.rows[0]) : undefined;
      },
      getAvatarVersion: async (avatarId, version) => {
        const result = version === undefined
          ? await this.pool.query(
            `SELECT * FROM avatar_versions WHERE avatar_id = $1 ORDER BY version DESC LIMIT 1`,
            [avatarId],
          )
          : await this.pool.query(
            `SELECT * FROM avatar_versions WHERE avatar_id = $1 AND version = $2`,
            [avatarId, version],
          );
        return result.rows[0] ? rowToAvatarVersion(result.rows[0]) : undefined;
      },
      listAvatars: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.status) {
          params.push(input.status);
          filters.push(`status = $${params.length}`);
        }
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT * FROM avatars ${where} ORDER BY updated_at DESC, id ASC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToAvatar);
      },
    };
  }

  private createSpaceStore(): SpaceConfigStore {
    return {
      saveSpace: async (record) => {
        await this.pool.query(
          `INSERT INTO spaces (id, slug, kind, current_version, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             slug = EXCLUDED.slug, kind = EXCLUDED.kind, current_version = EXCLUDED.current_version,
             status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.slug,
            record.kind,
            record.currentVersion,
            record.status,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
          ],
        );
      },
      saveSpaceVersion: async (record) => {
        await this.pool.query(
          `INSERT INTO space_versions
             (space_id, version, label, description, routing_card, instructions, model_config_id,
              summary_model_config_id, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (space_id, version) DO UPDATE SET
             label = EXCLUDED.label, description = EXCLUDED.description, routing_card = EXCLUDED.routing_card,
             instructions = EXCLUDED.instructions, model_config_id = EXCLUDED.model_config_id,
             summary_model_config_id = EXCLUDED.summary_model_config_id, metadata = EXCLUDED.metadata`,
          [
            record.spaceId,
            record.version,
            record.label,
            record.description ?? null,
            record.routingCard ?? null,
            record.instructions ?? null,
            record.modelConfigId ?? null,
            record.summaryModelConfigId ?? null,
            jsonParam(record.metadata),
            record.createdAt.toISOString(),
          ],
        );
      },
      saveCapability: async (record) => {
        await this.pool.query(
          `INSERT INTO capability_definitions
             (id, type, version, origin, label, description, descriptor, schema_hash, implementation_ref, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (type, id, version) DO UPDATE SET
             origin = EXCLUDED.origin, label = EXCLUDED.label, description = EXCLUDED.description,
             descriptor = EXCLUDED.descriptor, schema_hash = EXCLUDED.schema_hash,
             implementation_ref = EXCLUDED.implementation_ref`,
          [
            record.id,
            record.type,
            record.version,
            record.origin,
            record.label ?? null,
            record.description ?? null,
            jsonParam(record.descriptor),
            record.schemaHash ?? null,
            record.implementationRef ?? null,
            record.createdAt.toISOString(),
          ],
        );
      },
      bindCapability: async (record) => {
        await this.pool.query(
          `INSERT INTO space_capability_bindings
             (id, space_id, space_version, capability_type, capability_id, capability_version,
              enabled, config, order_index, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (space_id, space_version, capability_type, capability_id) DO UPDATE SET
             capability_version = EXCLUDED.capability_version, enabled = EXCLUDED.enabled,
             config = EXCLUDED.config, order_index = EXCLUDED.order_index`,
          [
            record.id,
            record.spaceId,
            record.spaceVersion,
            record.capabilityType,
            record.capabilityId,
            record.capabilityVersion ?? null,
            record.enabled,
            jsonParam(record.config),
            record.orderIndex,
            record.createdAt.toISOString(),
          ],
        );
      },
      getSpace: async (id) => {
        const result = await this.pool.query(`SELECT * FROM spaces WHERE id = $1`, [id]);
        return result.rows[0] ? rowToSpace(result.rows[0]) : undefined;
      },
      listSpaces: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        let where = '';
        if (input.status) {
          params.push(input.status);
          where = `WHERE status = $${params.length}`;
        }
        params.push(limit);
        const result = await this.pool.query(
          `SELECT * FROM spaces ${where} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToSpace);
      },
      getSpaceVersion: async (spaceId, version) => {
        const result = version === undefined
          ? await this.pool.query(
            `SELECT * FROM space_versions WHERE space_id = $1 ORDER BY version DESC LIMIT 1`,
            [spaceId],
          )
          : await this.pool.query(
            `SELECT * FROM space_versions WHERE space_id = $1 AND version = $2`,
            [spaceId, version],
          );
        return result.rows[0] ? rowToSpaceVersion(result.rows[0]) : undefined;
      },
      listCapabilityBindings: async ({ spaceId, version }) => {
        const spaceVersion = version ?? (await this.spaces.getSpace(spaceId))?.currentVersion;
        if (spaceVersion === undefined) {
          return [];
        }
        const result = await this.pool.query(
          `SELECT * FROM space_capability_bindings
           WHERE space_id = $1 AND space_version = $2
           ORDER BY order_index ASC, capability_id ASC`,
          [spaceId, spaceVersion],
        );
        return result.rows.map(rowToSpaceCapabilityBinding);
      },
      getSpaceSnapshot: async ({ avatarId, spaceId, version }) => {
        const space = await this.spaces.getSpace(spaceId);
        if (!space) {
          throw new Error(`Space not found: ${spaceId}`);
        }
        const spaceVersion = await this.spaces.getSpaceVersion(spaceId, version ?? space.currentVersion);
        if (!spaceVersion) {
          throw new Error(`Space version not found: ${spaceId}@${version ?? space.currentVersion}`);
        }
        const avatarVersion = await this.avatars.getAvatarVersion(avatarId);
        const bindings = await this.pool.query(
          `SELECT b.capability_type, b.capability_id, b.capability_version,
                  d.schema_hash, d.description, d.label
           FROM space_capability_bindings b
           LEFT JOIN LATERAL (
             SELECT * FROM capability_definitions d
             WHERE d.type = b.capability_type
               AND d.id = b.capability_id
               AND (b.capability_version IS NULL OR d.version = b.capability_version)
             ORDER BY d.version DESC
             LIMIT 1
           ) d ON true
           WHERE b.space_id = $1 AND b.space_version = $2 AND b.enabled = true
           ORDER BY b.order_index ASC, b.capability_id ASC`,
          [spaceId, spaceVersion.version],
        );
        return {
          id: `${avatarId}:${spaceId}:${spaceVersion.version}`,
          avatarId,
          avatarVersion: avatarVersion?.version ?? 1,
          spaceId,
          spaceVersion: spaceVersion.version,
          modelConfigId: spaceVersion.modelConfigId,
          summaryModelConfigId: spaceVersion.summaryModelConfigId,
          capabilities: bindings.rows.map((row) => ({
            type: row.capability_type,
            id: String(row.capability_id),
            version: row.capability_version === null ? undefined : Number(row.capability_version),
            schemaHash: maybeString(row.schema_hash),
            descriptorSummary: maybeString(row.description) ?? maybeString(row.label),
          })),
          createdAt: new Date(),
        };
      },
    };
  }

  private createModelStore(): ModelConfigStore {
    return {
      saveModelConfig: async (record) => {
        await this.pool.query(
          `INSERT INTO model_configs (id, provider_id, model, purpose, config, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             provider_id = EXCLUDED.provider_id, model = EXCLUDED.model,
             purpose = EXCLUDED.purpose, config = EXCLUDED.config,
             updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.providerId,
            record.model,
            record.purpose,
            jsonParam(record.config),
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
          ],
        );
      },
      getModelConfig: async (id) => {
        const result = await this.pool.query(`SELECT * FROM model_configs WHERE id = $1`, [id]);
        return result.rows[0] ? rowToModelConfig(result.rows[0]) : undefined;
      },
      listModelConfigs: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.purpose) {
          params.push(input.purpose);
          filters.push(`purpose = $${params.length}`);
        }
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT * FROM model_configs ${where} ORDER BY updated_at DESC, id ASC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToModelConfig);
      },
      deleteModelConfig: async (id) => {
        await this.pool.query(`DELETE FROM model_configs WHERE id = $1`, [id]);
      },
    };
  }

  private createGatewayIntegrationStore(): GatewayIntegrationStore {
    return {
      saveIntegration: async (record) => {
        await this.pool.query(
          `INSERT INTO gateway_integrations (channel, config, updated_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (channel) DO UPDATE SET
             config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
          [record.channel, jsonParam(record.config), record.updatedAt.toISOString()],
        );
      },
      getIntegration: async (channel) => {
        const result = await this.pool.query(`SELECT * FROM gateway_integrations WHERE channel = $1`, [channel]);
        return result.rows[0] ? rowToGatewayIntegration(result.rows[0]) : undefined;
      },
      deleteIntegration: async (channel) => {
        await this.pool.query(`DELETE FROM gateway_integrations WHERE channel = $1`, [channel]);
      },
    };
  }

  private createSkillStore(): SkillConfigStore {
    return {
      saveSkill: async (record) => {
        await this.pool.query(
          `INSERT INTO skill_definitions
             (id, version, origin, label, description, instructions, tool_ids, metadata,
              source_type, source_path, package_root, source_name, frontmatter, body, files,
              openai_config, claude_config, license, compatibility, allowed_tools, disallowed_tools,
              invocation_policy, trust_status, risk_audit, schema_hash, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (id, version) DO UPDATE SET
             origin = EXCLUDED.origin, label = EXCLUDED.label,
             description = EXCLUDED.description, instructions = EXCLUDED.instructions,
             tool_ids = EXCLUDED.tool_ids, metadata = EXCLUDED.metadata,
             source_type = EXCLUDED.source_type, source_path = EXCLUDED.source_path,
             package_root = EXCLUDED.package_root, source_name = EXCLUDED.source_name,
             frontmatter = EXCLUDED.frontmatter, body = EXCLUDED.body, files = EXCLUDED.files,
             openai_config = EXCLUDED.openai_config, claude_config = EXCLUDED.claude_config,
             license = EXCLUDED.license, compatibility = EXCLUDED.compatibility,
             allowed_tools = EXCLUDED.allowed_tools, disallowed_tools = EXCLUDED.disallowed_tools,
             invocation_policy = EXCLUDED.invocation_policy, trust_status = EXCLUDED.trust_status,
             risk_audit = EXCLUDED.risk_audit, schema_hash = EXCLUDED.schema_hash,
             updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.version,
            record.origin,
            record.label,
            record.description ?? null,
            record.instructions ?? null,
            jsonParam(record.toolIds),
            jsonParam(record.metadata),
            record.sourceType ?? null,
            record.sourcePath ?? null,
            record.packageRoot ?? null,
            record.sourceName ?? null,
            jsonParam(record.frontmatter),
            record.body ?? null,
            jsonParam(record.files),
            jsonParam(record.openaiConfig),
            jsonParam(record.claudeConfig),
            record.license ?? null,
            jsonParam(record.compatibility),
            jsonParam(record.allowedTools ?? []),
            jsonParam(record.disallowedTools ?? []),
            record.invocationPolicy ?? null,
            record.trustStatus ?? null,
            jsonParam(record.riskAudit),
            record.schemaHash ?? null,
            record.createdAt.toISOString(),
            (record.updatedAt ?? record.createdAt).toISOString(),
          ],
        );
      },
      getSkill: async (id, version) => {
        const result = version === undefined
          ? await this.pool.query(
            `SELECT * FROM skill_definitions WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
          )
          : await this.pool.query(
            `SELECT * FROM skill_definitions WHERE id = $1 AND version = $2`,
            [id, version],
          );
        return result.rows[0] ? rowToSkill(result.rows[0]) : undefined;
      },
      listSkills: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.origin) {
          params.push(input.origin);
          filters.push(`origin = $${params.length}`);
        }
        if (input.sourceType) {
          params.push(input.sourceType);
          filters.push(`source_type = $${params.length}`);
        }
        if (input.trustStatus) {
          params.push(input.trustStatus);
          filters.push(`trust_status = $${params.length}`);
        }
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT DISTINCT ON (id) *
           FROM skill_definitions
           ${where}
           ORDER BY id, version DESC
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToSkill);
      },
      deleteSkill: async (id, version) => {
        if (version === undefined) {
          await this.pool.query(`DELETE FROM skill_definitions WHERE id = $1`, [id]);
        } else {
          await this.pool.query(`DELETE FROM skill_definitions WHERE id = $1 AND version = $2`, [id, version]);
        }
      },
    };
  }

  private createMcpStore(): McpConfigStore {
    return {
      saveServer: async (record) => {
        const config = sanitizeMcpConfigForStorage(record.config);
        await this.pool.query(
          `INSERT INTO mcp_servers
             (id, user_id, tenant_id, name, transport, config, secret_refs, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id, tenant_id = EXCLUDED.tenant_id,
             name = EXCLUDED.name, transport = EXCLUDED.transport,
             config = EXCLUDED.config, secret_refs = EXCLUDED.secret_refs,
             status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.userId ?? null,
            record.tenantId ?? null,
            record.name,
            record.transport,
            jsonParam(config),
            jsonParam(record.secretRefs),
            record.status,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
          ],
        );
      },
      getServer: async (id, input = {}) => {
        const params: unknown[] = [id];
        const filters = [`id = $1`];
        if (input.userId) {
          params.push(input.userId);
          filters.push(`user_id = $${params.length}`);
        }
        if (input.tenantId) {
          params.push(input.tenantId);
          filters.push(`tenant_id = $${params.length}`);
        }
        const result = await this.pool.query(`SELECT * FROM mcp_servers WHERE ${filters.join(' AND ')}`, params);
        return result.rows[0] ? rowToMcpServer(result.rows[0]) : undefined;
      },
      listServers: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.status) {
          params.push(input.status);
          filters.push(`status = $${params.length}`);
        }
        if (input.userId) {
          params.push(input.userId);
          filters.push(`user_id = $${params.length}`);
        }
        if (input.tenantId) {
          params.push(input.tenantId);
          filters.push(`tenant_id = $${params.length}`);
        }
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT * FROM mcp_servers ${where} ORDER BY updated_at DESC, id ASC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToMcpServer);
      },
      deleteServer: async (id, input = {}) => {
        await this.runInTx(async (q) => {
          const params: unknown[] = [id];
          const filters = [`id = $1`];
          if (input.userId) {
            params.push(input.userId);
            filters.push(`user_id = $${params.length}`);
          }
          if (input.tenantId) {
            params.push(input.tenantId);
            filters.push(`tenant_id = $${params.length}`);
          }
          const existing = await q.query(`SELECT id FROM mcp_servers WHERE ${filters.join(' AND ')} LIMIT 1`, params);
          if (!existing.rows[0]) return;

          const tools = await q.query(`SELECT id FROM mcp_tool_definitions WHERE server_id = $1`, [id]);
          const toolIds = [...new Set(tools.rows.map((row) => String(row.id)))];
          if (toolIds.length > 0) {
            await q.query(`DELETE FROM space_capability_bindings WHERE capability_type = 'mcp_tool' AND capability_id = ANY($1::text[])`, [toolIds]);
            await q.query(`DELETE FROM capability_definitions WHERE type = 'mcp_tool' AND id = ANY($1::text[])`, [toolIds]);
          }
          await q.query(`DELETE FROM space_capability_bindings WHERE capability_type = 'mcp_server' AND capability_id = $1`, [id]);
          await q.query(`DELETE FROM capability_definitions WHERE type = 'mcp_server' AND id = $1`, [id]);
          await q.query(`DELETE FROM mcp_servers WHERE ${filters.join(' AND ')}`, params);
        });
      },
      saveTool: async (record) => {
        await this.pool.query(
          `INSERT INTO mcp_tool_definitions
             (id, server_id, name, version, label, description, input_schema, output_schema, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id, version) DO UPDATE SET
             server_id = EXCLUDED.server_id, name = EXCLUDED.name,
             label = EXCLUDED.label, description = EXCLUDED.description,
             input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema`,
          [
            record.id,
            record.serverId,
            record.name,
            record.version,
            record.label ?? null,
            record.description ?? null,
            jsonParam(record.inputSchema),
            jsonParam(record.outputSchema),
            record.createdAt.toISOString(),
          ],
        );
      },
      getTool: async (id, version) => {
        const result = version === undefined
          ? await this.pool.query(
            `SELECT * FROM mcp_tool_definitions WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
          )
          : await this.pool.query(
            `SELECT * FROM mcp_tool_definitions WHERE id = $1 AND version = $2`,
            [id, version],
          );
        return result.rows[0] ? rowToMcpTool(result.rows[0]) : undefined;
      },
      listTools: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.serverId) {
          params.push(input.serverId);
          filters.push(`server_id = $${params.length}`);
        }
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT DISTINCT ON (id) *
           FROM mcp_tool_definitions
           ${where}
           ORDER BY id, version DESC
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToMcpTool);
      },
      deleteTool: async (id, version) => {
        if (version === undefined) {
          await this.pool.query(`DELETE FROM mcp_tool_definitions WHERE id = $1`, [id]);
        } else {
          await this.pool.query(`DELETE FROM mcp_tool_definitions WHERE id = $1 AND version = $2`, [id, version]);
        }
      },
    };
  }

  private createThreadStore(): ThreadStore {
    return {
      createThread: async (input) => {
        const now = new Date();
        const record: ThreadRecord = {
          ...input,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
        };
        await this.pool.query(
          `INSERT INTO threads (id, avatar_id, user_id, tenant_id, title, main_session_id, status, source, created_at, updated_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             user_id = COALESCE(EXCLUDED.user_id, threads.user_id),
             tenant_id = COALESCE(EXCLUDED.tenant_id, threads.tenant_id),
             title = EXCLUDED.title, main_session_id = EXCLUDED.main_session_id,
             status = EXCLUDED.status, source = EXCLUDED.source,
             updated_at = EXCLUDED.updated_at, metadata = EXCLUDED.metadata`,
          [
            record.id,
            record.avatarId,
            record.userId ?? null,
            record.tenantId ?? null,
            record.title ?? null,
            record.mainSessionId ?? null,
            record.status,
            record.source ?? null,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
            jsonParam(record.metadata),
          ],
        );
        return record;
      },
      getThread: async (id, input = {}) => {
        const params: unknown[] = [id];
        const filters = ['id = $1'];
        appendOwnerFilters(filters, params, input);
        const result = await this.pool.query(`SELECT * FROM threads WHERE ${filters.join(' AND ')}`, params);
        return result.rows[0] ? rowToThread(result.rows[0]) : undefined;
      },
      listThreads: async (input = {}) => {
        const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
        const params: unknown[] = [];
        const filters: string[] = [];
        if (input.avatarId) {
          params.push(input.avatarId);
          filters.push(`avatar_id = $${params.length}`);
        }
        if (input.status) {
          params.push(input.status);
          filters.push(`status = $${params.length}`);
        }
        appendOwnerFilters(filters, params, input);
        params.push(limit);
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `SELECT * FROM threads ${where} ORDER BY updated_at DESC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToThread);
      },
      deleteThread: async (id, input = {}) => {
        const params: unknown[] = [id];
        const filters = ['id = $1'];
        appendOwnerFilters(filters, params, input);
        const result = await this.runInTx((q) =>
          q.query(
            `WITH target AS (
               SELECT id FROM threads WHERE ${filters.join(' AND ')}
             ),
             target_sessions AS (
               SELECT id FROM space_sessions WHERE thread_id IN (SELECT id FROM target)
             ),
             target_runs AS (
               SELECT id FROM runs WHERE thread_id IN (SELECT id FROM target)
             ),
             deleted_ledger AS (
               DELETE FROM ledger_events
               WHERE thread_id IN (SELECT id FROM target)
                  OR session_id IN (SELECT id FROM target_sessions)
                  OR run_id IN (SELECT id FROM target_runs)
             ),
             deleted_artifacts AS (
               DELETE FROM artifacts WHERE thread_id IN (SELECT id FROM target)
             ),
             deleted_cache AS (
               DELETE FROM runtime_cache_entries
               WHERE thread_id IN (SELECT id FROM target)
                  OR conversation_id IN (SELECT id FROM target)
             ),
             deleted_runs AS (
               DELETE FROM runs WHERE id IN (SELECT id FROM target_runs)
             )
             DELETE FROM threads WHERE id IN (SELECT id FROM target) RETURNING id`,
            params,
          ),
        );
        return (result.rowCount ?? 0) > 0;
      },
    };
  }

  private createSpaceSessionStore(): SpaceSessionStore {
    return {
      createSession: async (input) => {
        const now = new Date();
        const record: SpaceSessionRecord = {
          ...input,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
        };
        await this.pool.query(
          `INSERT INTO space_sessions
             (id, thread_id, avatar_id, user_id, tenant_id, space_id, kind, parent_session_id, root_goal, task,
              status, current_leaf_entry_id, source, created_at, updated_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET
             user_id = COALESCE(EXCLUDED.user_id, space_sessions.user_id),
             tenant_id = COALESCE(EXCLUDED.tenant_id, space_sessions.tenant_id),
             status = EXCLUDED.status,
             current_leaf_entry_id = COALESCE(EXCLUDED.current_leaf_entry_id, space_sessions.current_leaf_entry_id),
             updated_at = EXCLUDED.updated_at, metadata = EXCLUDED.metadata`,
          [
            record.id,
            record.threadId,
            record.avatarId,
            record.userId ?? null,
            record.tenantId ?? null,
            record.spaceId,
            record.kind,
            record.parentSessionId ?? null,
            record.rootGoal ?? null,
            record.task ?? null,
            record.status,
            record.currentLeafEntryId ?? null,
            record.source ?? null,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString(),
            jsonParam(record.metadata),
          ],
        );
        if (record.kind === 'main') {
          await this.pool.query(`UPDATE threads SET main_session_id = $1, updated_at = $2 WHERE id = $3`, [
            record.id,
            record.updatedAt.toISOString(),
            record.threadId,
          ]);
        }
        return record;
      },
      getSession: async (id, input = {}) => {
        const params: unknown[] = [id];
        const filters = ['id = $1'];
        if (input.avatarId) {
          params.push(input.avatarId);
          filters.push(`avatar_id = $${params.length}`);
        }
        appendOwnerFilters(filters, params, input);
        const result = await this.pool.query(`SELECT * FROM space_sessions WHERE ${filters.join(' AND ')}`, params);
        return result.rows[0] ? rowToSpaceSession(result.rows[0]) : undefined;
      },
      listSessions: async (input = {}) => {
        const params: unknown[] = [];
        const filters: string[] = [];
        const addFilter = (column: string, value: string | undefined) => {
          if (!value) {
            return;
          }
          params.push(value);
          filters.push(`${column} = $${params.length}`);
        };
        addFilter('thread_id', input.threadId);
        addFilter('parent_session_id', input.parentSessionId);
        addFilter('avatar_id', input.avatarId);
        addFilter('kind', input.kind);
        if (Array.isArray(input.status)) {
          if (input.status.length) {
            params.push(input.status);
            filters.push(`status = ANY($${params.length})`);
          }
        } else {
          addFilter('status', input.status);
        }
        appendOwnerFilters(filters, params, input);
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        params.push(limit);
        const result = await this.pool.query(
          `SELECT * FROM space_sessions
           ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
           ORDER BY updated_at DESC
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToSpaceSession);
      },
      appendEntry: async (input) => {
        const record: SessionEntryRecord = {
          ...input,
          createdAt: input.createdAt ?? new Date(),
        };
        await this.pool.query(
          `INSERT INTO session_entries
             (id, session_id, parent_entry_id, type, role, content, data, run_id, work_id,
              work_step_id, tool_call_id, artifact_id, token_count, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (id) DO NOTHING`,
          [
            record.id,
            record.sessionId,
            record.parentEntryId ?? null,
            record.type,
            record.role ?? null,
            record.content ?? null,
            jsonParam(record.data),
            record.runId ?? null,
            record.workId ?? null,
            record.workStepId ?? null,
            record.toolCallId ?? null,
            record.artifactId ?? null,
            record.tokenCount ?? null,
            record.createdAt.toISOString(),
          ],
        );
        if (input.leafName) {
          await this.sessions.setLeaf({
            sessionId: record.sessionId,
            name: input.leafName,
            entryId: record.id,
            updatedAt: record.createdAt,
          });
        }
        return record;
      },
      deleteEntry: async (input) => {
        if (input.userId || input.tenantId) {
          const session = await this.sessions.getSession(input.sessionId, { userId: input.userId, tenantId: input.tenantId });
          if (!session) {
            return false;
          }
        }
        const result = await this.pool.query(
          `UPDATE session_entries
           SET deleted_at = COALESCE(deleted_at, $3)
           WHERE id = $1 AND session_id = $2
           RETURNING id`,
          [input.entryId, input.sessionId, new Date().toISOString()],
        );
        return (result.rowCount ?? 0) > 0;
      },
      setLeaf: async (input) => {
        await this.pool.query(
          `INSERT INTO session_leafs (session_id, name, entry_id, updated_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (session_id, name) DO UPDATE SET
             entry_id = EXCLUDED.entry_id, updated_at = EXCLUDED.updated_at`,
          [input.sessionId, input.name, input.entryId ?? null, input.updatedAt.toISOString()],
        );
        await this.pool.query(
          `UPDATE space_sessions SET current_leaf_entry_id = $1, updated_at = $2 WHERE id = $3`,
          [input.entryId ?? null, input.updatedAt.toISOString(), input.sessionId],
        );
      },
      listEntries: async (input) => {
        if (input.avatarId || input.userId || input.tenantId) {
          const session = await this.sessions.getSession(input.sessionId, {
            avatarId: input.avatarId,
            userId: input.userId,
            tenantId: input.tenantId,
          });
          if (!session) {
            return [];
          }
        }
        const leafEntryId = input.leafEntryId ?? await this.resolveLeafEntryId(input.sessionId, input.leafName ?? 'current');
        let startEntryId = leafEntryId;
        if (input.beforeEntryId) {
          const cursor = await this.pool.query(
            `SELECT parent_entry_id FROM session_entries WHERE id = $1 AND session_id = $2`,
            [input.beforeEntryId, input.sessionId],
          );
          startEntryId = maybeString(cursor.rows[0]?.parent_entry_id);
        }
        if (!startEntryId) {
          return [];
        }
        const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
        const filters: string[] = [];
        const params: unknown[] = [startEntryId, input.sessionId, limit];
        if (input.type) {
          params.push(input.type);
          filters.push(`type = $${params.length}`);
        }
        if (input.projectionKind) {
          params.push(input.projectionKind);
          filters.push(`data->>'projectionKind' = $${params.length}`);
        }
        if ((input.visibility ?? 'active') !== 'audit') {
          filters.push('deleted_at IS NULL');
        }
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const result = await this.pool.query(
          `WITH RECURSIVE branch AS (
             SELECT *, 1 AS depth FROM session_entries WHERE id = $1 AND session_id = $2
             UNION ALL
             SELECT e.*, branch.depth + 1
             FROM session_entries e
             JOIN branch ON e.id = branch.parent_entry_id
             WHERE branch.depth < $3
           )
           SELECT * FROM branch ${where} ORDER BY depth DESC`,
          params,
        );
        return result.rows.map(rowToSessionEntry);
      },
      buildConversation: async (input) => {
        const entries = await this.sessions.listEntries(input);
        return buildConversationFromEntries(entries, input.visibility);
      },
      buildSessionContext: async (input) => {
        const entries = await this.sessions.listEntries(input);
        return projectSessionContextFromEntries(entries, input.visibility);
      },
    };
  }

  private createRuntimeCacheStore(): RuntimeCacheStore {
    const addFilter = (filters: string[], params: unknown[], column: string, value: string | undefined): void => {
      if (!value) return;
      params.push(value);
      filters.push(`${column} = $${params.length}`);
    };

    return {
      saveEntry: async (record) => {
        await this.pool.query(
          `INSERT INTO runtime_cache_entries
             (id, user_id, agent_id, thread_id, conversation_id, run_id, work_id, step_id,
              workspace_id, tool_call_id, tool_id, kind, title, summary, content, metadata, created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             agent_id = EXCLUDED.agent_id,
             thread_id = EXCLUDED.thread_id,
             conversation_id = EXCLUDED.conversation_id,
             run_id = EXCLUDED.run_id,
             work_id = EXCLUDED.work_id,
             step_id = EXCLUDED.step_id,
             workspace_id = EXCLUDED.workspace_id,
             tool_call_id = EXCLUDED.tool_call_id,
             tool_id = EXCLUDED.tool_id,
             kind = EXCLUDED.kind,
             title = EXCLUDED.title,
             summary = EXCLUDED.summary,
             content = EXCLUDED.content,
             metadata = EXCLUDED.metadata,
             created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at`,
          [
            record.id,
            record.userId ?? null,
            record.agentId ?? null,
            record.threadId ?? null,
            record.conversationId ?? null,
            record.runId ?? null,
            record.workId ?? null,
            record.stepId ?? null,
            record.workspaceId ?? null,
            record.toolCallId ?? null,
            record.toolId ?? null,
            record.kind,
            record.title,
            record.summary,
            record.content,
            jsonParam(record.metadata),
            record.createdAt.toISOString(),
            record.expiresAt?.toISOString() ?? null,
          ],
        );
      },
      listEntries: async (input = {}) => {
        const params: unknown[] = [];
        const filters: string[] = [];
        addFilter(filters, params, 'user_id', input.userId);
        addFilter(filters, params, 'agent_id', input.agentId);
        addFilter(filters, params, 'thread_id', input.threadId);
        addFilter(filters, params, 'conversation_id', input.conversationId);
        addFilter(filters, params, 'run_id', input.runId);
        addFilter(filters, params, 'workspace_id', input.workspaceId);
        filters.push('(expires_at IS NULL OR expires_at > NOW())');
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        params.push(limit);
        const result = await this.pool.query(
          `SELECT * FROM runtime_cache_entries
           ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
           ORDER BY created_at DESC
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToRuntimeCacheEntry);
      },
      getEntry: async (input) => {
        const params: unknown[] = [input.id];
        const filters = ['id = $1'];
        addFilter(filters, params, 'user_id', input.userId);
        addFilter(filters, params, 'agent_id', input.agentId);
        addFilter(filters, params, 'thread_id', input.threadId);
        addFilter(filters, params, 'conversation_id', input.conversationId);
        filters.push('(expires_at IS NULL OR expires_at > NOW())');
        const result = await this.pool.query(
          `SELECT * FROM runtime_cache_entries WHERE ${filters.join(' AND ')} LIMIT 1`,
          params,
        );
        return result.rows[0] ? rowToRuntimeCacheEntry(result.rows[0]) : undefined;
      },
      deleteByThread: async (input) => {
        const params: unknown[] = [input.threadId];
        const filters = ['thread_id = $1'];
        addFilter(filters, params, 'user_id', input.userId);
        addFilter(filters, params, 'agent_id', input.agentId);
        await this.pool.query(`DELETE FROM runtime_cache_entries WHERE ${filters.join(' AND ')}`, params);
      },
    };
  }

  private createLedgerStore(): RuntimeLedgerStore {
    return {
      saveRun: async (record) => {
        const result = await this.pool.query(
          `INSERT INTO runs
             (id, avatar_id, avatar_version, thread_id, main_session_id, status, goal,
              started_at, ended_at, error, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, ended_at = EXCLUDED.ended_at,
             error = EXCLUDED.error, metadata = EXCLUDED.metadata
           WHERE runs.thread_id IS NOT DISTINCT FROM EXCLUDED.thread_id
             AND runs.main_session_id IS NOT DISTINCT FROM EXCLUDED.main_session_id`,
          [
            record.id,
            record.avatarId,
            record.avatarVersion,
            record.threadId ?? null,
            record.mainSessionId ?? null,
            record.status,
            record.goal,
            record.startedAt.toISOString(),
            record.endedAt?.toISOString() ?? null,
            jsonParam(record.error),
            jsonParam(record.metadata),
          ],
        );
        assertLedgerUpsertApplied(result.rowCount, 'run', record.id);
      },
      saveWork: async (record) => {
        const result = await this.pool.query(
          `INSERT INTO works
             (id, run_id, thread_id, parent_session_id, status, goal, started_at, ended_at, error, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, ended_at = EXCLUDED.ended_at,
             error = EXCLUDED.error, metadata = EXCLUDED.metadata
           WHERE works.run_id = EXCLUDED.run_id
             AND works.thread_id IS NOT DISTINCT FROM EXCLUDED.thread_id
             AND works.parent_session_id IS NOT DISTINCT FROM EXCLUDED.parent_session_id`,
          [
            record.id,
            record.runId,
            record.threadId ?? null,
            record.parentSessionId ?? null,
            record.status,
            record.goal,
            record.startedAt.toISOString(),
            record.endedAt?.toISOString() ?? null,
            jsonParam(record.error),
            jsonParam(record.metadata),
          ],
        );
        assertLedgerUpsertApplied(result.rowCount, 'work', record.id);
      },
      saveWorkStep: async (record) => {
        const result = await this.pool.query(
          `INSERT INTO work_steps
             (id, work_id, workspace_id, session_id, status, started_at, ended_at,
              error, capability_snapshot_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             session_id = COALESCE(EXCLUDED.session_id, work_steps.session_id),
             status = EXCLUDED.status,
             started_at = COALESCE(EXCLUDED.started_at, work_steps.started_at),
             ended_at = EXCLUDED.ended_at,
             error = EXCLUDED.error, capability_snapshot_id = EXCLUDED.capability_snapshot_id,
             metadata = EXCLUDED.metadata
           WHERE work_steps.work_id = EXCLUDED.work_id
             AND work_steps.workspace_id = EXCLUDED.workspace_id`,
          [
            record.id,
            record.workId,
            record.workspaceId,
            record.sessionId ?? null,
            record.status,
            record.startedAt?.toISOString() ?? null,
            record.endedAt?.toISOString() ?? null,
            jsonParam(record.error),
            record.capabilitySnapshotId ?? null,
            jsonParam(record.metadata),
          ],
        );
        assertLedgerUpsertApplied(result.rowCount, 'work_step', record.id);
      },
      saveEvent: async (record) => {
        const result = await this.pool.query(
          `INSERT INTO ledger_events
             (id, run_id, work_id, work_step_id, thread_id, session_id,
              user_id, tenant_id, type, data, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             run_id = EXCLUDED.run_id,
             work_id = EXCLUDED.work_id,
             work_step_id = EXCLUDED.work_step_id,
             thread_id = EXCLUDED.thread_id,
             session_id = EXCLUDED.session_id,
             user_id = EXCLUDED.user_id,
             tenant_id = EXCLUDED.tenant_id,
             type = EXCLUDED.type,
             data = EXCLUDED.data,
             created_at = EXCLUDED.created_at
           WHERE ledger_events.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
             AND ledger_events.work_id IS NOT DISTINCT FROM EXCLUDED.work_id
             AND ledger_events.work_step_id IS NOT DISTINCT FROM EXCLUDED.work_step_id
             AND ledger_events.thread_id IS NOT DISTINCT FROM EXCLUDED.thread_id
             AND ledger_events.session_id IS NOT DISTINCT FROM EXCLUDED.session_id`,
          [
            record.id,
            record.runId ?? null,
            record.workId ?? null,
            record.workStepId ?? null,
            record.threadId ?? null,
            record.sessionId ?? null,
            record.userId ?? null,
            record.tenantId ?? null,
            record.type,
            jsonParam(record.data),
            record.createdAt.toISOString(),
          ],
        );
        assertLedgerUpsertApplied(result.rowCount, 'ledger_event', record.id);
      },
      listEvents: async (input = {}) => {
        const params: unknown[] = [];
        const filters: string[] = [];
        const addFilter = (column: string, value: string | undefined) => {
          if (!value) {
            return;
          }
          params.push(value);
          filters.push(`${column} = $${params.length}`);
        };
        addFilter('run_id', input.runId);
        addFilter('work_id', input.workId);
        addFilter('work_step_id', input.workStepId);
        addFilter('thread_id', input.threadId);
        addFilter('session_id', input.sessionId);
        addFilter('user_id', input.userId);
        addFilter('tenant_id', input.tenantId);
        addFilter('type', input.type);
        const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
        params.push(limit);
        const result = await this.pool.query(
          `SELECT * FROM ledger_events
           ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
           ORDER BY created_at DESC
           LIMIT $${params.length}`,
          params,
        );
        return result.rows.map(rowToLedgerEvent);
      },
      saveArtifact: async (record) => {
        const result = await this.pool.query(
          `INSERT INTO artifacts
             (id, run_id, work_id, work_step_id, thread_id, producer_session_id, target_session_id,
              workspace_id, kind, status, title, summary, content, data, content_uri, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary,
             content = EXCLUDED.content, data = EXCLUDED.data, content_uri = EXCLUDED.content_uri
           WHERE artifacts.run_id = EXCLUDED.run_id
             AND artifacts.work_id IS NOT DISTINCT FROM EXCLUDED.work_id
             AND artifacts.work_step_id IS NOT DISTINCT FROM EXCLUDED.work_step_id
             AND artifacts.thread_id = EXCLUDED.thread_id
             AND artifacts.producer_session_id = EXCLUDED.producer_session_id
             AND artifacts.workspace_id = EXCLUDED.workspace_id`,
          [
            record.id,
            record.runId,
            record.workId ?? null,
            record.workStepId ?? null,
            record.threadId,
            record.producerSessionId,
            record.targetSessionId ?? null,
            record.workspaceId,
            record.kind,
            record.status,
            record.title,
            record.summary,
            record.content ?? null,
            jsonParam(record.data),
            record.contentUri ?? null,
            record.createdAt.toISOString(),
          ],
        );
        assertLedgerUpsertApplied(result.rowCount, 'artifact', record.id);
      },
      getArtifact: async (id, input = {}) => {
        const params: unknown[] = [id];
        const filters = ['a.id = $1'];
        appendOwnerFilters(filters, params, input);
        const result = await this.pool.query(
          `SELECT a.*
           FROM artifacts a
           LEFT JOIN threads ON threads.id = a.thread_id
           WHERE ${filters.join(' AND ')}`,
          params,
        );
        return result.rows[0] ? rowToArtifact(result.rows[0]) : undefined;
      },
      saveArtifactReference: async (record) => {
        await this.pool.query(
          `INSERT INTO artifact_references
             (id, artifact_id, kind, uri, title, data, source_session_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             kind = EXCLUDED.kind, uri = EXCLUDED.uri, title = EXCLUDED.title,
             data = EXCLUDED.data, source_session_id = EXCLUDED.source_session_id`,
          [
            record.id,
            record.artifactId,
            record.kind,
            record.uri ?? null,
            record.title ?? null,
            jsonParam(record.data),
            record.sourceSessionId ?? null,
            record.createdAt.toISOString(),
          ],
        );
      },
      saveCapabilitySnapshot: async (record) => {
        await this.pool.query(
          `INSERT INTO capability_snapshots
             (id, avatar_id, avatar_version, space_id, space_version, model_config_id,
              summary_model_config_id, capabilities, memory_policy, permission_policy, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             capabilities = EXCLUDED.capabilities, memory_policy = EXCLUDED.memory_policy,
             permission_policy = EXCLUDED.permission_policy`,
          [
            record.id,
            record.avatarId,
            record.avatarVersion,
            record.spaceId,
            record.spaceVersion,
            record.modelConfigId ?? null,
            record.summaryModelConfigId ?? null,
            jsonParam(record.capabilities),
            jsonParam(record.memoryPolicy),
            jsonParam(record.permissionPolicy),
            record.createdAt.toISOString(),
          ],
        );
      },
    };
  }

  private async resolveLeafEntryId(sessionId: string, leafName: string): Promise<string | undefined> {
    const result = await this.pool.query(
      `SELECT COALESCE(l.entry_id, s.current_leaf_entry_id) AS entry_id
       FROM space_sessions s
       LEFT JOIN session_leafs l ON l.session_id = s.id AND l.name = $2
       WHERE s.id = $1`,
      [sessionId, leafName],
    );
    return maybeString(result.rows[0]?.entry_id);
  }
}

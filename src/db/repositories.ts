import type Database from "better-sqlite3";
import type {
  AgentConfig,
  ApprovalRequest,
  AuditLog,
  ConversationSummary,
  ContextSegment,
  DatabaseTableRows,
  DatabaseTableSummary,
  LLMCallSnapshot,
  McpServerDefinition,
  MemoryRow,
  RuntimeConfigItem,
  SessionEntry,
  SessionEntryContextMessage,
  SessionEntryType,
  StoredMessage,
  ToolDefinition,
  ToolCallLog,
  UserRole,
  WorkspaceDefinition,
  WorkspaceLocalContext,
  WorkspaceMemoryPolicy,
  WorkspaceSession
} from "../types";
import { createId, nowIso } from "../core/id";
import { RUNTIME_CONFIG_DEFINITIONS, runtimeConfigDefaults, validateRuntimeConfigValue } from "../core/runtime-config";

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function compactSessionEntryText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function sessionEntryWorkspaceIdFromPayload(entry: Pick<SessionEntry, "workspaceId">, payload: Record<string, unknown>): string | undefined {
  if (typeof entry.workspaceId === "string" && entry.workspaceId.trim()) return entry.workspaceId;
  if (typeof payload.workspaceId === "string" && payload.workspaceId.trim()) return payload.workspaceId;
  return undefined;
}

function workspaceIdFromContextSegments(segments: ContextSegment[]): string | undefined {
  const workspaceSegment = segments.find((segment) => segment.segmentType === "workspace");
  if (!workspaceSegment) return undefined;
  return workspaceIdFromContextSegmentContent(workspaceSegment.content);
}

function workspaceIdFromContextSegmentContent(content: string): string | undefined {
  const payload = parseJson<{ currentWorkspace?: { id?: string } }>(content, {});
  const workspaceId = payload.currentWorkspace?.id;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId : undefined;
}

function summarizeSessionEntryToolResult(resultJson: string, maxLength = 500): string {
  let text = resultJson;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    if (typeof parsed.error === "string") text = `失败：${parsed.error}`;
    else if (typeof parsed.output === "string" && parsed.output.trim()) text = parsed.output;
    else if (typeof parsed.stdout === "string" && parsed.stdout.trim()) text = parsed.stdout;
    else if (typeof parsed.summary === "string" && parsed.summary.trim()) text = parsed.summary;
    else if (typeof parsed.response === "string" && parsed.response.trim()) text = parsed.response;
    else if (typeof parsed.question === "string" && parsed.question.trim()) text = parsed.question;
    else if (typeof parsed.type === "string" && parsed.type.trim()) text = parsed.type;
    else text = JSON.stringify(parsed);
  } catch {
    text = resultJson;
  }
  return compactSessionEntryText(text, maxLength);
}

function appendSessionEntryContextMessage(
  target: SessionEntryContextMessage[],
  entry: SessionEntry,
  role: SessionEntryContextMessage["role"],
  content: string,
  workspaceId?: string
): void {
  const normalized = content.trim();
  if (!normalized) return;
  target.push({
    role,
    content: normalized,
    workspaceId,
    entryId: entry.id,
    sourceType: entry.type,
    createdAt: entry.createdAt
  });
}

function parseStrictJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function sanitizeToolIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "tool";
}

function oneLinePromptSnippet(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 180) : null;
}

function quoteSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid table name: ${value}`);
  return `"${value.replace(/"/g, "\"\"")}"`;
}

type RuntimeConfigRawRow = {
  key: string;
  category: string;
  label: string;
  description: string;
  valueType: "number" | "boolean" | "string";
  valueJson: string;
  defaultValueJson: string;
  minValue: number | null;
  maxValue: number | null;
  step: number | null;
  updatedAt: string;
};

export function mcpServerToBindingJson(server: Pick<McpServerDefinition, "transport" | "command" | "argsJson" | "envJson" | "cwd" | "url" | "headersJson" | "timeoutMs">): string {
  if (server.transport === "stdio") {
    return JSON.stringify({
      transport: "stdio",
      command: server.command,
      args: parseStrictJson<string[]>(server.argsJson || "[]", "MCP server argsJson"),
      env: parseStrictJson<Record<string, string>>(server.envJson || "{}", "MCP server envJson"),
      cwd: server.cwd || undefined,
      timeoutMs: server.timeoutMs
    });
  }
  return JSON.stringify({
    transport: "streamable-http",
    url: server.url,
    headers: parseStrictJson<Record<string, string>>(server.headersJson || "{}", "MCP server headersJson"),
    timeoutMs: server.timeoutMs
  });
}

function buildFtsQuery(value: string): string {
  return (value.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, 8)
    .map((term) => `"${term.replace(/"/g, "\"\"")}"`)
    .join(" OR ");
}

function conversationTitleFromMessage(conversationId: string, content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return (normalized || conversationId).slice(0, 48);
}

function conversationPreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120);
}

const defaultMemoryPolicy: WorkspaceMemoryPolicy = {
  eventRecallEnabled: true,
  skillRecallEnabled: true,
  eventWriteEnabled: true,
  skillWriteEnabled: true,
  maxEventMemories: 4,
  maxSkillMemories: 4
};

const builtInMemoryToolIds = [
  "tool-search-memory",
  "tool-read-memory",
  "tool-read-skill",
  "tool-write-user-impression",
  "tool-write-agent-self-impression",
  "tool-write-skill-memory"
];

const builtInRuntimeToolIds = new Set([
  "tool-enter-workspace",
  "tool-exit-workspace",
  "tool-ask-user",
  "tool-finish-task",
  "tool-read",
  "tool-write",
  "tool-edit",
  "tool-bash",
  ...builtInMemoryToolIds
]);

function normalizeWorkspace(row: Omit<WorkspaceDefinition, "tools">, tools: ToolDefinition[]): WorkspaceDefinition {
  const capabilities = parseJson<string[]>(row.capabilitiesJson ?? "[]", []);
  const inputKinds = parseJson<string[]>(row.inputKindsJson ?? "[]", []);
  const outputKinds = parseJson<string[]>(row.outputKindsJson ?? "[]", []);
  const memoryPolicy = {
    ...defaultMemoryPolicy,
    ...parseJson<Partial<WorkspaceMemoryPolicy>>(row.memoryPolicyJson ?? "{}", {})
  };
  return {
    ...row,
    capabilitiesJson: row.capabilitiesJson ?? "[]",
    inputKindsJson: row.inputKindsJson ?? "[]",
    outputKindsJson: row.outputKindsJson ?? "[]",
    requiresApproval: Number(row.requiresApproval ?? 0),
    memoryPolicyJson: row.memoryPolicyJson ?? "{}",
    manifest: {
      id: row.id,
      name: row.name,
      description: row.description,
      capabilities,
      inputKinds,
      outputKinds,
      riskLevel: row.riskLevel,
      requiresApproval: Boolean(row.requiresApproval)
    },
    memoryPolicy,
    tools
  };
}

export class Repositories {
  constructor(private readonly db: Database.Database) {}

  listRuntimeConfigs(actorRole: UserRole): RuntimeConfigItem[] {
    if (actorRole !== "creator") throw new Error("Runtime configuration requires creator role.");
    return this.runtimeConfigRows().map((row) => this.normalizeRuntimeConfig(row));
  }

  getRuntimeConfigValues(): Record<string, unknown> {
    const values = runtimeConfigDefaults();
    for (const row of this.runtimeConfigRows()) {
      values[row.key] = parseJson(row.valueJson, values[row.key]);
    }
    return values;
  }

  updateRuntimeConfig(input: { key: string; value: unknown; actorId: string; actorRole: UserRole }): RuntimeConfigItem {
    if (input.actorRole !== "creator") throw new Error("Runtime configuration updates require creator role.");
    const definition = RUNTIME_CONFIG_DEFINITIONS.find((item) => item.key === input.key);
    if (!definition) throw new Error(`Unknown runtime config key: ${input.key}`);
    const value = validateRuntimeConfigValue(definition, input.value);
    const updatedAt = nowIso();
    const previous = this.db.prepare("SELECT * FROM runtime_config WHERE key = ?").get(input.key) as RuntimeConfigRawRow | undefined;
    this.db.prepare(`
      INSERT INTO runtime_config
        (key, category, label, description, valueType, valueJson, defaultValueJson, minValue, maxValue, step, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        valueJson = excluded.valueJson,
        updatedAt = excluded.updatedAt
    `).run(
      definition.key,
      definition.category,
      definition.label,
      definition.description,
      definition.valueType,
      JSON.stringify(value),
      JSON.stringify(definition.defaultValue),
      definition.minValue ?? null,
      definition.maxValue ?? null,
      definition.step ?? null,
      updatedAt
    );
    this.audit(input.actorId, input.actorRole, "runtime_config_update", "runtime_config", input.key, {
      key: input.key,
      previousValue: previous ? parseJson(previous.valueJson, undefined) : undefined,
      nextValue: value
    });
    return this.normalizeRuntimeConfig(this.db.prepare("SELECT * FROM runtime_config WHERE key = ?").get(input.key) as RuntimeConfigRawRow);
  }

  private runtimeConfigRows(): RuntimeConfigRawRow[] {
    return this.db.prepare("SELECT * FROM runtime_config ORDER BY category, key").all() as RuntimeConfigRawRow[];
  }

  private normalizeRuntimeConfig(row: RuntimeConfigRawRow): RuntimeConfigItem {
    return {
      key: row.key,
      category: row.category,
      label: row.label,
      description: row.description,
      valueType: row.valueType,
      value: parseJson(row.valueJson, parseJson(row.defaultValueJson, "")),
      defaultValue: parseJson(row.defaultValueJson, ""),
      minValue: row.minValue ?? undefined,
      maxValue: row.maxValue ?? undefined,
      step: row.step ?? undefined,
      updatedAt: row.updatedAt
    };
  }

  listDatabaseTables(actorRole: UserRole): DatabaseTableSummary[] {
    if (actorRole !== "creator") throw new Error("Database table inspection requires creator role.");
    const rows = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    return rows.map((row) => {
      const tableName = quoteSqlIdentifier(row.name);
      const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
      return { name: row.name, rowCount: count };
    });
  }

  readDatabaseTable(table: string, input: { actorRole: UserRole; limit?: number; offset?: number }): DatabaseTableRows {
    if (input.actorRole !== "creator") throw new Error("Database table inspection requires creator role.");
    const available = new Set(this.listDatabaseTables(input.actorRole).map((item) => item.name));
    if (!available.has(table)) throw new Error(`Database table not found: ${table}`);
    const tableName = quoteSqlIdentifier(table);
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const columns = (this.db.pragma(`table_info(${tableName})`) as Array<{ name: string }>).map((column) => column.name);
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM ${tableName} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
    return { table, columns, rows, total, limit, offset };
  }

  getAgent(agentId: string): AgentConfig {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentConfig | undefined;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    return row;
  }

  listAgents(): AgentConfig[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY createdAt ASC").all() as AgentConfig[];
  }

  createAgent(agent: Omit<AgentConfig, "createdAt" | "updatedAt"> & { actorId?: string; actorRole?: UserRole }): AgentConfig {
    const actorId = agent.actorId ?? "user";
    const actorRole = agent.actorRole ?? "user";
    if (actorRole !== "creator") throw new Error("Agent creation requires creator role.");
    const id = agent.id.trim();
    if (!id) throw new Error("Agent id is required.");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Agent id may only contain letters, numbers, hyphens, and underscores.");
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO agents (id, name, systemPrompt, personalityPrompt, defaultModel, defaultBaseUrl, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, agent.name.trim() || id, agent.systemPrompt, agent.personalityPrompt, agent.defaultModel, agent.defaultBaseUrl, now, now);
    this.audit(actorId, actorRole, "agent_create", "agent", id, {
      name: agent.name,
      defaultModel: agent.defaultModel,
      defaultBaseUrl: agent.defaultBaseUrl
    });
    return this.getAgent(id);
  }

  updateAgent(agent: AgentConfig & { actorId?: string; actorRole?: UserRole }): AgentConfig {
    const actorId = agent.actorId ?? "user";
    const actorRole = agent.actorRole ?? "user";
    if (actorRole !== "creator") throw new Error("Agent configuration updates require creator role.");
    const updatedAt = nowIso();
    const previous = this.getAgent(agent.id);
    this.db.prepare(`
      UPDATE agents SET name = ?, systemPrompt = ?, personalityPrompt = ?, defaultModel = ?, defaultBaseUrl = ?, updatedAt = ?
      WHERE id = ?
    `).run(agent.name, agent.systemPrompt, agent.personalityPrompt, agent.defaultModel, agent.defaultBaseUrl, updatedAt, agent.id);
    this.audit(actorId, actorRole, "agent_update", "agent", agent.id, {
      previous: {
        name: previous.name,
        defaultModel: previous.defaultModel,
        defaultBaseUrl: previous.defaultBaseUrl
      },
      next: {
        name: agent.name,
        defaultModel: agent.defaultModel,
        defaultBaseUrl: agent.defaultBaseUrl
      },
      changedFields: ["name", "systemPrompt", "personalityPrompt", "defaultModel", "defaultBaseUrl"].filter((field) => previous[field as keyof AgentConfig] !== agent[field as keyof AgentConfig])
    });
    return this.getAgent(agent.id);
  }

  ensureConversation(conversationId: string, agentId: string, userId: string): void {
    if (!userId.trim()) throw new Error("userId is required.");
    if (!conversationId.trim()) throw new Error("conversationId is required.");
    const existing = this.db.prepare("SELECT id, agentId, userId FROM conversations WHERE id = ?").get(conversationId) as { id: string; agentId: string; userId: string } | undefined;
    if (existing) {
      if (existing.userId !== userId || existing.agentId !== agentId) {
        throw new Error("Conversation ownership mismatch: conversationId belongs to a different user or agent.");
      }
      this.db.prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?").run(nowIso(), conversationId);
      return;
    }
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO conversations (id, agentId, userId, title, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId, agentId, userId, conversationId, now, now);
  }

  getConversation(conversationId: string): { id: string; agentId: string; userId: string; title: string; createdAt: string; updatedAt: string } | undefined {
    return this.db.prepare("SELECT id, agentId, userId, title, createdAt, updatedAt FROM conversations WHERE id = ?").get(conversationId) as { id: string; agentId: string; userId: string; title: string; createdAt: string; updatedAt: string } | undefined;
  }

  private conversationSummaryForId(conversationId: string): ConversationSummary {
    const row = this.db.prepare(`
      SELECT
        conversations.id,
        conversations.agentId,
        conversations.userId,
        conversations.title,
        conversations.createdAt,
        conversations.updatedAt,
        COUNT(messages.id) AS messageCount,
        (
          SELECT content FROM messages latest
          WHERE latest.conversationId = conversations.id
          ORDER BY latest.createdAt DESC, latest.rowid DESC
          LIMIT 1
        ) AS lastMessagePreview
      FROM conversations
      LEFT JOIN messages ON messages.conversationId = conversations.id
      WHERE conversations.id = ?
      GROUP BY conversations.id
    `).get(conversationId) as (Omit<ConversationSummary, "messageCount"> & { messageCount: number; lastMessagePreview?: string | null }) | undefined;
    if (!row) throw new Error("Conversation not found.");
    return {
      ...row,
      messageCount: Number(row.messageCount),
      lastMessagePreview: row.lastMessagePreview ? conversationPreview(row.lastMessagePreview) : undefined
    };
  }

  listConversations(filters: { actorId: string; actorRole: UserRole; agentId?: string; userId?: string; limit?: number }): ConversationSummary[] {
    if (!filters.actorId.trim()) throw new Error("Conversation list requires explicit actorId.");
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.actorRole !== "creator") {
      clauses.push("conversations.userId = ?");
      params.push(filters.actorId);
    } else if (filters.userId?.trim()) {
      clauses.push("conversations.userId = ?");
      params.push(filters.userId.trim());
    }
    if (filters.agentId?.trim()) {
      clauses.push("conversations.agentId = ?");
      params.push(filters.agentId.trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 50)));
    const rows = this.db.prepare(`
      SELECT
        conversations.id,
        conversations.agentId,
        conversations.userId,
        conversations.title,
        conversations.createdAt,
        conversations.updatedAt,
        COUNT(messages.id) AS messageCount,
        (
          SELECT content FROM messages latest
          WHERE latest.conversationId = conversations.id
          ORDER BY latest.createdAt DESC, latest.rowid DESC
          LIMIT 1
        ) AS lastMessagePreview
      FROM conversations
      LEFT JOIN messages ON messages.conversationId = conversations.id
      ${where}
      GROUP BY conversations.id
      ORDER BY conversations.updatedAt DESC, conversations.createdAt DESC
      LIMIT ?
    `).all(...params, limit) as Array<Omit<ConversationSummary, "messageCount"> & { messageCount: number; lastMessagePreview?: string | null }>;
    return rows.map((row) => ({
      ...row,
      messageCount: Number(row.messageCount),
      lastMessagePreview: row.lastMessagePreview ? conversationPreview(row.lastMessagePreview) : undefined
    }));
  }

  listConversationMessages(conversationId: string, actorId: string, actorRole: UserRole, limit = 200): StoredMessage[] {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    if (actorRole !== "creator" && conversation.userId !== actorId) {
      throw new Error("Conversation messages can only be read by their owner or a creator.");
    }
    return this.listMessagesDetailed(conversationId, Math.max(1, Math.min(500, Math.floor(limit))));
  }

  updateConversationTitle(conversationId: string, title: string, actorId: string, actorRole: UserRole): ConversationSummary {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    if (actorRole !== "creator" && conversation.userId !== actorId) {
      throw new Error("Conversation can only be renamed by its owner or a creator.");
    }
    const normalized = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!normalized) throw new Error("Conversation title is required.");
    this.db.prepare("UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?").run(normalized, nowIso(), conversationId);
    return this.conversationSummaryForId(conversationId);
  }

  addMessage(conversationId: string, role: string, content: string, raw: unknown = {}): string {
    const id = createId("msg");
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO messages (id, conversationId, role, content, rawJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, content, JSON.stringify(raw), now);
    const conversation = this.getConversation(conversationId);
    if (conversation) {
      const nextTitle = role === "user" && conversation.title === conversation.id
        ? conversationTitleFromMessage(conversationId, content)
        : conversation.title;
      this.db.prepare("UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?").run(nextTitle, now, conversationId);
    }
    this.appendSessionEntry({
      conversationId,
      type: "message",
      payload: {
        messageId: id,
        role,
        content,
        raw
      }
    });
    return id;
  }

  deleteMessage(messageId: string): void {
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  }

  listMessages(conversationId: string, limit = 12): Array<{ role: string; content: string; rawJson: string; createdAt: string }> {
    return this.db.prepare(`
      SELECT role, content, rawJson, createdAt FROM messages
      WHERE conversationId = ?
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(conversationId, limit).reverse() as Array<{ role: string; content: string; rawJson: string; createdAt: string }>;
  }

  listMessagesDetailed(conversationId: string, limit = 200): StoredMessage[] {
    return this.db.prepare(`
      SELECT id, conversationId, role, content, rawJson, createdAt FROM messages
      WHERE conversationId = ?
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(conversationId, limit).reverse() as StoredMessage[];
  }

  countMessages(conversationId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversationId = ?").get(conversationId) as { count: number }).count;
  }

  appendSessionEntry(input: {
    conversationId: string;
    workspaceId?: string;
    type: SessionEntryType;
    payload: unknown;
  }): SessionEntry {
    const id = createId("entry");
    const now = nowIso();
    const parent = this.db.prepare(`
      SELECT id FROM session_entries
      WHERE conversationId = ?
      ORDER BY createdAt DESC, rowid DESC
      LIMIT 1
    `).get(input.conversationId) as { id: string } | undefined;
    const row: SessionEntry = {
      id,
      conversationId: input.conversationId,
      parentId: parent?.id,
      workspaceId: input.workspaceId,
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      createdAt: now
    };
    this.db.prepare(`
      INSERT INTO session_entries (id, conversationId, parentId, workspaceId, type, payloadJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.conversationId, row.parentId ?? null, row.workspaceId ?? null, row.type, row.payloadJson, row.createdAt);
    return row;
  }

  listSessionEntries(conversationId: string, userId?: string): SessionEntry[] {
    if (userId) {
      const conversation = this.getConversation(conversationId);
      if (conversation && conversation.userId !== userId) return [];
    }
    return this.db.prepare(`
      SELECT * FROM session_entries
      WHERE conversationId = ?
      ORDER BY createdAt ASC, rowid ASC
    `).all(conversationId) as SessionEntry[];
  }

  listSessionEntryMainChain(conversationId: string, userId?: string): SessionEntry[] {
    const entries = this.listSessionEntries(conversationId, userId);
    if (entries.length === 0) return [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const chain: SessionEntry[] = [];
    const seen = new Set<string>();
    let current: SessionEntry | undefined = entries[entries.length - 1];
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain.reverse();
  }

  reconstructSessionEntryContext(input: {
    conversationId: string;
    userId?: string;
    workspaceId?: string;
    limit?: number;
  }): SessionEntryContextMessage[] {
    const entries = this.listSessionEntryMainChain(input.conversationId, input.userId);
    const messages: SessionEntryContextMessage[] = [];
    for (const entry of entries) {
      const payload = parseJson<Record<string, unknown>>(entry.payloadJson, {});
      const workspaceId = sessionEntryWorkspaceIdFromPayload(entry, payload);
      if (input.workspaceId && workspaceId !== input.workspaceId) continue;

      if (entry.type === "message") {
        const role = typeof payload.role === "string" ? payload.role : "";
        const content = typeof payload.content === "string" ? payload.content : "";
        if (role === "user" || role === "assistant" || role === "tool") {
          appendSessionEntryContextMessage(messages, entry, role, content, workspaceId);
        }
        continue;
      }

      if (entry.type === "llm_call" && payload.status === "completed") {
        const response = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
          ? payload.response as Record<string, unknown>
          : {};
        const assistantMessage = typeof response.assistantMessage === "string" ? response.assistantMessage : "";
        if (assistantMessage) {
          appendSessionEntryContextMessage(messages, entry, "assistant", assistantMessage, workspaceId);
        }
        const message = response.message && typeof response.message === "object" && !Array.isArray(response.message)
          ? response.message as Record<string, unknown>
          : {};
        const content = typeof message.content === "string" ? message.content : "";
        if (content && content !== assistantMessage) {
          appendSessionEntryContextMessage(messages, entry, "assistant", content, workspaceId);
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const toolNames = toolCalls
          .map((toolCall) => toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)
            ? (toolCall as { function?: { name?: unknown } }).function?.name
            : undefined)
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
        if (toolNames.length > 0) {
          appendSessionEntryContextMessage(messages, entry, "assistant", `调用工具：${toolNames.join(", ")}`, workspaceId);
        }
        continue;
      }

      if (entry.type === "tool_call") {
        const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
        if (toolName) appendSessionEntryContextMessage(messages, entry, "assistant", `调用工具：${toolName}`, workspaceId);
        continue;
      }

      if (entry.type === "tool_result") {
        const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const resultJson = typeof payload.resultJson === "string" ? payload.resultJson : "";
        appendSessionEntryContextMessage(messages, entry, "tool", `${toolName}: ${summarizeSessionEntryToolResult(resultJson)}`, workspaceId);
      }
    }
    return messages.slice(-(input.limit ?? 40));
  }

  private hasSessionEntryForResource(conversationId: string, type: SessionEntryType, key: string, value: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM session_entries
      WHERE conversationId = ?
        AND type = ?
        AND json_extract(payloadJson, ?) = ?
      LIMIT 1
    `).get(conversationId, type, `$.${key}`, value) as { id: string } | undefined;
    return Boolean(row);
  }

  listMessagesWindow(conversationId: string, offset: number, limit: number): StoredMessage[] {
    return this.db.prepare(`
      SELECT id, conversationId, role, content, rawJson, createdAt FROM messages
      WHERE conversationId = ?
      ORDER BY createdAt ASC
      LIMIT ? OFFSET ?
    `).all(conversationId, limit, offset) as StoredMessage[];
  }

  listMessagesInRange(conversationId: string, startAt: string, endAt: string, limit = 100): StoredMessage[] {
    return this.db.prepare(`
      SELECT id, conversationId, role, content, rawJson, createdAt FROM messages
      WHERE conversationId = ?
        AND createdAt >= ?
        AND createdAt <= ?
      ORDER BY createdAt ASC, rowid ASC
      LIMIT ?
    `).all(conversationId, startAt, endAt, limit) as StoredMessage[];
  }

  listMessagesBefore(conversationId: string, beforeAt: string, limit = 1): StoredMessage[] {
    return this.db.prepare(`
      SELECT id, conversationId, role, content, rawJson, createdAt FROM messages
      WHERE conversationId = ?
        AND createdAt <= ?
      ORDER BY createdAt DESC, rowid DESC
      LIMIT ?
    `).all(conversationId, beforeAt, limit).reverse() as StoredMessage[];
  }

  deleteConversation(conversationId: string, actorId: string, actorRole: UserRole, deleteReason = "manual conversation delete"): void {
    const current = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as { id: string; userId: string; agentId: string } | undefined;
    if (!current) return;
    if (actorRole !== "creator" && current.userId !== actorId) {
      throw new Error("Conversation can only be deleted by its owner or a creator.");
    }
    const counts = {
      messages: (this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversationId = ?").get(conversationId) as { count: number }).count,
      workspaceSessions: (this.db.prepare("SELECT COUNT(*) AS count FROM workspace_sessions WHERE conversationId = ?").get(conversationId) as { count: number }).count,
      llmCalls: (this.db.prepare("SELECT COUNT(*) AS count FROM llm_calls WHERE conversationId = ?").get(conversationId) as { count: number }).count,
      toolCalls: (this.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE conversationId = ?").get(conversationId) as { count: number }).count,
      approvalRequests: (this.db.prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE conversationId = ?").get(conversationId) as { count: number }).count
    };
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM approval_requests WHERE conversationId = ?").run(conversationId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      this.audit(actorId, actorRole, "conversation_delete", "conversation", conversationId, {
        conversationId,
        userId: current.userId,
        agentId: current.agentId,
        deleteReason,
        deletedRecords: counts
      });
    })();
  }

  listWorkspaces(): WorkspaceDefinition[] {
    const rows = this.db.prepare("SELECT * FROM workspaces ORDER BY id").all() as Array<Omit<WorkspaceDefinition, "tools">>;
    return rows.map((row) => normalizeWorkspace(row, this.listToolsForWorkspace(row.id)));
  }

  getWorkspace(id: string): WorkspaceDefinition {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Omit<WorkspaceDefinition, "tools"> | undefined;
    if (!row) throw new Error(`Workspace not found: ${id}`);
    return normalizeWorkspace(row, this.listToolsForWorkspace(id));
  }

  listMcpServers(workspaceId?: string): McpServerDefinition[] {
    if (workspaceId) {
      return this.db.prepare("SELECT * FROM mcp_servers WHERE workspaceId = ? ORDER BY name").all(workspaceId) as McpServerDefinition[];
    }
    return this.db.prepare("SELECT * FROM mcp_servers ORDER BY workspaceId, name").all() as McpServerDefinition[];
  }

  getMcpServer(id: string): McpServerDefinition {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerDefinition | undefined;
    if (!row) throw new Error(`MCP server not found: ${id}`);
    return row;
  }

  upsertMcpServer(input: Partial<McpServerDefinition> & Pick<McpServerDefinition, "workspaceId" | "name" | "transport"> & { actorId: string; actorRole: UserRole }): McpServerDefinition {
    if (input.actorRole !== "creator") throw new Error("MCP server setup requires creator role.");
    this.getWorkspace(input.workspaceId);
    const id = input.id?.trim() || createId("mcp");
    const name = input.name.trim();
    if (!name) throw new Error("MCP server name is required.");
    if (input.transport !== "stdio" && input.transport !== "streamable-http") throw new Error("MCP server transport must be stdio or streamable-http.");
    const args = parseStrictJson<unknown>(input.argsJson || "[]", "MCP server argsJson");
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error("MCP server argsJson must be a JSON string array.");
    const env = parseStrictJson<unknown>(input.envJson || "{}", "MCP server envJson");
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("MCP server envJson must be a JSON object.");
    const headers = parseStrictJson<unknown>(input.headersJson || "{}", "MCP server headersJson");
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("MCP server headersJson must be a JSON object.");
    if (input.transport === "stdio" && !input.command?.trim()) throw new Error("Local stdio MCP server requires command.");
    if (input.transport === "streamable-http" && !input.url?.trim()) throw new Error("Remote MCP server requires url.");
    const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Math.floor(Number(input.timeoutMs ?? 30000))));
    const now = nowIso();
    const existing = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerDefinition | undefined;
    if (existing && existing.workspaceId !== input.workspaceId) throw new Error("MCP server belongs to a different workspace.");

    this.db.prepare(`
      INSERT INTO mcp_servers
        (id, workspaceId, name, transport, command, argsJson, envJson, cwd, url, headersJson, timeoutMs, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        transport = excluded.transport,
        command = excluded.command,
        argsJson = excluded.argsJson,
        envJson = excluded.envJson,
        cwd = excluded.cwd,
        url = excluded.url,
        headersJson = excluded.headersJson,
        timeoutMs = excluded.timeoutMs,
        updatedAt = excluded.updatedAt
    `).run(
      id,
      input.workspaceId,
      name,
      input.transport,
      input.transport === "stdio" ? input.command?.trim() : null,
      JSON.stringify(args),
      JSON.stringify(env),
      input.transport === "stdio" ? input.cwd?.trim() || null : null,
      input.transport === "streamable-http" ? input.url?.trim() : null,
      JSON.stringify(headers),
      timeoutMs,
      existing?.createdAt ?? now,
      now
    );
    this.audit(input.actorId, input.actorRole, existing ? "mcp_server_update" : "mcp_server_create", "mcp_server", id, {
      workspaceId: input.workspaceId,
      transport: input.transport,
      name
    });
    return this.getMcpServer(id);
  }

  deleteMcpServer(workspaceId: string, serverId: string, actorId: string, actorRole: UserRole, deleteReason = "manual MCP server delete"): void {
    if (actorRole !== "creator") throw new Error("MCP server deletion requires creator role.");
    const server = this.getMcpServer(serverId);
    if (server.workspaceId !== workspaceId) throw new Error("MCP server belongs to a different workspace.");
    this.db.transaction(() => {
      const tools = this.db.prepare("SELECT id FROM tool_definitions WHERE workspaceId = ? AND mcpServerId = ?").all(workspaceId, serverId) as Array<{ id: string }>;
      for (const tool of tools) {
        this.db.prepare("DELETE FROM workspace_tools WHERE workspaceId = ? AND toolId = ?").run(workspaceId, tool.id);
        this.db.prepare("DELETE FROM tool_definitions WHERE id = ?").run(tool.id);
      }
      this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(serverId);
      this.audit(actorId, actorRole, "mcp_server_delete", "mcp_server", serverId, {
        workspaceId,
        serverName: server.name,
        deletedToolIds: tools.map((tool) => tool.id),
        deleteReason
      });
    })();
  }

  importMcpServerTools(input: {
    workspaceId: string;
    serverId: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    actorId: string;
    actorRole: UserRole;
  }): ToolDefinition[] {
    if (input.actorRole !== "creator") throw new Error("MCP tool import requires creator role.");
    const server = this.getMcpServer(input.serverId);
    if (server.workspaceId !== input.workspaceId) throw new Error("MCP server belongs to a different workspace.");
    const bindingJson = mcpServerToBindingJson(server);
    const now = nowIso();
    const imported: ToolDefinition[] = [];
    this.db.transaction(() => {
      for (const discovered of input.tools) {
        const name = discovered.name.trim();
        if (!name) continue;
        const existingByName = this.db.prepare("SELECT * FROM tool_definitions WHERE name = ?").get(name) as ToolDefinition | undefined;
        if (existingByName && (existingByName.workspaceId !== input.workspaceId || existingByName.mcpServerId !== input.serverId || existingByName.mcpToolName !== name)) {
          throw new Error(`Tool name already exists outside this MCP server binding: ${name}`);
        }
        const id = existingByName?.id ?? `tool-${sanitizeToolIdPart(input.workspaceId)}-${sanitizeToolIdPart(input.serverId)}-${sanitizeToolIdPart(name)}`;
        this.db.prepare(`
          INSERT INTO tool_definitions
            (id, name, workspaceId, description, parametersJson, promptSnippet, promptGuidelinesJson, executionMode, riskLevel, bindingType, bindingJson, mcpServerId, mcpToolName, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            workspaceId = excluded.workspaceId,
            description = excluded.description,
            parametersJson = excluded.parametersJson,
            promptSnippet = excluded.promptSnippet,
            promptGuidelinesJson = excluded.promptGuidelinesJson,
            executionMode = excluded.executionMode,
            riskLevel = excluded.riskLevel,
            bindingType = excluded.bindingType,
            bindingJson = excluded.bindingJson,
            mcpServerId = excluded.mcpServerId,
            mcpToolName = excluded.mcpToolName,
            updatedAt = excluded.updatedAt
        `).run(
          id,
          name,
          input.workspaceId,
          discovered.description ?? "",
          JSON.stringify(discovered.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }),
          oneLinePromptSnippet(discovered.description ?? ""),
          "[]",
          "parallel",
          "low",
          "mcp",
          bindingJson,
          input.serverId,
          name,
          existingByName?.createdAt ?? now,
          now
        );
        this.db.prepare("INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)").run(input.workspaceId, id, now);
        imported.push(this.getTool(id));
      }
      this.audit(input.actorId, input.actorRole, "mcp_tools_import", "mcp_server", input.serverId, {
        workspaceId: input.workspaceId,
        toolNames: imported.map((tool) => tool.name)
      });
    })();
    return imported;
  }

  upsertWorkspace(input: Omit<WorkspaceDefinition, "tools" | "createdAt" | "updatedAt"> & { toolIds: string[]; actorId: string; actorRole: UserRole }): WorkspaceDefinition {
    const actorId = input.actorId;
    const actorRole = input.actorRole;
    if (actorRole !== "creator") throw new Error("Workspace creation and editing requires creator role.");
    const now = nowIso();
    const memoryPolicyJson = input.memoryPolicyJson ?? JSON.stringify(input.memoryPolicy ?? defaultMemoryPolicy);
    const effectiveToolIds = Array.from(new Set([...input.toolIds, ...builtInMemoryToolIds]));
    const registeredToolIds = new Set(this.listTools().map((tool) => tool.id));
    const missingToolIds = effectiveToolIds.filter((toolId) => !registeredToolIds.has(toolId));
    if (missingToolIds.length > 0) {
      throw new Error(`Workspace can only bind registered tools. Unknown toolId(s): ${missingToolIds.join(", ")}`);
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO workspaces
          (id, name, description, capabilitiesJson, inputKindsJson, outputKindsJson, requiresApproval, instructions, toolInstructions, memoryPolicyJson, riskLevel, createdBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          capabilitiesJson = excluded.capabilitiesJson,
          inputKindsJson = excluded.inputKindsJson,
          outputKindsJson = excluded.outputKindsJson,
          requiresApproval = excluded.requiresApproval,
          instructions = excluded.instructions,
          toolInstructions = excluded.toolInstructions,
          memoryPolicyJson = excluded.memoryPolicyJson,
          riskLevel = excluded.riskLevel,
          updatedAt = excluded.updatedAt
      `).run(
        input.id,
        input.name,
        input.description,
        input.capabilitiesJson ?? "[]",
        input.inputKindsJson ?? "[]",
        input.outputKindsJson ?? "[]",
        Number(input.requiresApproval ?? 0),
        input.instructions,
        input.toolInstructions,
        memoryPolicyJson,
        input.riskLevel,
        input.createdBy ?? actorId,
        now,
        now
      );
      this.db.prepare("DELETE FROM workspace_tools WHERE workspaceId = ?").run(input.id);
      const link = this.db.prepare("INSERT INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)");
      for (const toolId of effectiveToolIds) link.run(input.id, toolId, now);
      this.audit(actorId, actorRole, "workspace_upsert", "workspace", input.id, {
        workspaceId: input.id,
        toolIds: effectiveToolIds,
        requiresApproval: Number(input.requiresApproval ?? 0),
        riskLevel: input.riskLevel
      });
    })();
    return this.getWorkspace(input.id);
  }

  deleteWorkspace(id: string, actorId: string, actorRole: UserRole, deleteReason = "manual workspace delete"): void {
    if (actorRole !== "creator") throw new Error("Workspace deletion requires creator role.");
    if (["main", "dev"].includes(id)) throw new Error(`Built-in workspace cannot be deleted: ${id}`);
    const workspace = this.getWorkspace(id);
    const relatedMemories = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspaceId = ?
        AND memoryType IN ('event', 'skill')
        AND deletedAt IS NULL
    `).all(id) as MemoryRow[];
    this.db.transaction(() => {
      for (const memory of relatedMemories) {
        this.deleteMemory(memory.id, actorId, actorRole, `workspace deleted: ${deleteReason}`);
      }
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.audit(actorId, actorRole, "workspace_delete", "workspace", id, {
        workspaceId: id,
        workspaceName: workspace.name,
        deleteReason,
        softDeletedMemoryIds: relatedMemories.map((memory) => memory.id)
      });
    })();
  }

  listTools(): ToolDefinition[] {
    return this.db.prepare("SELECT * FROM tool_definitions ORDER BY name").all() as ToolDefinition[];
  }

  listToolsForWorkspace(workspaceId: string): ToolDefinition[] {
    return this.db.prepare(`
      SELECT t.* FROM tool_definitions t
      JOIN workspace_tools wt ON wt.toolId = t.id
      WHERE wt.workspaceId = ?
      ORDER BY t.name
    `).all(workspaceId) as ToolDefinition[];
  }

  upsertWorkspaceTool(input: Partial<ToolDefinition> & Pick<ToolDefinition, "name" | "description" | "parametersJson" | "riskLevel" | "bindingType" | "bindingJson"> & { workspaceId: string; actorId: string; actorRole: UserRole }): ToolDefinition {
    if (input.actorRole !== "creator") throw new Error("Workspace tool registration requires creator role.");
    this.getWorkspace(input.workspaceId);
    const id = input.id?.trim() || createId("tool");
    if (builtInRuntimeToolIds.has(id)) throw new Error("Built-in runtime tools cannot be edited through workspace tool registration.");
    if (!input.name.trim()) throw new Error("Tool name is required.");
    JSON.parse(input.parametersJson);
    if (input.bindingJson) JSON.parse(input.bindingJson);
    const now = nowIso();
    const existing = this.db.prepare("SELECT * FROM tool_definitions WHERE id = ?").get(id) as ToolDefinition | undefined;
    if (existing && existing.workspaceId && existing.workspaceId !== input.workspaceId) {
      throw new Error("Workspace tool belongs to a different workspace.");
    }
    const executionMode = input.executionMode === "sequential" ? "sequential" : "parallel";
    const promptGuidelinesJson = input.promptGuidelinesJson ?? existing?.promptGuidelinesJson ?? "[]";
    JSON.parse(promptGuidelinesJson);

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO tool_definitions
          (id, name, workspaceId, description, parametersJson, promptSnippet, promptGuidelinesJson, executionMode, riskLevel, bindingType, bindingJson, mcpServerId, mcpToolName, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          workspaceId = excluded.workspaceId,
          description = excluded.description,
          parametersJson = excluded.parametersJson,
          promptSnippet = excluded.promptSnippet,
          promptGuidelinesJson = excluded.promptGuidelinesJson,
          executionMode = excluded.executionMode,
          riskLevel = excluded.riskLevel,
          bindingType = excluded.bindingType,
          bindingJson = excluded.bindingJson,
          mcpServerId = excluded.mcpServerId,
          mcpToolName = excluded.mcpToolName,
          updatedAt = excluded.updatedAt
      `).run(
        id,
        input.name.trim(),
        input.workspaceId,
        input.description,
        input.parametersJson,
        input.promptSnippet ?? existing?.promptSnippet ?? oneLinePromptSnippet(input.description),
        promptGuidelinesJson,
        executionMode,
        input.riskLevel,
        input.bindingType,
        input.bindingJson || "{}",
        input.mcpServerId ?? null,
        input.mcpToolName ?? null,
        existing?.createdAt ?? now,
        now
      );
      this.db.prepare("INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)").run(input.workspaceId, id, now);
      this.audit(input.actorId, input.actorRole, existing ? "workspace_tool_update" : "workspace_tool_register", "tool", id, {
        workspaceId: input.workspaceId,
        toolName: input.name,
        bindingType: input.bindingType,
        mcpServerId: input.mcpServerId,
        mcpToolName: input.mcpToolName
      });
    })();
    return this.getTool(id);
  }

  getTool(id: string): ToolDefinition {
    const row = this.db.prepare("SELECT * FROM tool_definitions WHERE id = ?").get(id) as ToolDefinition | undefined;
    if (!row) throw new Error(`Tool not found: ${id}`);
    return row;
  }

  deleteWorkspaceTool(workspaceId: string, toolId: string, actorId: string, actorRole: UserRole, deleteReason = "manual workspace tool delete"): void {
    if (actorRole !== "creator") throw new Error("Workspace tool deletion requires creator role.");
    this.getWorkspace(workspaceId);
    const tool = this.getTool(toolId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM workspace_tools WHERE workspaceId = ? AND toolId = ?").run(workspaceId, toolId);
      if (tool.workspaceId === workspaceId && !builtInRuntimeToolIds.has(toolId)) {
        this.db.prepare("DELETE FROM tool_definitions WHERE id = ?").run(toolId);
      }
      this.audit(actorId, actorRole, "workspace_tool_delete", "tool", toolId, {
        workspaceId,
        toolName: tool.name,
        bindingType: tool.bindingType,
        deleteReason
      });
    })();
  }

  listMemories(filters: { query?: string; memoryType?: string; userId?: string; agentId?: string; workspaceId?: string } = {}): MemoryRow[] {
    const clauses: string[] = ["m.deletedAt IS NULL"];
    const params: unknown[] = [];
    if (filters.memoryType) {
      clauses.push("m.memoryType = ?");
      params.push(filters.memoryType);
    }
    if (filters.userId) {
      clauses.push("(m.userId = ? OR m.userId IS NULL)");
      params.push(filters.userId);
    }
    if (filters.agentId) {
      clauses.push("m.agentId = ?");
      params.push(filters.agentId);
    }
    if (filters.workspaceId) {
      clauses.push("(m.workspaceId = ? OR m.workspaceId IS NULL)");
      params.push(filters.workspaceId);
    }
    const ftsQuery = filters.query ? buildFtsQuery(filters.query) : "";
    if (ftsQuery) {
      clauses.push("m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
      params.push(ftsQuery);
    }
    return this.db.prepare(`SELECT m.* FROM memories m WHERE ${clauses.join(" AND ")} ORDER BY m.updatedAt DESC LIMIT 200`).all(...params) as MemoryRow[];
  }

  recallMemories(input: {
    userId: string;
    workspaceId: string;
    query: string;
    agentId: string;
    impressionLimit?: number;
    eventLimit?: number;
    rollupEventLimit?: number;
    resultEventLimit?: number;
    processEventLimit?: number;
    skillLimit?: number;
  }): MemoryRow[] {
    const ftsQuery = buildFtsQuery(input.query);
    const relationLatest = `
      NOT EXISTS (
        SELECT 1 FROM memories newer
        WHERE newer.relationId = m.relationId
          AND newer.relationId IS NOT NULL
          AND newer.memoryType = m.memoryType
          AND COALESCE(newer.userId, '') = COALESCE(m.userId, '')
          AND COALESCE(newer.agentId, '') = COALESCE(m.agentId, '')
          AND COALESCE(newer.workspaceId, '') = COALESCE(m.workspaceId, '')
          AND newer.deletedAt IS NULL
          AND newer.version > m.version
      )
    `;
    const recallPartition = (whereSql: string, params: unknown[], limit = 8, options: { useFts?: boolean } = {}): MemoryRow[] => {
      const safeLimit = Math.max(0, Math.floor(limit));
      if (safeLimit <= 0) return [];
      const useFts = Boolean(options.useFts && ftsQuery);
      const textClause = useFts
        ? "AND m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)"
        : "";
      return this.db.prepare(`
      SELECT m.* FROM memories m
      WHERE m.deletedAt IS NULL
        AND ${relationLatest}
        AND ${whereSql}
        ${textClause}
      ORDER BY m.updatedAt DESC
      LIMIT ?
    `).all(...params, ...(useFts ? [ftsQuery] : []), safeLimit) as MemoryRow[];
    };

    const impressions = recallPartition(`
      m.memoryType = 'impression'
      AND (
        (m.userId = ? AND m.agentId = ?)
        OR (m.userId IS NULL AND m.agentId = ?)
      )
    `, [input.userId, input.agentId, input.agentId], input.impressionLimit ?? 20);
    const resultEvents = recallPartition(
      "m.memoryType = 'event' AND m.userId = ? AND m.agentId = ? AND m.workspaceId = ? AND json_extract(m.metadataJson, '$.eventKind') = 'result'",
      [input.userId, input.agentId, input.workspaceId],
      input.resultEventLimit ?? input.eventLimit ?? 10
    );
    const rollupEvents = recallPartition(
      "m.memoryType = 'event' AND m.userId = ? AND m.agentId = ? AND m.workspaceId = ? AND json_extract(m.metadataJson, '$.eventKind') = 'rollup'",
      [input.userId, input.agentId, input.workspaceId],
      input.rollupEventLimit ?? 3
    );
    const processEvents = recallPartition(
      "m.memoryType = 'event' AND m.userId = ? AND m.agentId = ? AND m.workspaceId = ? AND json_extract(m.metadataJson, '$.eventKind') = 'process'",
      [input.userId, input.agentId, input.workspaceId],
      input.processEventLimit ?? 8,
      { useFts: true }
    );
    const skills = recallPartition(
      "m.memoryType = 'skill' AND m.agentId = ? AND m.workspaceId = ?",
      [input.agentId, input.workspaceId],
      input.skillLimit ?? 8
    );

    return [...impressions, ...rollupEvents, ...resultEvents, ...processEvents, ...skills];
  }

  createMemory(input: Partial<MemoryRow> & Pick<MemoryRow, "memoryType" | "title" | "summary" | "detail">, actorId: string, actorRole: UserRole): MemoryRow {
    const now = nowIso();
    const id = input.id ?? createId("mem");
    const agentId = input.agentId ?? (input.userId || input.memoryType !== "impression" ? "default-agent" : undefined);
    const metadata = parseJson<Record<string, unknown>>(input.metadataJson ?? "{}", {});
    const metadataConversationId = typeof metadata.conversationId === "string" ? metadata.conversationId.trim() : "";
    if (actorRole !== "creator" && metadataConversationId) {
      const conversation = this.getConversation(metadataConversationId);
      if (!conversation || conversation.userId !== actorId) {
        this.audit(actorId, actorRole, "memory_create_rejected", "memory", id, {
          memoryType: input.memoryType,
          userId: input.userId,
          workspaceId: input.workspaceId,
          reason: "Memory metadata.conversationId must belong to the writing actor."
        });
        throw new Error("Memory metadata.conversationId must belong to the writing actor.");
      }
    }
    this.db.prepare(`
      INSERT INTO memories
        (id, memoryType, userId, agentId, workspaceId, relationId, version, title, summary, detail, metadataJson, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.memoryType, input.userId ?? null, agentId ?? null, input.workspaceId ?? null, input.relationId ?? null, input.version ?? 1, input.title, input.summary, input.detail, input.metadataJson ?? "{}", now, now);
    this.audit(actorId, actorRole, "create", "memory", id, {
      memoryType: input.memoryType,
      userId: input.userId,
      agentId,
      workspaceId: input.workspaceId ?? (typeof metadata.activeWorkspaceId === "string" ? metadata.activeWorkspaceId : undefined),
      relationId: input.relationId,
      version: input.version ?? 1,
      conversationId: typeof metadata.conversationId === "string" ? metadata.conversationId : undefined,
      source: typeof metadata.source === "string" ? metadata.source : undefined
    });
    const memory = this.getMemory(id);
    if (metadataConversationId && this.getConversation(metadataConversationId)) {
      const eventKind = typeof metadata.eventKind === "string" ? metadata.eventKind : undefined;
      this.appendSessionEntry({
        conversationId: metadataConversationId,
        workspaceId: memory.workspaceId,
        type: "memory_write",
        payload: {
          memoryId: memory.id,
          memoryType: memory.memoryType,
          workspaceId: memory.workspaceId,
          relationId: memory.relationId,
          title: memory.title,
          summary: memory.summary,
          metadata: {
            eventKind,
            source: typeof metadata.source === "string" ? metadata.source : undefined
          }
        }
      });
      if (eventKind === "rollup") {
        this.appendSessionEntry({
          conversationId: metadataConversationId,
          workspaceId: memory.workspaceId,
          type: "event_rollup",
          payload: {
            memoryId: memory.id,
            workspaceId: memory.workspaceId,
            relationId: memory.relationId,
            title: memory.title,
            summary: memory.summary,
            triggerSource: typeof metadata.triggerSource === "string" ? metadata.triggerSource : undefined,
            rollupMode: typeof metadata.rollupMode === "string" ? metadata.rollupMode : undefined,
            sourceEventIds: Array.isArray(metadata.sourceEventIds) ? metadata.sourceEventIds : []
          }
        });
      }
    }
    return memory;
  }

  getMemoryByRelation(memoryType: string, relationId: string, scope: { userId?: string | null; agentId?: string | null; workspaceId?: string | null }): MemoryRow | undefined {
    if (!scope) {
      throw new Error("Memory relation lookup requires explicit userId/agentId/workspaceId scope.");
    }
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE memoryType = ?
        AND relationId = ?
        AND deletedAt IS NULL
        AND COALESCE(userId, '') = COALESCE(?, '')
        AND COALESCE(agentId, '') = COALESCE(?, '')
        AND COALESCE(workspaceId, '') = COALESCE(?, '')
      ORDER BY version DESC
      LIMIT 1
    `).get(memoryType, relationId, scope.userId ?? null, scope.agentId ?? null, scope.workspaceId ?? null) as MemoryRow | undefined;
  }

  getMemory(id: string): MemoryRow {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND deletedAt IS NULL").get(id) as MemoryRow | undefined;
    if (!row) throw new Error(`Memory not found: ${id}`);
    return row;
  }

  getMemoryIncludingDeleted(id: string): MemoryRow {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row) throw new Error(`Memory not found: ${id}`);
    return row;
  }

  updateMemory(id: string, patch: Partial<MemoryRow>, actorId: string, actorRole: UserRole | "system" | "agent"): MemoryRow {
    const current = this.getMemory(id);
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db.prepare(`
      UPDATE memories SET
        memoryType = ?, userId = ?, agentId = ?, workspaceId = ?, relationId = ?, version = ?,
        title = ?, summary = ?, detail = ?, metadataJson = ?, updatedAt = ?
      WHERE id = ?
    `).run(next.memoryType, next.userId ?? null, next.agentId ?? null, next.workspaceId ?? null, next.relationId ?? null, next.version, next.title, next.summary, next.detail, next.metadataJson, next.updatedAt, id);
    this.audit(actorId, actorRole, "update", "memory", id, { memoryType: next.memoryType });
    return this.getMemory(id);
  }

  deleteMemory(id: string, actorId: string, actorRole: UserRole, deleteReason = "manual delete"): void {
    const current = this.getMemory(id);
    const deletedAt = nowIso();
    this.db.prepare(`
      UPDATE memories
      SET deletedAt = ?, deletedBy = ?, deleteReason = ?, updatedAt = ?
      WHERE id = ? AND deletedAt IS NULL
    `).run(deletedAt, actorId, deleteReason, deletedAt, id);
    this.audit(actorId, actorRole, "delete", "memory", id, {
      memoryType: current.memoryType,
      workspaceId: current.workspaceId,
      relationId: current.relationId,
      version: current.version,
      deleteReason
    });
  }

  saveWorkspaceSession(session: WorkspaceSession): void {
    const conversation = this.db.prepare("SELECT userId FROM conversations WHERE id = ?").get(session.conversationId) as { userId: string } | undefined;
    if (conversation && conversation.userId !== session.userId) {
      this.audit(session.userId, "system", "workspace_session_write_rejected", "workspace_session", session.id, {
        conversationId: session.conversationId,
        ownerUserId: conversation.userId,
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        reason: "Workspace session userId does not match conversation owner."
      });
      throw new Error("Workspace session userId does not match conversation owner.");
    }
    this.db.prepare(`
      INSERT INTO workspace_sessions
        (id, conversationId, userId, workspaceId, taskId, status, objective, summary, taskJson, resultJson, localContextJson, observationsJson, errorsJson, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.conversationId,
      session.userId,
      session.workspaceId,
      session.taskId,
      session.status,
      session.objective,
      session.summary,
      JSON.stringify(session.task),
      JSON.stringify(session.result),
      JSON.stringify(session.localContext),
      JSON.stringify(session.observations),
      JSON.stringify(session.errors),
      session.startedAt,
      session.completedAt ?? null
    );
    this.appendSessionEntry({
      conversationId: session.conversationId,
      workspaceId: session.workspaceId,
      type: "workspace_enter",
      payload: {
        workspaceSessionId: session.id,
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        status: session.status,
        objective: session.objective,
        startedAt: session.startedAt
      }
    });
  }

  updateWorkspaceSessionLocalContext(session: WorkspaceSession): void {
    this.db.prepare(`
      UPDATE workspace_sessions
      SET status = ?, objective = ?, summary = ?, taskJson = ?, localContextJson = ?, resultJson = ?, observationsJson = ?, errorsJson = ?, completedAt = ?
      WHERE id = ?
    `).run(
      session.status,
      session.objective,
      session.summary,
      JSON.stringify(session.task),
      JSON.stringify(session.localContext),
      JSON.stringify(session.result),
      JSON.stringify(session.observations),
      JSON.stringify(session.errors),
      session.completedAt ?? null,
      session.id
    );
    if (session.completedAt && session.status !== "running" && !this.hasSessionEntryForResource(session.conversationId, "workspace_exit", "workspaceSessionId", session.id)) {
      this.appendSessionEntry({
        conversationId: session.conversationId,
        workspaceId: session.workspaceId,
        type: "workspace_exit",
        payload: {
          workspaceSessionId: session.id,
          workspaceId: session.workspaceId,
          taskId: session.taskId,
          status: session.status,
          summary: session.summary,
          result: session.result,
          completedAt: session.completedAt
        }
      });
    }
  }

  saveToolCall(log: Omit<ToolCallLog, "id" | "createdAt">): ToolCallLog {
    const conversation = this.db.prepare("SELECT userId FROM conversations WHERE id = ?").get(log.conversationId) as { userId: string } | undefined;
    if (conversation && conversation.userId !== log.userId) {
      this.audit(log.userId, "system", "tool_call_write_rejected", "tool", undefined, {
        conversationId: log.conversationId,
        ownerUserId: conversation.userId,
        workspaceId: log.workspaceId,
        toolName: log.toolName,
        reason: "Tool call userId does not match conversation owner."
      });
      throw new Error("Tool call userId does not match conversation owner.");
    }
    const row: ToolCallLog = {
      ...log,
      id: createId("tool"),
      createdAt: nowIso()
    };
    this.db.prepare(`
      INSERT INTO tool_calls
        (id, conversationId, userId, workspaceId, workspaceSessionId, taskId, toolName, argumentsJson, resultJson, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.conversationId,
      row.userId,
      row.workspaceId,
      row.workspaceSessionId ?? null,
      row.taskId ?? null,
      row.toolName,
      row.argumentsJson,
      row.resultJson,
      row.status,
      row.createdAt
    );
    this.appendSessionEntry({
      conversationId: row.conversationId,
      workspaceId: row.workspaceId,
      type: "tool_call",
      payload: {
        toolCallId: row.id,
        workspaceSessionId: row.workspaceSessionId,
        taskId: row.taskId,
        toolName: row.toolName,
        argumentsJson: row.argumentsJson,
        status: row.status
      }
    });
    return row;
  }

  updateToolCallResult(id: string, result: { resultJson: string; status: Exclude<ToolCallLog["status"], "pending"> }): ToolCallLog {
    const existing = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as ToolCallLog | undefined;
    if (!existing) throw new Error(`Tool call not found: ${id}`);
    this.db.prepare(`
      UPDATE tool_calls
      SET resultJson = ?, status = ?
      WHERE id = ?
    `).run(result.resultJson, result.status, id);
    const updated = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as ToolCallLog;
    this.appendSessionEntry({
      conversationId: updated.conversationId,
      workspaceId: updated.workspaceId,
      type: "tool_result",
      payload: {
        toolCallId: updated.id,
        workspaceSessionId: updated.workspaceSessionId,
        taskId: updated.taskId,
        toolName: updated.toolName,
        status: updated.status,
        resultJson: updated.resultJson
      }
    });
    return updated;
  }

  listToolCalls(conversationId: string, userId?: string): ToolCallLog[] {
    const userFilter = userId ? "AND userId = ?" : "";
    const params = userId ? [conversationId, userId] : [conversationId];
    return this.db.prepare(`
      SELECT * FROM tool_calls
      WHERE conversationId = ? ${userFilter}
      ORDER BY createdAt DESC
    `).all(...params) as ToolCallLog[];
  }

  listWorkspaceSessions(conversationId: string, userId?: string): WorkspaceSession[] {
    const userFilter = userId ? "AND userId = ?" : "";
    const params = userId ? [conversationId, userId] : [conversationId];
    const rows = this.db.prepare(`SELECT * FROM workspace_sessions WHERE conversationId = ? ${userFilter} ORDER BY startedAt`).all(...params) as Array<any>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      userId: row.userId,
      workspaceId: row.workspaceId,
      taskId: row.taskId || row.id,
      status: row.status,
      objective: row.objective,
      summary: row.summary,
      task: parseJson(row.taskJson, {
        taskId: row.taskId || row.id,
        userId: row.userId,
        conversationId: row.conversationId,
        workspaceId: row.workspaceId,
        objective: row.objective,
        constraints: [],
        relevantUserRequest: row.objective,
        expectedOutput: "Structured workspace result.",
        parentContextSummary: ""
      }),
      result: parseJson(row.resultJson, {
        taskId: row.taskId || row.id,
        workspaceId: row.workspaceId,
        status: row.status,
        summary: row.summary,
        artifacts: [],
        observations: parseJson<string[]>(row.observationsJson, []),
        errors: parseJson<string[]>(row.errorsJson, []),
        suggestedNextSteps: []
      }),
      localContext: parseJson<WorkspaceLocalContext>(row.localContextJson ?? "{}", {
        workspaceManifest: {
          id: row.workspaceId,
          name: row.workspaceId,
          description: "",
          capabilities: [],
          inputKinds: [],
          outputKinds: [],
          riskLevel: "low",
          requiresApproval: false
        },
        memoryPolicy: defaultMemoryPolicy,
        parentContextSummary: "",
        handoffContext: [],
        recalledImpressions: [],
        recalledEventMemories: [],
        recalledSkillMemories: [],
        availableTools: [],
        recentToolCalls: []
      }),
      observations: parseJson<string[]>(row.observationsJson, []),
      errors: parseJson<string[]>(row.errorsJson, []),
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? undefined
    }));
  }

  saveLlmCall(snapshot: LLMCallSnapshot, segments: ContextSegment[]): void {
    const conversation = this.db.prepare("SELECT userId FROM conversations WHERE id = ?").get(snapshot.conversationId) as { userId: string } | undefined;
    if (conversation && conversation.userId !== snapshot.userId) {
      this.audit(snapshot.userId, "system", "llm_call_write_rejected", "llm_call", snapshot.id, {
        conversationId: snapshot.conversationId,
        ownerUserId: conversation.userId,
        reason: "LLM call userId does not match conversation owner."
      });
      throw new Error("LLM call userId does not match conversation owner.");
    }
    const previousModel = this.db.prepare(`
      SELECT id, providerBaseUrl, normalizedEndpoint, model FROM llm_calls
      WHERE conversationId = ?
      ORDER BY createdAt DESC, rowid DESC
      LIMIT 1
    `).get(snapshot.conversationId) as Pick<LLMCallSnapshot, "id" | "providerBaseUrl" | "normalizedEndpoint" | "model"> | undefined;
    if (previousModel && (
      previousModel.model !== snapshot.model
      || previousModel.providerBaseUrl !== snapshot.providerBaseUrl
      || previousModel.normalizedEndpoint !== snapshot.normalizedEndpoint
    )) {
      this.appendSessionEntry({
        conversationId: snapshot.conversationId,
        workspaceId: workspaceIdFromContextSegments(segments),
        type: "model_change",
        payload: {
          previousLlmCallId: previousModel.id,
          nextLlmCallId: snapshot.id,
          from: {
            providerBaseUrl: previousModel.providerBaseUrl,
            normalizedEndpoint: previousModel.normalizedEndpoint,
            model: previousModel.model
          },
          to: {
            providerBaseUrl: snapshot.providerBaseUrl,
            normalizedEndpoint: snapshot.normalizedEndpoint,
            model: snapshot.model
          }
        }
      });
    }
    this.db.prepare(`
      INSERT INTO llm_calls
        (id, conversationId, userId, providerBaseUrl, normalizedEndpoint, model, messagesJson, toolsJson, status, responseJson, errorText, createdAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.conversationId,
      snapshot.userId,
      snapshot.providerBaseUrl,
      snapshot.normalizedEndpoint,
      snapshot.model,
      snapshot.messagesJson,
      snapshot.toolsJson,
      snapshot.status,
      snapshot.responseJson,
      snapshot.errorText ?? null,
      snapshot.createdAt,
      snapshot.completedAt ?? null
    );
    const stmt = this.db.prepare(`
      INSERT INTO context_segments
        (id, llmCallId, conversationId, segmentType, title, content, tokenEstimate, sortOrder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const segment of segments) {
      stmt.run(segment.id, segment.llmCallId, segment.conversationId, segment.segmentType, segment.title, segment.content, segment.tokenEstimate, segment.sortOrder);
    }
    const workspaceId = workspaceIdFromContextSegments(segments);
    this.appendSessionEntry({
      conversationId: snapshot.conversationId,
      workspaceId,
      type: "llm_call",
      payload: {
        llmCallId: snapshot.id,
        workspaceId,
        providerBaseUrl: snapshot.providerBaseUrl,
        normalizedEndpoint: snapshot.normalizedEndpoint,
        model: snapshot.model,
        status: snapshot.status,
        contextSegmentIds: segments.map((segment) => segment.id)
      }
    });
  }

  markLlmCallCompleted(llmCallId: string, response: unknown): void {
    const existing = this.db.prepare("SELECT conversationId, model FROM llm_calls WHERE id = ?").get(llmCallId) as { conversationId: string; model: string } | undefined;
    this.db.prepare(`
      UPDATE llm_calls
      SET status = 'completed', responseJson = ?, errorText = NULL, completedAt = ?
      WHERE id = ?
    `).run(JSON.stringify(response ?? {}), nowIso(), llmCallId);
    if (existing) {
      const workspaceSegment = this.db.prepare("SELECT content FROM context_segments WHERE llmCallId = ? AND segmentType = 'workspace' LIMIT 1").get(llmCallId) as { content: string } | undefined;
      const workspaceId = workspaceSegment ? workspaceIdFromContextSegmentContent(workspaceSegment.content) : undefined;
      this.appendSessionEntry({
        conversationId: existing.conversationId,
        workspaceId,
        type: "llm_call",
        payload: {
          llmCallId,
          workspaceId,
          model: existing.model,
          status: "completed",
          response
        }
      });
    }
  }

  markLlmCallFailed(llmCallId: string, errorText: string): void {
    const existing = this.db.prepare("SELECT conversationId, model FROM llm_calls WHERE id = ?").get(llmCallId) as { conversationId: string; model: string } | undefined;
    this.db.prepare(`
      UPDATE llm_calls
      SET status = 'failed', responseJson = ?, errorText = ?, completedAt = ?
      WHERE id = ?
    `).run(JSON.stringify({ failed: true, error: errorText }), errorText, nowIso(), llmCallId);
    if (existing) {
      const workspaceSegment = this.db.prepare("SELECT content FROM context_segments WHERE llmCallId = ? AND segmentType = 'workspace' LIMIT 1").get(llmCallId) as { content: string } | undefined;
      const workspaceId = workspaceSegment ? workspaceIdFromContextSegmentContent(workspaceSegment.content) : undefined;
      this.appendSessionEntry({
        conversationId: existing.conversationId,
        workspaceId,
        type: "llm_call",
        payload: {
          llmCallId,
          workspaceId,
          model: existing.model,
          status: "failed",
          errorText
        }
      });
    }
  }

  markPendingLlmCallsInterrupted(reason = "服务重启前请求未完成。"): void {
    this.db.prepare(`
      UPDATE llm_calls
      SET status = 'failed', errorText = ?, completedAt = ?
      WHERE status = 'pending'
    `).run(reason, nowIso());
  }

  createApprovalRequest(input: {
    userId: string;
    conversationId?: string;
    workspaceId: string;
    toolName: string;
    argumentsJson: string;
    reason: string;
    metadata?: unknown;
  }): ApprovalRequest {
    if (input.conversationId) {
      const conversation = this.db.prepare("SELECT userId FROM conversations WHERE id = ?").get(input.conversationId) as { userId: string } | undefined;
      if (conversation && conversation.userId !== input.userId) {
        this.audit(input.userId, "system", "approval_request_write_rejected", "approval", undefined, {
          conversationId: input.conversationId,
          ownerUserId: conversation.userId,
          workspaceId: input.workspaceId,
          toolName: input.toolName,
          reason: "Approval request userId does not match conversation owner."
        });
        throw new Error("Approval request userId does not match conversation owner.");
      }
    }
    const row: ApprovalRequest = {
      id: createId("approval"),
      userId: input.userId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      argumentsJson: input.argumentsJson,
      reason: input.reason,
      status: "pending",
      createdAt: nowIso(),
      metadataJson: JSON.stringify(input.metadata ?? {})
    };
    this.db.prepare(`
      INSERT INTO approval_requests
        (id, userId, conversationId, workspaceId, toolName, argumentsJson, reason, status, createdAt, resolvedAt, resolvedBy, resolutionReason, metadataJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.userId,
      row.conversationId ?? null,
      row.workspaceId,
      row.toolName,
      row.argumentsJson,
      row.reason,
      row.status,
      row.createdAt,
      null,
      null,
      null,
      row.metadataJson
    );
    this.audit(input.userId, "system", "approval_requested", "approval", row.id, {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      reason: input.reason
    });
    if (row.conversationId && this.getConversation(row.conversationId)) {
      this.appendSessionEntry({
        conversationId: row.conversationId,
        workspaceId: row.workspaceId,
        type: "approval_request",
        payload: {
          approvalRequestId: row.id,
          workspaceId: row.workspaceId,
          toolName: row.toolName,
          argumentsJson: row.argumentsJson,
          reason: row.reason,
          status: row.status
        }
      });
    }
    return this.getApprovalRequest(row.id);
  }

  getApprovalRequest(id: string): ApprovalRequest {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as ApprovalRequest | undefined;
    if (!row) throw new Error(`Approval request not found: ${id}`);
    return normalizeApproval(row);
  }

  listApprovalRequests(filters: { conversationId?: string; userId?: string; status?: string; limit?: number; actorId?: string; actorRole?: UserRole } = {}): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.conversationId) {
      clauses.push("conversationId = ?");
      params.push(filters.conversationId);
    }
    if (filters.actorRole && filters.actorRole !== "creator") {
      clauses.push("userId = ?");
      params.push(filters.actorId ?? "");
    } else if (filters.userId) {
      clauses.push("userId = ?");
      params.push(filters.userId);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 100)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM approval_requests ${where} ORDER BY createdAt DESC LIMIT ?`).all(...params, limit) as ApprovalRequest[];
    return rows.map(normalizeApproval);
  }

  resolveApprovalRequest(id: string, input: { status: "approved" | "rejected"; resolvedBy: string; resolverRole?: UserRole; resolutionReason?: string }): ApprovalRequest {
    const current = this.getApprovalRequest(id);
    const resolverRole = input.resolverRole ?? "user";
    if (resolverRole !== "creator") {
      this.audit(input.resolvedBy, resolverRole, "approval_resolve_rejected", "approval", id, {
        conversationId: current.conversationId,
        workspaceId: current.workspaceId,
        toolName: current.toolName,
        requestedStatus: input.status,
        reason: "Approval resolution requires creator role."
      });
      throw new Error("Approval resolution requires creator role.");
    }
    if (current.status !== "pending") return current;
    const resolvedAt = nowIso();
    this.db.prepare(`
      UPDATE approval_requests
      SET status = ?, resolvedAt = ?, resolvedBy = ?, resolutionReason = ?
      WHERE id = ?
    `).run(input.status, resolvedAt, input.resolvedBy, input.resolutionReason ?? null, id);
    this.audit(input.resolvedBy, "creator", `approval_${input.status}`, "approval", id, {
      conversationId: current.conversationId,
      workspaceId: current.workspaceId,
      toolName: current.toolName,
      resolutionReason: input.resolutionReason
    });
    const resolved = this.getApprovalRequest(id);
    if (resolved.conversationId && this.getConversation(resolved.conversationId)) {
      this.appendSessionEntry({
        conversationId: resolved.conversationId,
        workspaceId: resolved.workspaceId,
        type: "approval_request",
        payload: {
          eventKind: "resolution",
          approvalRequestId: resolved.id,
          workspaceId: resolved.workspaceId,
          toolName: resolved.toolName,
          status: resolved.status,
          previousStatus: current.status,
          resolvedAt,
          resolvedBy: input.resolvedBy,
          resolutionReason: input.resolutionReason
        }
      });
    }
    return resolved;
  }

  getTrace(conversationId: string, actorId: string, actorRole: UserRole): { sessions: WorkspaceSession[]; sessionEntries: SessionEntry[]; llmCalls: LLMCallSnapshot[]; contextSegments: ContextSegment[]; toolCalls: ToolCallLog[]; auditLogs: AuditLog[]; approvalRequests: ApprovalRequest[]; memoryWrites: MemoryRow[] } {
    if (!actorId || (actorRole !== "user" && actorRole !== "creator")) {
      throw new Error("Conversation trace requires explicit actor identity.");
    }
    const conversation = this.db.prepare("SELECT id, userId, agentId FROM conversations WHERE id = ?").get(conversationId) as { id: string; userId: string; agentId: string } | undefined;
    if (!conversation && actorRole !== "creator") {
      this.audit(actorId, actorRole, "trace_read_rejected", "conversation", conversationId, {
        reason: "Conversation trace requires creator role when the conversation record no longer exists."
      });
      throw new Error("Conversation trace requires creator role when the conversation record no longer exists.");
    }
    if (conversation && actorRole !== "creator" && conversation.userId !== actorId) {
      this.audit(actorId, actorRole, "trace_read_rejected", "conversation", conversationId, {
        ownerUserId: conversation.userId,
        agentId: conversation.agentId,
        reason: "Conversation trace belongs to a different user."
      });
      throw new Error("Conversation trace belongs to a different user.");
    }
    const toolLogUserId = actorRole === "creator" ? undefined : actorId;
    return {
      sessions: this.listWorkspaceSessions(conversationId, toolLogUserId),
      sessionEntries: this.listSessionEntries(conversationId, toolLogUserId),
      llmCalls: this.db.prepare("SELECT * FROM llm_calls WHERE conversationId = ? ORDER BY createdAt DESC").all(conversationId) as LLMCallSnapshot[],
      contextSegments: this.db.prepare("SELECT * FROM context_segments WHERE conversationId = ? ORDER BY sortOrder").all(conversationId) as ContextSegment[],
      toolCalls: this.listToolCalls(conversationId, toolLogUserId),
      auditLogs: this.listAuditLogs({ conversationId }),
      approvalRequests: this.listApprovalRequests({ conversationId, actorId, actorRole }),
      memoryWrites: this.listConversationMemoryWrites(conversationId, actorId, actorRole)
    };
  }

  private listConversationMemoryWrites(conversationId: string, actorId: string, actorRole: UserRole): MemoryRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE deletedAt IS NULL
        AND metadataJson LIKE ?
      ORDER BY createdAt DESC
      LIMIT 100
    `).all(`%"conversationId":"${conversationId}"%`) as MemoryRow[];
    if (actorRole === "creator") return rows;
    return rows.filter((memory) => {
      if (memory.memoryType === "event") return memory.userId === actorId;
      if (memory.memoryType === "skill") return Boolean(memory.workspaceId) && !memory.userId;
      if (memory.memoryType === "impression") return Boolean(memory.userId) && memory.userId === actorId && !memory.agentId;
      return false;
    });
  }

  listAuditLogs(filters: { conversationId?: string; limit?: number } = {}): AuditLog[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.conversationId) {
      clauses.push("(conversationId = ? OR metadataJson LIKE ?)");
      params.push(filters.conversationId, `%"conversationId":"${filters.conversationId}"%`);
    }
    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 100)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY createdAt DESC LIMIT ?`).all(...params, limit) as AuditLog[];
  }

  listLlmCalls(limit = 50, actorId = "user", actorRole: UserRole = "user"): LLMCallSnapshot[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    if (actorRole === "creator") {
      return this.db.prepare("SELECT * FROM llm_calls ORDER BY createdAt DESC LIMIT ?").all(safeLimit) as LLMCallSnapshot[];
    }
    return this.db.prepare(`
      SELECT llm_calls.* FROM llm_calls
      LEFT JOIN conversations ON conversations.id = llm_calls.conversationId
      WHERE llm_calls.userId = ? OR conversations.userId = ?
      ORDER BY llm_calls.createdAt DESC
      LIMIT ?
    `).all(actorId, actorId, safeLimit) as LLMCallSnapshot[];
  }

  audit(actorId: string | undefined, actorRole: UserRole | "system" | "agent", action: string, resourceKind: string, resourceId: string | undefined, metadata: unknown): void {
    const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : null;
    const conversationId = typeof record.conversationId === "string" ? record.conversationId : null;
    this.db.prepare(`
      INSERT INTO audit_logs
        (id, actorId, actorRole, action, resourceKind, resourceId, workspaceId, conversationId, createdAt, metadataJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createId("audit"), actorId ?? null, actorRole, action, resourceKind, resourceId ?? null, workspaceId, conversationId, nowIso(), JSON.stringify(metadata));
  }
}

function normalizeApproval(row: ApprovalRequest): ApprovalRequest {
  return {
    ...row,
    conversationId: row.conversationId ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolutionReason: row.resolutionReason ?? undefined
  };
}

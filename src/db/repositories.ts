import type Database from "better-sqlite3";
import type {
  AgentConfig,
  ApprovalRequest,
  AuditLog,
  ContextSegment,
  LLMCallSnapshot,
  MemoryRow,
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

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildFtsQuery(value: string): string {
  return (value.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, 8)
    .join(" OR ");
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
  "tool-write-user-impression",
  "tool-write-agent-self-impression",
  "tool-write-event-memory",
  "tool-write-skill-memory",
  "tool-update-memory",
  "tool-delete-memory"
];

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

  getAgent(agentId: string): AgentConfig {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentConfig | undefined;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    return row;
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

  addMessage(conversationId: string, role: string, content: string, raw: unknown = {}): void {
    this.db.prepare(`
      INSERT INTO messages (id, conversationId, role, content, rawJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(createId("msg"), conversationId, role, content, JSON.stringify(raw), nowIso());
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

  upsertWorkspace(input: Omit<WorkspaceDefinition, "tools" | "createdAt" | "updatedAt"> & { toolIds: string[]; actorId?: string; actorRole?: UserRole }): WorkspaceDefinition {
    const actorId = input.actorId ?? input.createdBy ?? "creator";
    const actorRole = input.actorRole ?? "creator";
    if (actorRole !== "creator") throw new Error("Workspace creation and editing requires creator role.");
    const now = nowIso();
    const memoryPolicyJson = input.memoryPolicyJson ?? JSON.stringify(input.memoryPolicy ?? defaultMemoryPolicy);
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
    const effectiveToolIds = Array.from(new Set([...input.toolIds, ...builtInMemoryToolIds]));
    this.db.prepare("DELETE FROM workspace_tools WHERE workspaceId = ?").run(input.id);
    const link = this.db.prepare("INSERT INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)");
    for (const toolId of effectiveToolIds) link.run(input.id, toolId, now);
    this.audit(actorId, actorRole, "workspace_upsert", "workspace", input.id, {
      workspaceId: input.id,
      toolIds: effectiveToolIds,
      requiresApproval: Number(input.requiresApproval ?? 0),
      riskLevel: input.riskLevel
    });
    return this.getWorkspace(input.id);
  }

  deleteWorkspace(id: string, actorId = "creator", actorRole: UserRole = "creator", deleteReason = "manual workspace delete"): void {
    if (actorRole !== "creator") throw new Error("Workspace deletion requires creator role.");
    if (["main", "file", "cli"].includes(id)) throw new Error(`Built-in workspace cannot be deleted: ${id}`);
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
      clauses.push("(m.agentId = ? OR m.agentId IS NULL)");
      params.push(filters.agentId);
    }
    if (filters.workspaceId) {
      clauses.push("(m.workspaceId = ? OR m.workspaceId IS NULL)");
      params.push(filters.workspaceId);
    }
    if (filters.query) {
      clauses.push("m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
      params.push(filters.query);
    }
    return this.db.prepare(`SELECT m.* FROM memories m WHERE ${clauses.join(" AND ")} ORDER BY m.updatedAt DESC LIMIT 200`).all(...params) as MemoryRow[];
  }

  recallMemories(input: { userId: string; workspaceId: string; query: string; agentId?: string }): MemoryRow[] {
    const ftsQuery = buildFtsQuery(input.query);
    const relationLatest = `
      NOT EXISTS (
        SELECT 1 FROM memories newer
        WHERE newer.relationId = m.relationId
          AND newer.relationId IS NOT NULL
          AND newer.deletedAt IS NULL
          AND newer.version > m.version
      )
    `;
    const textClause = ftsQuery
      ? "AND m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)"
      : "";
    const recallPartition = (whereSql: string, params: unknown[], limit = 8): MemoryRow[] => this.db.prepare(`
      SELECT m.* FROM memories m
      WHERE m.deletedAt IS NULL
        AND ${relationLatest}
        AND ${whereSql}
        ${textClause}
      ORDER BY m.updatedAt DESC
      LIMIT ?
    `).all(...params, ...(ftsQuery ? [ftsQuery] : []), limit) as MemoryRow[];

    const impressions = recallPartition(`
      m.memoryType = 'impression'
      AND (
        (m.userId = ? AND m.agentId IS NULL)
        OR (m.userId IS NULL AND m.agentId = ?)
      )
    `, [input.userId, input.agentId ?? ""]);
    const events = recallPartition(
      "m.memoryType = 'event' AND m.userId = ? AND m.workspaceId = ?",
      [input.userId, input.workspaceId]
    );
    const skills = recallPartition(
      "m.memoryType = 'skill' AND m.workspaceId = ?",
      [input.workspaceId]
    );

    return [...impressions, ...events, ...skills];
  }

  createMemory(input: Partial<MemoryRow> & Pick<MemoryRow, "memoryType" | "title" | "summary" | "detail">, actorId: string, actorRole: UserRole): MemoryRow {
    const now = nowIso();
    const id = input.id ?? createId("mem");
    this.db.prepare(`
      INSERT INTO memories
        (id, memoryType, userId, agentId, workspaceId, relationId, version, title, summary, detail, metadataJson, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.memoryType, input.userId ?? null, input.agentId ?? null, input.workspaceId ?? null, input.relationId ?? null, input.version ?? 1, input.title, input.summary, input.detail, input.metadataJson ?? "{}", now, now);
    this.audit(actorId, actorRole, "create", "memory", id, { memoryType: input.memoryType });
    return this.getMemory(id);
  }

  getMemoryByRelation(memoryType: string, relationId: string): MemoryRow | undefined {
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE memoryType = ? AND relationId = ? AND deletedAt IS NULL
      ORDER BY version DESC
      LIMIT 1
    `).get(memoryType, relationId) as MemoryRow | undefined;
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
  }

  updateWorkspaceSessionLocalContext(session: WorkspaceSession): void {
    this.db.prepare(`
      UPDATE workspace_sessions
      SET status = ?, summary = ?, localContextJson = ?, resultJson = ?, observationsJson = ?, errorsJson = ?, completedAt = ?
      WHERE id = ?
    `).run(
      session.status,
      session.summary,
      JSON.stringify(session.localContext),
      JSON.stringify(session.result),
      JSON.stringify(session.observations),
      JSON.stringify(session.errors),
      session.completedAt ?? null,
      session.id
    );
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
    return row;
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

  listWorkspaceSessions(conversationId: string): WorkspaceSession[] {
    const rows = this.db.prepare("SELECT * FROM workspace_sessions WHERE conversationId = ? ORDER BY startedAt").all(conversationId) as Array<any>;
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
  }

  markLlmCallCompleted(llmCallId: string, response: unknown): void {
    this.db.prepare(`
      UPDATE llm_calls
      SET status = 'completed', responseJson = ?, errorText = NULL, completedAt = ?
      WHERE id = ?
    `).run(JSON.stringify(response ?? {}), nowIso(), llmCallId);
  }

  markLlmCallFailed(llmCallId: string, errorText: string): void {
    this.db.prepare(`
      UPDATE llm_calls
      SET status = 'failed', responseJson = ?, errorText = ?, completedAt = ?
      WHERE id = ?
    `).run(JSON.stringify({ failed: true, error: errorText }), errorText, nowIso(), llmCallId);
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
    this.db.prepare(`
      UPDATE approval_requests
      SET status = ?, resolvedAt = ?, resolvedBy = ?, resolutionReason = ?
      WHERE id = ?
    `).run(input.status, nowIso(), input.resolvedBy, input.resolutionReason ?? null, id);
    this.audit(input.resolvedBy, "creator", `approval_${input.status}`, "approval", id, {
      conversationId: current.conversationId,
      workspaceId: current.workspaceId,
      toolName: current.toolName,
      resolutionReason: input.resolutionReason
    });
    return this.getApprovalRequest(id);
  }

  getTrace(conversationId: string, actorId = "creator", actorRole: UserRole = "creator"): { sessions: WorkspaceSession[]; llmCalls: LLMCallSnapshot[]; contextSegments: ContextSegment[]; toolCalls: ToolCallLog[]; auditLogs: AuditLog[]; approvalRequests: ApprovalRequest[] } {
    const conversation = this.db.prepare("SELECT id, userId, agentId FROM conversations WHERE id = ?").get(conversationId) as { id: string; userId: string; agentId: string } | undefined;
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
      sessions: this.listWorkspaceSessions(conversationId),
      llmCalls: this.db.prepare("SELECT * FROM llm_calls WHERE conversationId = ? ORDER BY createdAt DESC").all(conversationId) as LLMCallSnapshot[],
      contextSegments: this.db.prepare("SELECT * FROM context_segments WHERE conversationId = ? ORDER BY sortOrder").all(conversationId) as ContextSegment[],
      toolCalls: this.listToolCalls(conversationId, toolLogUserId),
      auditLogs: this.listAuditLogs({ conversationId }),
      approvalRequests: this.listApprovalRequests({ conversationId })
    };
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

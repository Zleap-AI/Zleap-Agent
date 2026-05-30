import type Database from "better-sqlite3";
import { nowIso } from "../core/id";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('user', 'creator')),
      displayName TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      systemPrompt TEXT NOT NULL,
      personalityPrompt TEXT NOT NULL,
      defaultModel TEXT NOT NULL,
      defaultBaseUrl TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_profiles (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      providerName TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.2,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      rawJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      capabilitiesJson TEXT NOT NULL DEFAULT '[]',
      inputKindsJson TEXT NOT NULL DEFAULT '[]',
      outputKindsJson TEXT NOT NULL DEFAULT '[]',
      requiresApproval INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NOT NULL,
      toolInstructions TEXT NOT NULL,
      memoryPolicyJson TEXT NOT NULL DEFAULT '{}',
      riskLevel TEXT NOT NULL CHECK (riskLevel IN ('low', 'medium', 'high')),
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      parametersJson TEXT NOT NULL,
      riskLevel TEXT NOT NULL CHECK (riskLevel IN ('low', 'medium', 'high')),
      bindingType TEXT NOT NULL DEFAULT 'placeholder' CHECK (bindingType IN ('placeholder', 'runtime', 'mcp')),
      bindingJson TEXT NOT NULL DEFAULT '{}',
      mcpServerId TEXT,
      mcpToolName TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_tools (
      workspaceId TEXT NOT NULL,
      toolId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, toolId),
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (toolId) REFERENCES tool_definitions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      userId TEXT NOT NULL,
      workspaceId TEXT NOT NULL,
      taskId TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      objective TEXT NOT NULL,
      summary TEXT NOT NULL,
      taskJson TEXT NOT NULL DEFAULT '{}',
      resultJson TEXT NOT NULL DEFAULT '{}',
      localContextJson TEXT NOT NULL DEFAULT '{}',
      observationsJson TEXT NOT NULL,
      errorsJson TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      userId TEXT NOT NULL DEFAULT '',
      providerBaseUrl TEXT NOT NULL,
      normalizedEndpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      messagesJson TEXT NOT NULL,
      toolsJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS context_segments (
      id TEXT PRIMARY KEY,
      llmCallId TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      segmentType TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tokenEstimate INTEGER NOT NULL,
      sortOrder INTEGER NOT NULL,
      FOREIGN KEY (llmCallId) REFERENCES llm_calls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      userId TEXT NOT NULL DEFAULT '',
      workspaceId TEXT NOT NULL,
      workspaceSessionId TEXT,
      taskId TEXT,
      toolName TEXT NOT NULL,
      argumentsJson TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      memoryType TEXT NOT NULL CHECK (memoryType IN ('impression', 'event', 'skill')),
      userId TEXT,
      agentId TEXT,
      workspaceId TEXT,
      relationId TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      deletedBy TEXT,
      deleteReason TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      title,
      summary,
      detail,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, id, title, summary, detail)
      VALUES (new.rowid, new.id, new.title, new.summary, new.detail);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, title, summary, detail)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.detail);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, id, title, summary, detail)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.detail);
      INSERT INTO memories_fts(rowid, id, title, summary, detail)
      VALUES (new.rowid, new.id, new.title, new.summary, new.detail);
    END;

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      conversationId TEXT,
      workspaceId TEXT NOT NULL,
      toolName TEXT NOT NULL,
      argumentsJson TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      createdAt TEXT NOT NULL,
      resolvedAt TEXT,
      resolvedBy TEXT,
      resolutionReason TEXT,
      metadataJson TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actorId TEXT,
      actorRole TEXT NOT NULL,
      action TEXT NOT NULL,
      resourceKind TEXT NOT NULL,
      resourceId TEXT,
      workspaceId TEXT,
      conversationId TEXT,
      createdAt TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}'
    );
  `);

  ensureColumn(db, "llm_calls", "status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "llm_calls", "responseJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "llm_calls", "errorText", "TEXT");
  ensureColumn(db, "llm_calls", "completedAt", "TEXT");
  ensureColumn(db, "llm_calls", "userId", "TEXT NOT NULL DEFAULT ''");
  db.prepare(`
    UPDATE llm_calls
    SET userId = COALESCE((SELECT userId FROM conversations WHERE conversations.id = llm_calls.conversationId), userId)
    WHERE userId = ''
  `).run();
  ensureColumn(db, "workspace_sessions", "taskId", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "workspace_sessions", "taskJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "workspace_sessions", "resultJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "workspace_sessions", "localContextJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "workspaces", "capabilitiesJson", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "workspaces", "inputKindsJson", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "workspaces", "outputKindsJson", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "workspaces", "requiresApproval", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workspaces", "memoryPolicyJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tool_definitions", "bindingType", "TEXT NOT NULL DEFAULT 'placeholder'");
  ensureColumn(db, "tool_definitions", "bindingJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tool_definitions", "mcpServerId", "TEXT");
  ensureColumn(db, "tool_definitions", "mcpToolName", "TEXT");
  ensureColumn(db, "memories", "deletedAt", "TEXT");
  ensureColumn(db, "memories", "deletedBy", "TEXT");
  ensureColumn(db, "memories", "deleteReason", "TEXT");
  ensureColumn(db, "approval_requests", "conversationId", "TEXT");
  ensureColumn(db, "approval_requests", "argumentsJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "approval_requests", "resolvedBy", "TEXT");
  ensureColumn(db, "approval_requests", "resolutionReason", "TEXT");
  ensureColumn(db, "approval_requests", "metadataJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tool_calls", "workspaceSessionId", "TEXT");
  ensureColumn(db, "tool_calls", "taskId", "TEXT");
  ensureColumn(db, "tool_calls", "userId", "TEXT NOT NULL DEFAULT ''");

  db.prepare("INSERT OR IGNORE INTO schema_migrations (id, appliedAt) VALUES (?, ?)").run("0001_initial", nowIso());
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

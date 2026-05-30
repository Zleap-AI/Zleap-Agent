import type Database from "better-sqlite3";
import { nowIso } from "../core/id";

const toolSchemas = {
  enterWorkspace: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      objective: { type: "string" }
    },
    required: ["workspaceId", "objective"],
    additionalProperties: false
  },
  exitWorkspace: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "failed", "blocked", "needs_user_input", "needs_approval"] },
      summary: { type: "string" },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            ref: { type: "string" },
            description: { type: "string" }
          },
          required: ["kind", "ref"],
          additionalProperties: false
        }
      },
      observations: { type: "array", items: { type: "string" } },
      errors: { type: "array", items: { type: "string" } },
      suggestedNextSteps: { type: "array", items: { type: "string" } }
    },
    required: ["status", "summary", "artifacts", "observations", "errors", "suggestedNextSteps"],
    additionalProperties: false
  },
  askUser: {
    type: "object",
    properties: {
      question: { type: "string" },
      reason: { type: "string" },
      choices: { type: "array", items: { type: "string" } }
    },
    required: ["question"],
    additionalProperties: false
  },
  finishTask: {
    type: "object",
    properties: {
      summary: { type: "string" },
      response: { type: "string" },
      nextSteps: { type: "array", items: { type: "string" } }
    },
    required: ["summary"],
    additionalProperties: false
  },
  searchFiles: {
    type: "object",
    properties: {
      query: { type: "string" }
    },
    required: ["query"],
    additionalProperties: false
  },
  runCommand: {
    type: "object",
    properties: {
      command: { type: "string" }
    },
    required: ["command"],
    additionalProperties: false
  },
  searchMemory: {
    type: "object",
    properties: {
      query: { type: "string" },
      memoryType: { type: "string", enum: ["impression", "event", "skill"] }
    },
    required: ["query"],
    additionalProperties: false
  },
  writeUserImpression: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" }
    },
    required: ["title", "summary", "detail"],
    additionalProperties: false
  },
  writeAgentSelfImpression: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" }
    },
    required: ["title", "summary", "detail"],
    additionalProperties: false
  },
  writeEventMemory: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" }
    },
    required: ["title", "summary", "detail"],
    additionalProperties: false
  },
  writeSkillMemory: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" },
      desensitized: { type: "boolean" },
      procedure: { type: "array", items: { type: "string" } },
      appliesWhen: { type: "array", items: { type: "string" } },
      avoidWhen: { type: "array", items: { type: "string" } },
      evidenceEventIds: { type: "array", items: { type: "string" } },
      confidence: { type: "number" }
    },
    required: ["title", "summary", "detail", "desensitized", "procedure", "appliesWhen", "avoidWhen"],
    additionalProperties: false
  },
  updateMemory: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" },
      metadataJson: { type: "string" }
    },
    required: ["id"],
    additionalProperties: false
  },
  deleteMemory: {
    type: "object",
    properties: {
      id: { type: "string" },
      deleteReason: { type: "string" }
    },
    required: ["id"],
    additionalProperties: false
  }
};

const DEFAULT_SYSTEM_PROMPT = [
  "你是 Zleap 的内部执行 agent。",
  "runtime、workspace、context、tool call、memory injection 等信息只用于内部决策，不要在面向用户的回答里展示或解释。",
  "需要使用工具时，直接通过 function call 调用，不要告诉用户你正在调用工具、切换内部模块或读取内部上下文。",
  "当用户表达长期偏好、长期背景、自我认知更新或可复用经验时，应通过记忆写入工具请求 runtime 写入；runtime 会做权限和隔离检查。",
  "除非用户明确要求查看系统内部状态，否则像真人助手一样直接回答用户。"
].join("\n");

const DEFAULT_PERSONALITY_PROMPT = [
  "回答要自然、简洁、敏锐，像一个安静但可靠的协作者。",
  "不要表演人设，不要自我介绍，不要展示幕后机制。",
  "先解决用户真正的问题；必要时指出关键风险和下一步。"
].join("\n");

export function seedDefaults(db: Database.Database): void {
  const now = nowIso();

  db.prepare(`
    INSERT OR IGNORE INTO users (id, role, displayName, createdAt, updatedAt)
    VALUES ('creator', 'creator', 'Creator', ?, ?), ('user', 'user', 'User', ?, ?)
  `).run(now, now, now, now);

  db.prepare(`
    INSERT OR IGNORE INTO agents
      (id, name, systemPrompt, personalityPrompt, defaultModel, defaultBaseUrl, createdAt, updatedAt)
    VALUES
      ('default-agent', 'Zleap Agent', ?, ?, 'gpt-5-mini', 'https://api.302ai.com', ?, ?)
  `).run(DEFAULT_SYSTEM_PROMPT, DEFAULT_PERSONALITY_PROMPT, now, now);
  db.prepare(`
    UPDATE agents SET
      systemPrompt = ?,
      personalityPrompt = ?,
      defaultBaseUrl = 'https://api.302ai.com',
      updatedAt = ?
    WHERE id = 'default-agent'
  `).run(DEFAULT_SYSTEM_PROMPT, DEFAULT_PERSONALITY_PROMPT, now);

  db.prepare(`
    INSERT OR IGNORE INTO llm_profiles
      (id, agentId, providerName, baseUrl, model, temperature, createdAt, updatedAt)
    VALUES ('default-302ai', 'default-agent', '302AI', 'https://api.302ai.com', 'gpt-5-mini', 0.2, ?, ?)
  `).run(now, now);
  db.prepare("UPDATE llm_profiles SET baseUrl = 'https://api.302ai.com', updatedAt = ? WHERE id = 'default-302ai'").run(now);

  const insertWorkspace = db.prepare(`
    INSERT OR IGNORE INTO workspaces
      (id, name, description, instructions, toolInstructions, riskLevel, createdBy, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'creator', ?, ?)
  `);

  insertWorkspace.run("main", "主工作空间", "负责任务编排和 workspace 选择。", "理解用户目标，选择合适的 workspace，并整合结构化结果。不要直接使用子 workspace 的工具。", "只使用编排工具。", "low", now, now);
  insertWorkspace.run("file", "文件工作空间", "搜索和检查项目文件。", "只处理文件相关任务，不执行命令。", "通过已注册的文件工具搜索和读取文件状态。", "medium", now, now);
  insertWorkspace.run("cli", "命令行工作空间", "运行经过允许的命令行任务。", "只处理命令行任务。高风险命令需要 creator 批准。", "只通过已注册的 CLI 工具运行命令。", "high", now, now);

  const updateWorkspace = db.prepare(`
    UPDATE workspaces SET name = ?, description = ?, instructions = ?, toolInstructions = ?, updatedAt = ?
    WHERE id = ?
  `);
  updateWorkspace.run("主工作空间", "负责任务编排和 workspace 选择。", "理解用户目标，选择合适的 workspace，并整合结构化结果。不要直接使用子 workspace 的工具。", "只使用编排工具。", now, "main");
  updateWorkspace.run("文件工作空间", "搜索和检查项目文件。", "只处理文件相关任务，不执行命令。", "通过已注册的文件工具搜索和读取文件状态。", now, "file");
  updateWorkspace.run("命令行工作空间", "运行经过允许的命令行任务。", "只处理命令行任务。高风险命令需要 creator 批准。", "只通过已注册的 CLI 工具运行命令。", now, "cli");
  db.prepare("DELETE FROM workspace_tools WHERE workspaceId = 'memory'").run();
  db.prepare("DELETE FROM workspaces WHERE id = 'memory'").run();

  const defaultMemoryPolicy = {
    eventRecallEnabled: true,
    skillRecallEnabled: true,
    eventWriteEnabled: true,
    skillWriteEnabled: true,
    maxEventMemories: 4,
    maxSkillMemories: 4
  };
  const updateWorkspaceManifest = db.prepare(`
    UPDATE workspaces SET
      capabilitiesJson = ?,
      inputKindsJson = ?,
      outputKindsJson = ?,
      requiresApproval = ?,
      memoryPolicyJson = ?,
      updatedAt = ?
    WHERE id = ?
  `);
  updateWorkspaceManifest.run(
    JSON.stringify(["任务理解", "工作空间选择", "结果整合"]),
    JSON.stringify(["user_message", "workspace_result"]),
    JSON.stringify(["assistant_response", "workspace_task"]),
    0,
    JSON.stringify(defaultMemoryPolicy),
    now,
    "main"
  );
  updateWorkspaceManifest.run(
    JSON.stringify(["文件搜索", "代码阅读", "文档检查"]),
    JSON.stringify(["search_query", "file_path", "workspace_task"]),
    JSON.stringify(["file_matches", "file_summary", "workspace_result"]),
    0,
    JSON.stringify(defaultMemoryPolicy),
    now,
    "file"
  );
  updateWorkspaceManifest.run(
    JSON.stringify(["命令执行", "终端诊断", "测试运行"]),
    JSON.stringify(["command", "workspace_task"]),
    JSON.stringify(["command_output", "exit_status", "workspace_result"]),
    1,
    JSON.stringify(defaultMemoryPolicy),
    now,
    "cli"
  );

  const insertTool = db.prepare(`
    INSERT OR IGNORE INTO tool_definitions
      (id, name, description, parametersJson, riskLevel, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertTool.run("tool-enter-workspace", "enterWorkspace", "带着目标请求进入子 workspace。", JSON.stringify(toolSchemas.enterWorkspace), "low", now, now);
  insertTool.run("tool-exit-workspace", "exitWorkspace", "用结构化 WorkspaceResult 退出当前子 workspace，并返回 main workspace。", JSON.stringify(toolSchemas.exitWorkspace), "low", now, now);
  insertTool.run("tool-ask-user", "askUser", "Ask the user for missing information before continuing orchestration.", JSON.stringify(toolSchemas.askUser), "low", now, now);
  insertTool.run("tool-finish-task", "finishTask", "Mark the main workspace task as ready for final user-facing response.", JSON.stringify(toolSchemas.finishTask), "low", now, now);
  insertTool.run("tool-search-files", "searchFiles", "搜索项目文件名和文本内容。", JSON.stringify(toolSchemas.searchFiles), "medium", now, now);
  insertTool.run("tool-run-command", "runCommand", "运行经过允许的命令行命令。", JSON.stringify(toolSchemas.runCommand), "high", now, now);
  insertTool.run("tool-search-memory", "searchMemory", "使用 SQLite FTS 和作用域过滤搜索记忆。", JSON.stringify(toolSchemas.searchMemory), "low", now, now);
  insertTool.run("tool-write-user-impression", "writeUserImpression", "为当前用户写入长期偏好、长期背景或长期约束。", JSON.stringify(toolSchemas.writeUserImpression), "medium", now, now);
  insertTool.run("tool-write-agent-self-impression", "writeAgentSelfImpression", "由 creator 授权后写入 agent 自我认知。", JSON.stringify(toolSchemas.writeAgentSelfImpression), "high", now, now);
  insertTool.run("tool-write-event-memory", "writeEventMemory", "为当前用户和当前 active workspace 写入重要事件记忆。", JSON.stringify(toolSchemas.writeEventMemory), "medium", now, now);
  insertTool.run("tool-write-skill-memory", "writeSkillMemory", "为当前 active workspace 写入脱敏后的可复用经验。", JSON.stringify(toolSchemas.writeSkillMemory), "medium", now, now);

  insertTool.run("tool-update-memory", "updateMemory", "Update a memory record within runtime policy boundaries.", JSON.stringify(toolSchemas.updateMemory), "medium", now, now);
  insertTool.run("tool-delete-memory", "deleteMemory", "Delete a memory record within runtime policy boundaries.", JSON.stringify(toolSchemas.deleteMemory), "medium", now, now);

  const updateTool = db.prepare("UPDATE tool_definitions SET description = ?, updatedAt = ? WHERE id = ?");
  updateTool.run("带着目标请求进入子 workspace。", now, "tool-enter-workspace");
  updateTool.run("用结构化 WorkspaceResult 退出当前子 workspace，并返回 main workspace。", now, "tool-exit-workspace");
  updateTool.run("Ask the user for missing information before continuing orchestration.", now, "tool-ask-user");
  updateTool.run("Mark the main workspace task as ready for final user-facing response.", now, "tool-finish-task");
  updateTool.run("搜索项目文件名和文本内容。", now, "tool-search-files");
  updateTool.run("运行经过允许的命令行命令。", now, "tool-run-command");
  updateTool.run("使用 SQLite FTS 和作用域过滤搜索记忆。", now, "tool-search-memory");
  updateTool.run("为当前用户写入长期偏好、长期背景或长期约束。", now, "tool-write-user-impression");
  updateTool.run("由 creator 授权后写入 agent 自我认知。", now, "tool-write-agent-self-impression");
  updateTool.run("为当前用户和当前 active workspace 写入重要事件记忆。", now, "tool-write-event-memory");
  updateTool.run("为当前 active workspace 写入脱敏后的可复用经验。", now, "tool-write-skill-memory");

  updateTool.run("Update a memory record within runtime policy boundaries.", now, "tool-update-memory");
  updateTool.run("Delete a memory record within runtime policy boundaries.", now, "tool-delete-memory");

  const updateToolSchema = db.prepare("UPDATE tool_definitions SET parametersJson = ?, updatedAt = ? WHERE id = ?");
  updateToolSchema.run(JSON.stringify(toolSchemas.enterWorkspace), now, "tool-enter-workspace");
  updateToolSchema.run(JSON.stringify(toolSchemas.exitWorkspace), now, "tool-exit-workspace");
  updateToolSchema.run(JSON.stringify(toolSchemas.askUser), now, "tool-ask-user");
  updateToolSchema.run(JSON.stringify(toolSchemas.finishTask), now, "tool-finish-task");
  updateToolSchema.run(JSON.stringify(toolSchemas.searchFiles), now, "tool-search-files");
  updateToolSchema.run(JSON.stringify(toolSchemas.runCommand), now, "tool-run-command");
  updateToolSchema.run(JSON.stringify(toolSchemas.searchMemory), now, "tool-search-memory");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeUserImpression), now, "tool-write-user-impression");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeAgentSelfImpression), now, "tool-write-agent-self-impression");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeEventMemory), now, "tool-write-event-memory");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeSkillMemory), now, "tool-write-skill-memory");
  updateToolSchema.run(JSON.stringify(toolSchemas.updateMemory), now, "tool-update-memory");
  updateToolSchema.run(JSON.stringify(toolSchemas.deleteMemory), now, "tool-delete-memory");

  const updateToolBinding = db.prepare("UPDATE tool_definitions SET bindingType = ?, bindingJson = ?, mcpServerId = ?, mcpToolName = ?, updatedAt = ? WHERE id = ?");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.enterWorkspace" }), null, null, now, "tool-enter-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.exitWorkspace" }), null, null, now, "tool-exit-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.askUser" }), null, null, now, "tool-ask-user");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.finishTask" }), null, null, now, "tool-finish-task");
  updateToolBinding.run("mcp", JSON.stringify({ expectedServer: "local.file", expectedTool: "searchFiles" }), "local.file", "searchFiles", now, "tool-search-files");
  updateToolBinding.run("mcp", JSON.stringify({ expectedServer: "local.cli", expectedTool: "runCommand" }), "local.cli", "runCommand", now, "tool-run-command");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.searchMemory" }), null, null, now, "tool-search-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeUserImpression" }), null, null, now, "tool-write-user-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeAgentSelfImpression" }), null, null, now, "tool-write-agent-self-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeEventMemory" }), null, null, now, "tool-write-event-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeSkillMemory" }), null, null, now, "tool-write-skill-memory");

  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.updateMemory" }), null, null, now, "tool-update-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.deleteMemory" }), null, null, now, "tool-delete-memory");

  const link = db.prepare("INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)");
  link.run("main", "tool-enter-workspace", now);
  link.run("main", "tool-ask-user", now);
  link.run("main", "tool-finish-task", now);
  link.run("file", "tool-search-files", now);
  link.run("cli", "tool-run-command", now);
  const memoryToolIds = [
    "tool-search-memory",
    "tool-write-user-impression",
    "tool-write-agent-self-impression",
    "tool-write-event-memory",
    "tool-write-skill-memory",
    "tool-update-memory",
    "tool-delete-memory"
  ];
  const linkMemoryToolToAllWorkspaces = db.prepare(`
    INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt)
    SELECT id, ?, ? FROM workspaces
  `);
  for (const toolId of memoryToolIds) linkMemoryToolToAllWorkspaces.run(toolId, now);

  db.prepare("DELETE FROM workspace_tools WHERE toolId = 'tool-list-workspaces' OR (workspaceId = 'main' AND toolId = 'tool-list-workspaces')").run();
  db.prepare("DELETE FROM tool_definitions WHERE id = 'tool-list-workspaces' OR name = 'listWorkspaces'").run();
}

import type Database from "better-sqlite3";
import { nowIso } from "../core/id";

const toolSchemas = {
  enterWorkspace: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么此刻需要进入这个 workspace。" },
      workspaceId: { type: "string" },
      objective: { type: "string" }
    },
    required: ["workspaceId", "objective"],
    additionalProperties: false
  },
  exitWorkspace: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么此刻应该退出当前 workspace 并把结果交回 main。" },
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
      reason: { type: "string", description: "为什么当前任务已经可以交付最终回答。" },
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
      reason: { type: "string", description: "为什么需要搜索文件；必须说明要验证什么，而不是泛泛探索。" },
      query: { type: "string" }
    },
    required: ["reason", "query"],
    additionalProperties: false
  },
  readFile: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么需要读取这个文件；必须和当前任务直接相关。" },
      path: { type: "string", description: "仓库根目录内的相对路径。" },
      startLine: { type: "number", description: "可选，1-based 起始行。" },
      maxLines: { type: "number", description: "可选，最多读取行数，默认 200，最大 500。" }
    },
    required: ["reason", "path"],
    additionalProperties: false
  },
  writeFile: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么需要写入这个文件；必须说明写入目标和预期效果。" },
      path: { type: "string", description: "仓库根目录内的相对路径。" },
      content: { type: "string", description: "完整 UTF-8 文件内容；这是覆盖写入，不是追加或局部替换。" },
      createDirs: { type: "boolean", description: "目录不存在时是否自动创建父目录。" }
    },
    required: ["reason", "path", "content"],
    additionalProperties: false
  },
  runCommand: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么必须运行命令；必须说明预期验证或产出，避免无目的环境探测。" },
      command: { type: "string", description: "要执行的最小必要命令。不要用它替代 readFile/writeFile/searchFiles。" },
      cwd: { type: "string", description: "可选，仓库根目录内的相对工作目录。" },
      timeoutMs: { type: "number", description: "可选，超时时间，最大 120000。" }
    },
    required: ["reason", "command"],
    additionalProperties: false
  },
  searchMemory: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么自动召回不足以回答当前问题。" },
      query: { type: "string" },
      memoryType: { type: "string", enum: ["impression", "event", "skill"] }
    },
    required: ["query"],
    additionalProperties: false
  },
  readSkill: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么这条 skill 和当前任务高度相关。" },
      skillId: { type: "string" }
    },
    required: ["skillId"],
    additionalProperties: false
  },
  writeUserImpression: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么这是值得长期保存的用户印象。" },
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
      reason: { type: "string", description: "为什么这是 creator 授权保存的 agent 自我印象。" },
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
      reason: { type: "string", description: "为什么这是可复用、已脱敏、能降低未来失败率的经验。" },
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
  }
};

const DEFAULT_SYSTEM_PROMPT = [
  "你是 Zleap 的内部执行 agent。",
  "runtime、workspace、context、tool call、memory injection 等信息只用于内部决策，不要在面向用户的回答里展示或解释。",
  "需要使用工具时，直接通过 function call 调用，不要告诉用户你正在调用工具、切换内部模块或读取内部上下文。",
  "每一次 function call 都必须在参数里写清楚 reason：说明这次调用为什么必要、预期获得什么信息或产物。reason 是给 runtime/UI 调试看的，不要把它写进面向用户的回答。",
  "回复语言必须跟随用户当前消息的主要语言：用户用中文就用中文，用户用英文就用英文；除非用户明确要求翻译或指定另一种语言，不要中英混杂或随意切换语言。",
  "searchMemory 是低频补查工具；每轮上下文已经自动召回主要记忆，只有自动上下文不足、用户明确追问旧记忆，或任务依赖旧事件/偏好/经验证据时才调用。",
  "Skill 记忆采用渐进式披露：上下文只给名称和简介；当某条 Skill 明显相关并能减少失败时，先调用 readSkill 读取完整步骤再应用。",
  "当用户表达长期偏好、长期背景、自我认知更新或已脱敏的可复用经验时，可以通过对应记忆写入工具请求 runtime 写入；事件记忆由 runtime 生命周期 hook 自动提取。",
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
  insertWorkspace.run("dev", "开发工作空间", "统一处理项目文件搜索、文件读写、代码检查和命令行执行。", "处理需要本地项目上下文的任务，可以搜索文件、读取文件、写入文件，并在必要时运行命令。不要为了普通文件读写滥用命令行；高风险命令仍由工具级审批控制。", "每次工具调用都填写 reason。优先用 searchFiles 定位证据，用 readFile 查看内容，用 writeFile 写入完整文件；只有测试、构建、脚本运行、环境诊断或用户明确要求终端操作时才用 runCommand。不要无目的地查询系统配置；命令必须最小、可解释、和当前任务直接相关。把结果、错误和下一步建议结构化返回 main。", "medium", now, now);

  const updateWorkspace = db.prepare(`
    UPDATE workspaces SET name = ?, description = ?, instructions = ?, toolInstructions = ?, updatedAt = ?
    WHERE id = ?
  `);
  updateWorkspace.run("主工作空间", "负责任务编排和 workspace 选择。", "理解用户目标，选择合适的 workspace，并整合结构化结果。不要直接使用子 workspace 的工具。", "只使用编排工具。", now, "main");
  updateWorkspace.run("开发工作空间", "统一处理项目文件搜索、文件读写、代码检查和命令行执行。", "处理需要本地项目上下文的任务，可以搜索文件、读取文件、写入文件，并在必要时运行命令。不要为了普通文件读写滥用命令行；高风险命令仍由工具级审批控制。", "每次工具调用都填写 reason。优先用 searchFiles 定位证据，用 readFile 查看内容，用 writeFile 写入完整文件；只有测试、构建、脚本运行、环境诊断或用户明确要求终端操作时才用 runCommand。不要无目的地查询系统配置；命令必须最小、可解释、和当前任务直接相关。把结果、错误和下一步建议结构化返回 main。", now, "dev");
  db.prepare("DELETE FROM workspace_tools WHERE workspaceId = 'memory'").run();
  db.prepare("DELETE FROM workspaces WHERE id = 'memory'").run();
  db.prepare("UPDATE memories SET workspaceId = 'dev', updatedAt = ? WHERE workspaceId IN ('file', 'cli')").run(now);
  db.prepare("UPDATE approval_requests SET workspaceId = 'dev' WHERE workspaceId IN ('file', 'cli')").run();
  db.prepare("UPDATE mcp_servers SET workspaceId = 'dev', updatedAt = ? WHERE workspaceId IN ('file', 'cli')").run(now);
  db.prepare("DELETE FROM workspace_tools WHERE workspaceId IN ('file', 'cli')").run();
  db.prepare("DELETE FROM workspaces WHERE id IN ('file', 'cli')").run();

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
    JSON.stringify(["文件搜索", "文件读取", "文件写入", "代码阅读", "命令执行", "终端诊断", "测试运行"]),
    JSON.stringify(["user_request", "workspace_task"]),
    JSON.stringify(["file_matches", "file_content", "file_write_result", "command_output", "exit_status", "workspace_result"]),
    0,
    JSON.stringify(defaultMemoryPolicy),
    now,
    "dev"
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
  insertTool.run("tool-read-file", "readFile", "读取仓库内文件内容，适合在搜索后查看具体文件。", JSON.stringify(toolSchemas.readFile), "low", now, now);
  insertTool.run("tool-write-file", "writeFile", "覆盖写入仓库内 UTF-8 文件，适合创建或替换完整文件内容。", JSON.stringify(toolSchemas.writeFile), "medium", now, now);
  insertTool.run("tool-run-command", "runCommand", "运行经过允许的命令行命令。", JSON.stringify(toolSchemas.runCommand), "high", now, now);
  insertTool.run("tool-search-memory", "searchMemory", "低频补查记忆：仅在自动召回不足或用户明确追问旧记忆时，用具体 query 和可选 memoryType 进行作用域内 SQLite FTS 搜索。", JSON.stringify(toolSchemas.searchMemory), "low", now, now);
  insertTool.run("tool-read-skill", "readSkill", "读取当前 active workspace 中一条已召回 skill 的完整经验详情。", JSON.stringify(toolSchemas.readSkill), "low", now, now);
  insertTool.run("tool-write-user-impression", "writeUserImpression", "只为当前用户写入长期偏好、背景、身份、称呼或约束；不要记录 agent 自己。", JSON.stringify(toolSchemas.writeUserImpression), "medium", now, now);
  insertTool.run("tool-write-agent-self-impression", "writeAgentSelfImpression", "只在 creator 明确授权时写入 agent 自己的名字、身份、职责或长期行为原则；不要记录用户。", JSON.stringify(toolSchemas.writeAgentSelfImpression), "high", now, now);
  insertTool.run("tool-write-skill-memory", "writeSkillMemory", "为当前 active workspace 写入脱敏后的可复用经验。", JSON.stringify(toolSchemas.writeSkillMemory), "medium", now, now);

  const updateTool = db.prepare("UPDATE tool_definitions SET description = ?, updatedAt = ? WHERE id = ?");
  updateTool.run("带着目标请求进入子 workspace。", now, "tool-enter-workspace");
  updateTool.run("用结构化 WorkspaceResult 退出当前子 workspace，并返回 main workspace。", now, "tool-exit-workspace");
  updateTool.run("Ask the user for missing information before continuing orchestration.", now, "tool-ask-user");
  updateTool.run("Mark the main workspace task as ready for final user-facing response.", now, "tool-finish-task");
  updateTool.run("搜索项目文件名和文本内容。用于定位候选文件或关键词证据，不用于读取完整文件。调用时必须填写 reason，说明要验证什么。", now, "tool-search-files");
  updateTool.run("读取仓库内文件内容。优先在 searchFiles 定位后使用；不要用 runCommand/cat 代替。调用时必须填写 reason。", now, "tool-read-file");
  updateTool.run("覆盖写入仓库内 UTF-8 文件。适合创建或替换完整文件内容；不要用 runCommand/echo/python heredoc 代替普通文件写入。调用时必须填写 reason。", now, "tool-write-file");
  updateTool.run("运行最小必要命令。只用于测试、构建、脚本、诊断或用户明确要求终端操作；不要用它替代 searchFiles/readFile/writeFile，也不要无目的查询系统配置。调用时必须填写 reason、说明预期产出。", now, "tool-run-command");
  updateTool.run("低频补查记忆：仅在自动召回不足或用户明确追问旧记忆时，用具体 query 和可选 memoryType 进行作用域内 SQLite FTS 搜索。", now, "tool-search-memory");
  updateTool.run("读取当前 active workspace 中一条已召回 skill 的完整经验详情。", now, "tool-read-skill");
  updateTool.run("只在 creator 明确授权时写入 agent 自己的名字、身份、职责或长期行为原则；不要记录用户。", now, "tool-write-agent-self-impression");
  updateTool.run("只为当前用户写入长期偏好、背景、身份、称呼或约束；不要记录 agent 自己。", now, "tool-write-user-impression");
  updateTool.run("为当前 active workspace 写入脱敏后的可复用经验。", now, "tool-write-skill-memory");

  const updateToolSchema = db.prepare("UPDATE tool_definitions SET parametersJson = ?, updatedAt = ? WHERE id = ?");
  updateToolSchema.run(JSON.stringify(toolSchemas.enterWorkspace), now, "tool-enter-workspace");
  updateToolSchema.run(JSON.stringify(toolSchemas.exitWorkspace), now, "tool-exit-workspace");
  updateToolSchema.run(JSON.stringify(toolSchemas.askUser), now, "tool-ask-user");
  updateToolSchema.run(JSON.stringify(toolSchemas.finishTask), now, "tool-finish-task");
  updateToolSchema.run(JSON.stringify(toolSchemas.searchFiles), now, "tool-search-files");
  updateToolSchema.run(JSON.stringify(toolSchemas.readFile), now, "tool-read-file");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeFile), now, "tool-write-file");
  updateToolSchema.run(JSON.stringify(toolSchemas.runCommand), now, "tool-run-command");
  updateToolSchema.run(JSON.stringify(toolSchemas.searchMemory), now, "tool-search-memory");
  updateToolSchema.run(JSON.stringify(toolSchemas.readSkill), now, "tool-read-skill");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeUserImpression), now, "tool-write-user-impression");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeAgentSelfImpression), now, "tool-write-agent-self-impression");
  updateToolSchema.run(JSON.stringify(toolSchemas.writeSkillMemory), now, "tool-write-skill-memory");

  const updateToolBinding = db.prepare("UPDATE tool_definitions SET bindingType = ?, bindingJson = ?, mcpServerId = ?, mcpToolName = ?, updatedAt = ? WHERE id = ?");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.enterWorkspace" }), null, null, now, "tool-enter-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.exitWorkspace" }), null, null, now, "tool-exit-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.askUser" }), null, null, now, "tool-ask-user");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.finishTask" }), null, null, now, "tool-finish-task");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.searchFiles" }), null, null, now, "tool-search-files");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.readFile" }), null, null, now, "tool-read-file");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.writeFile" }), null, null, now, "tool-write-file");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.runCommand" }), null, null, now, "tool-run-command");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.searchMemory" }), null, null, now, "tool-search-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.readSkill" }), null, null, now, "tool-read-skill");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeUserImpression" }), null, null, now, "tool-write-user-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeAgentSelfImpression" }), null, null, now, "tool-write-agent-self-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeSkillMemory" }), null, null, now, "tool-write-skill-memory");

  db.prepare("UPDATE tool_definitions SET workspaceId = NULL WHERE bindingType = 'runtime'").run();
  db.prepare("UPDATE tool_definitions SET workspaceId = 'dev' WHERE id IN ('tool-search-files', 'tool-read-file', 'tool-write-file', 'tool-run-command')").run();

  const link = db.prepare("INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)");
  link.run("main", "tool-enter-workspace", now);
  link.run("main", "tool-ask-user", now);
  link.run("main", "tool-finish-task", now);
  link.run("dev", "tool-search-files", now);
  link.run("dev", "tool-read-file", now);
  link.run("dev", "tool-write-file", now);
  link.run("dev", "tool-run-command", now);
  const memoryToolIds = [
    "tool-search-memory",
    "tool-read-skill",
    "tool-write-user-impression",
    "tool-write-agent-self-impression",
    "tool-write-skill-memory"
  ];
  const linkMemoryToolToAllWorkspaces = db.prepare(`
    INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt)
    SELECT id, ?, ? FROM workspaces
  `);
  for (const toolId of memoryToolIds) linkMemoryToolToAllWorkspaces.run(toolId, now);

  db.prepare(`
    DELETE FROM workspace_tools
    WHERE toolId IN ('tool-write-event-memory', 'tool-update-memory', 'tool-delete-memory')
       OR toolId IN (SELECT id FROM tool_definitions WHERE name IN ('writeEventMemory', 'updateMemory', 'deleteMemory'))
  `).run();
  db.prepare(`
    DELETE FROM tool_definitions
    WHERE id IN ('tool-write-event-memory', 'tool-update-memory', 'tool-delete-memory')
       OR name IN ('writeEventMemory', 'updateMemory', 'deleteMemory')
  `).run();

  db.prepare("DELETE FROM workspace_tools WHERE toolId = 'tool-list-workspaces' OR (workspaceId = 'main' AND toolId = 'tool-list-workspaces')").run();
  db.prepare("DELETE FROM tool_definitions WHERE id = 'tool-list-workspaces' OR name = 'listWorkspaces'").run();
}

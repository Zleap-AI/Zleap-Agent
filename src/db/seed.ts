import type Database from "better-sqlite3";
import { nowIso } from "../core/id";
import { RUNTIME_CONFIG_DEFINITIONS } from "../core/runtime-config";

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
  read: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read, relative to the configured workspace root or absolute within that root." },
      offset: { type: "number", description: "Optional 1-based line number to start reading from." },
      limit: { type: "number", description: "Optional maximum number of lines to read." }
    },
    required: ["path"],
    additionalProperties: false
  },
  write: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to create or overwrite, relative to the configured workspace root or absolute within that root." },
      content: { type: "string", description: "Complete UTF-8 file content." }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  edit: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to edit, relative to the configured workspace root or absolute within that root." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact target text. It must identify one non-overlapping region in the original file." },
            newText: { type: "string", description: "Replacement text." }
          },
          required: ["oldText", "newText"],
          additionalProperties: false
        }
      }
    },
    required: ["path", "edits"],
    additionalProperties: false
  },
  bash: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute in the configured workspace root." },
      timeout: { type: "number", description: "Optional timeout in seconds." }
    },
    required: ["command"],
    additionalProperties: false
  },
  searchMemory: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么自动召回不足以回答当前问题；不要把它当普通搜索或每轮默认动作。" },
      query: { type: "string", description: "具体要查的旧记忆问题，避免泛泛写“记忆”“用户信息”。" },
      memoryType: { type: "string", enum: ["impression", "event", "skill"] }
    },
    required: ["reason", "query"],
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
  readMemory: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么必须读取完整详情，而不是只看摘要；用户追问“详细说说/展开/具体一点/还有哪些细节”时必须调用。" },
      memoryId: { type: "string", description: "要读取的 memory id，来自自动召回或 searchMemory 结果。" }
    },
    required: ["reason", "memoryId"],
    additionalProperties: false
  },
  writeUserImpression: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么这是值得长期保存的当前用户印象；例如用户自述、用户纠正，或用户授权搜索/工具结果确认了稳定身份、背景、偏好或约束。" },
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
  "工具调用参数必须严格匹配工具 schema；不要添加未声明字段。开发工具 read/write/edit/bash 不需要 reason。",
  "回复语言必须跟随用户当前消息的主要语言：用户用中文就用中文，用户用英文就用英文；除非用户明确要求翻译或指定另一种语言，不要中英混杂或随意切换语言。",
  "searchMemory 是低频补查工具；每轮上下文已经自动召回主要记忆，只有自动上下文不足、用户明确追问旧记忆，或任务依赖旧事件/偏好/经验证据时才调用。",
  "Memory 采用渐进式披露：上下文和搜索结果只适合先看 id、标题、摘要或片段，默认不注入完整 detail；当用户主动要求回忆、摘要不足以回答、或需要核对某条 impression/event 的详情时，调用 readMemory(memoryId) 读取完整 detail，不要凭摘要脑补。",
  "强制规则：如果用户在你基于自动召回摘要回答后继续追问“详细说说”“展开讲讲”“具体一点”“还有哪些细节”等，且上下文里已有相关 memory id，下一步必须先调用 readMemory。不要直接输出扩写后的自然语言回答。",
  "操作示例：用户问“你认识我吗”时，可以用自动召回的 impression summary 简短回答；如果用户接着说“详细说说”，你的下一条输出应该是 readMemory 的 function call，参数使用该 impression 的 memoryId，而不是直接编写更长的自然语言说明。",
  "操作反例：只根据 title/summary 把用户背景、经历、项目、时间线扩写成详细叙述，这是记忆幻觉；必须先 readMemory 获取 detail。",
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

  const insertRuntimeConfig = db.prepare(`
    INSERT OR IGNORE INTO runtime_config
      (key, category, label, description, valueType, valueJson, defaultValueJson, minValue, maxValue, step, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRuntimeConfigDefinition = db.prepare(`
    UPDATE runtime_config SET
      category = ?,
      label = ?,
      description = ?,
      valueType = ?,
      defaultValueJson = ?,
      minValue = ?,
      maxValue = ?,
      step = ?
    WHERE key = ?
  `);
  for (const definition of RUNTIME_CONFIG_DEFINITIONS) {
    insertRuntimeConfig.run(
      definition.key,
      definition.category,
      definition.label,
      definition.description,
      definition.valueType,
      JSON.stringify(definition.defaultValue),
      JSON.stringify(definition.defaultValue),
      definition.minValue ?? null,
      definition.maxValue ?? null,
      definition.step ?? null,
      now
    );
    updateRuntimeConfigDefinition.run(
      definition.category,
      definition.label,
      definition.description,
      definition.valueType,
      JSON.stringify(definition.defaultValue),
      definition.minValue ?? null,
      definition.maxValue ?? null,
      definition.step ?? null,
      definition.key
    );
  }

  const insertWorkspace = db.prepare(`
    INSERT OR IGNORE INTO workspaces
      (id, name, description, instructions, toolInstructions, riskLevel, createdBy, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'creator', ?, ?)
  `);

  insertWorkspace.run("main", "主工作空间", "负责任务编排和 workspace 选择。", "理解用户目标，选择合适的 workspace，并整合结构化结果。不要直接使用子 workspace 的工具。多阶段任务要按能力切片调度，例如搜索完成后回到 main，再进入开发/文件工作空间生成网页或写文件。", "只使用编排工具。", "low", now, now);
  insertWorkspace.run("dev", "开发工作空间", "统一处理会话文件工作目录内的搜索、读写、编辑和命令行执行。", "处理需要本地文件上下文的任务，可以在配置的 workspace root 内搜索文件、读取文件、写入文件、局部编辑文件，并在必要时运行命令。不要默认操作项目根目录；高风险命令仍由工具级审批控制。", "开发工具是 read/write/edit/bash。用 bash 的 ls、rg、find 定位文件；用 read 查看内容；用 edit 做局部修改；用 write 创建新文件或完整覆盖；只有测试、构建、脚本运行、环境诊断或用户明确要求终端操作时才用 bash。不要无目的地查询系统配置；命令必须最小、可解释、和当前任务直接相关。把结果、错误和下一步建议结构化返回 main。", "medium", now, now);

  const updateWorkspace = db.prepare(`
    UPDATE workspaces SET name = ?, description = ?, instructions = ?, toolInstructions = ?, updatedAt = ?
    WHERE id = ?
  `);
  updateWorkspace.run("主工作空间", "负责任务编排和 workspace 选择。", "理解用户目标，选择合适的 workspace，并整合结构化结果。不要直接使用子 workspace 的工具。多阶段任务要按能力切片调度，例如搜索完成后回到 main，再进入开发/文件工作空间生成网页或写文件。", "只使用编排工具。", now, "main");
  updateWorkspace.run("开发工作空间", "统一处理会话文件工作目录内的搜索、读写、编辑和命令行执行。", "处理需要本地文件上下文的任务，可以在配置的 workspace root 内搜索文件、读取文件、写入文件、局部编辑文件，并在必要时运行命令。不要默认操作项目根目录；高风险命令仍由工具级审批控制。", "开发工具是 read/write/edit/bash。用 bash 的 ls、rg、find 定位文件；用 read 查看内容；用 edit 做局部修改；用 write 创建新文件或完整覆盖；只有测试、构建、脚本运行、环境诊断或用户明确要求终端操作时才用 bash。不要无目的地查询系统配置；命令必须最小、可解释、和当前任务直接相关。把结果、错误和下一步建议结构化返回 main。", now, "dev");
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
    JSON.stringify(["文件搜索", "文件读取", "文件写入", "文件编辑", "代码阅读", "命令执行", "终端诊断", "测试运行"]),
    JSON.stringify(["user_request", "workspace_task"]),
    JSON.stringify(["file_matches", "file_content", "file_write_result", "file_edit_result", "command_output", "exit_status", "workspace_result"]),
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

  db.prepare(`
    DELETE FROM workspace_tools
    WHERE toolId IN ('tool-search-files', 'tool-read-file', 'tool-write-file', 'tool-run-command')
       OR toolId IN (SELECT id FROM tool_definitions WHERE name IN ('searchFiles', 'readFile', 'writeFile', 'runCommand', 'editFile'))
  `).run();
  db.prepare(`
    DELETE FROM tool_definitions
    WHERE id IN ('tool-search-files', 'tool-read-file', 'tool-write-file', 'tool-run-command')
       OR name IN ('searchFiles', 'readFile', 'writeFile', 'runCommand', 'editFile')
  `).run();

  insertTool.run("tool-enter-workspace", "enterWorkspace", "带着目标请求进入子 workspace。", JSON.stringify(toolSchemas.enterWorkspace), "low", now, now);
  insertTool.run("tool-exit-workspace", "exitWorkspace", "用结构化 WorkspaceResult 退出当前子 workspace，并返回 main workspace。", JSON.stringify(toolSchemas.exitWorkspace), "low", now, now);
  insertTool.run("tool-ask-user", "askUser", "Ask the user for missing information before continuing orchestration.", JSON.stringify(toolSchemas.askUser), "low", now, now);
  insertTool.run("tool-finish-task", "finishTask", "Mark the main workspace task as ready for final user-facing response.", JSON.stringify(toolSchemas.finishTask), "low", now, now);
  insertTool.run("tool-read", "read", "Read file contents.", JSON.stringify(toolSchemas.read), "low", now, now);
  insertTool.run("tool-write", "write", "Create or overwrite files.", JSON.stringify(toolSchemas.write), "medium", now, now);
  insertTool.run("tool-edit", "edit", "Make precise file edits with exact text replacement.", JSON.stringify(toolSchemas.edit), "medium", now, now);
  insertTool.run("tool-bash", "bash", "Execute shell commands in the configured workspace root.", JSON.stringify(toolSchemas.bash), "high", now, now);
  insertTool.run("tool-search-memory", "searchMemory", "低频补查记忆：仅在自动召回不足或用户明确追问旧记忆时，用具体 query 和可选 memoryType 进行作用域内 SQLite FTS 搜索。", JSON.stringify(toolSchemas.searchMemory), "low", now, now);
  insertTool.run("tool-read-memory", "readMemory", "按 memoryId 读取当前 runtime scope 可见记忆的完整详情；用于用户追问详细说说、主动回忆或摘要不足时，不暴露跨用户或跨工作空间记录。", JSON.stringify(toolSchemas.readMemory), "low", now, now);
  insertTool.run("tool-read-skill", "readSkill", "读取当前 active workspace 中一条已召回 skill 的完整经验详情。", JSON.stringify(toolSchemas.readSkill), "low", now, now);
  insertTool.run("tool-write-user-impression", "writeUserImpression", "为当前用户写入长期偏好、背景、身份、称呼、约束、工作习惯或用户授权搜索确认的稳定公开信息；不要记录 agent 自己或一次性任务细节。", JSON.stringify(toolSchemas.writeUserImpression), "medium", now, now);
  insertTool.run("tool-write-agent-self-impression", "writeAgentSelfImpression", "只在 creator 明确授权时写入 agent 自己的名字、身份、职责或长期行为原则；不要记录用户。", JSON.stringify(toolSchemas.writeAgentSelfImpression), "high", now, now);
  insertTool.run("tool-write-skill-memory", "writeSkillMemory", "为当前 active workspace 写入脱敏后的可复用经验。", JSON.stringify(toolSchemas.writeSkillMemory), "medium", now, now);

  const updateToolDefinition = db.prepare(`
    UPDATE tool_definitions SET
      description = ?,
      parametersJson = ?,
      promptSnippet = ?,
      promptGuidelinesJson = ?,
      executionMode = ?,
      riskLevel = ?,
      updatedAt = ?
    WHERE id = ?
  `);
  updateToolDefinition.run("带着目标请求进入子 workspace。", JSON.stringify(toolSchemas.enterWorkspace), "Enter a specialized workspace with a concrete objective", JSON.stringify(["Use this only from main when another workspace has the right capability."]), "sequential", "low", now, "tool-enter-workspace");
  updateToolDefinition.run("用结构化 WorkspaceResult 退出当前子 workspace，并返回 main workspace。", JSON.stringify(toolSchemas.exitWorkspace), "Exit the current child workspace with a structured result", JSON.stringify(["Use this when the child workspace task is complete, blocked, failed, needs user input, or needs approval."]), "sequential", "low", now, "tool-exit-workspace");
  updateToolDefinition.run("Ask the user for missing information before continuing orchestration.", JSON.stringify(toolSchemas.askUser), "Ask the user a focused question when required information is missing", JSON.stringify(["Use only when runtime cannot make safe progress without user input."]), "sequential", "low", now, "tool-ask-user");
  updateToolDefinition.run("Mark the main workspace task as ready for final user-facing response.", JSON.stringify(toolSchemas.finishTask), "Finish the main task with a user-facing response", JSON.stringify(["Use only from main when the task can be answered without more tool work."]), "sequential", "low", now, "tool-finish-task");
  updateToolDefinition.run("读取配置 workspace root 内的文件内容。支持 offset/limit、大文件截断和图片检测。", JSON.stringify(toolSchemas.read), "Read file contents", JSON.stringify(["Use read to examine files instead of bash with cat or sed.", "For large files, continue from the next offset when the result is truncated.", "Use bash with ls, rg, or find when you need to locate files."]), "parallel", "low", now, "tool-read");
  updateToolDefinition.run("创建或完整覆盖配置 workspace root 内的文件，自动创建父目录。", JSON.stringify(toolSchemas.write), "Create or overwrite files", JSON.stringify(["Use write only for new files or complete rewrites.", "Use edit for localized changes to existing files.", "Do not use bash, echo, heredoc, or shell redirection for ordinary file writes."]), "parallel", "medium", now, "tool-write");
  updateToolDefinition.run("对配置 workspace root 内的文件进行精确局部编辑，支持 Pi-style fuzzy matching。", JSON.stringify(toolSchemas.edit), "Make precise file edits with exact text replacement, including multiple disjoint edits in one call", JSON.stringify(["Use edit for precise localized changes.", "Each edits[].oldText is matched against the original file, not after earlier edits are applied.", "Use one edit call with multiple edits[] entries for separate changes in the same file.", "Do not emit overlapping or nested edits; merge nearby changes into one edit.", "Keep oldText as small as possible while still uniquely identifying the target region.", "Use write only for new files or complete rewrites."]), "parallel", "medium", now, "tool-edit");
  updateToolDefinition.run("在配置 workspace root 内执行 shell 命令。文件搜索通过 ls、rg、find 完成。", JSON.stringify(toolSchemas.bash), "Execute shell commands, including ls, rg, find, tests, builds, scripts, and diagnostics", JSON.stringify(["Use bash for file exploration commands like ls, rg, and find.", "Use bash only when command execution is necessary.", "Do not use bash as a substitute for read, write, or edit.", "Keep commands minimal."]), "sequential", "high", now, "tool-bash");
  updateToolDefinition.run("低频补查记忆：仅在自动召回不足或用户明确追问旧记忆时，用具体 query 和可选 memoryType 进行作用域内 SQLite FTS 搜索。", JSON.stringify(toolSchemas.searchMemory), "Search scoped memory when automatic recall is insufficient", JSON.stringify(["Use concrete queries and narrow memoryType when possible."]), "parallel", "low", now, "tool-search-memory");
  updateToolDefinition.run("按 memoryId 读取当前 runtime scope 可见记忆的完整详情；用于用户追问详细说说、主动回忆或摘要不足时，不暴露跨用户或跨工作空间记录。", JSON.stringify(toolSchemas.readMemory), "Read full details for a scoped memory", JSON.stringify(["Use when summary-only memory is insufficient or the user asks for details."]), "parallel", "low", now, "tool-read-memory");
  updateToolDefinition.run("读取当前 active workspace 中一条已召回 skill 的完整经验详情。", JSON.stringify(toolSchemas.readSkill), "Read a recalled skill before applying it", JSON.stringify(["Use when a recalled skill is highly relevant to the current task."]), "parallel", "low", now, "tool-read-skill");
  updateToolDefinition.run("只在 creator 明确授权时写入 agent 自己的名字、身份、职责或长期行为原则；不要记录用户。", JSON.stringify(toolSchemas.writeAgentSelfImpression), "Write an authorized long-term agent self impression", JSON.stringify(["Use only with creator authorization."]), "sequential", "high", now, "tool-write-agent-self-impression");
  updateToolDefinition.run("为当前用户写入长期偏好、背景、身份、称呼、约束、工作习惯或用户授权搜索确认的稳定公开信息；不要记录 agent 自己或一次性任务细节。", JSON.stringify(toolSchemas.writeUserImpression), "Write a stable user impression", JSON.stringify(["Use only for long-lived user facts, preferences, or constraints."]), "sequential", "medium", now, "tool-write-user-impression");
  updateToolDefinition.run("为当前 active workspace 写入脱敏后的可复用经验。", JSON.stringify(toolSchemas.writeSkillMemory), "Write a reusable desensitized workspace skill memory", JSON.stringify(["Use only for verified reusable procedures or failure-avoidance lessons."]), "sequential", "medium", now, "tool-write-skill-memory");

  const updateToolBinding = db.prepare("UPDATE tool_definitions SET bindingType = ?, bindingJson = ?, mcpServerId = ?, mcpToolName = ?, updatedAt = ? WHERE id = ?");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.enterWorkspace" }), null, null, now, "tool-enter-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.exitWorkspace" }), null, null, now, "tool-exit-workspace");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.askUser" }), null, null, now, "tool-ask-user");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "workspaceRuntime.finishTask" }), null, null, now, "tool-finish-task");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.read" }), null, null, now, "tool-read");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.write" }), null, null, now, "tool-write");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.edit" }), null, null, now, "tool-edit");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "builtin.bash" }), null, null, now, "tool-bash");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.searchMemory" }), null, null, now, "tool-search-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.readMemory" }), null, null, now, "tool-read-memory");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.readSkill" }), null, null, now, "tool-read-skill");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeUserImpression" }), null, null, now, "tool-write-user-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeAgentSelfImpression" }), null, null, now, "tool-write-agent-self-impression");
  updateToolBinding.run("runtime", JSON.stringify({ executor: "memoryService.writeSkillMemory" }), null, null, now, "tool-write-skill-memory");

  db.prepare("UPDATE tool_definitions SET workspaceId = NULL WHERE bindingType = 'runtime'").run();
  db.prepare("UPDATE tool_definitions SET workspaceId = 'dev' WHERE id IN ('tool-read', 'tool-write', 'tool-edit', 'tool-bash')").run();

  const link = db.prepare("INSERT OR IGNORE INTO workspace_tools (workspaceId, toolId, createdAt) VALUES (?, ?, ?)");
  link.run("main", "tool-enter-workspace", now);
  link.run("main", "tool-ask-user", now);
  link.run("main", "tool-finish-task", now);
  link.run("dev", "tool-read", now);
  link.run("dev", "tool-write", now);
  link.run("dev", "tool-edit", now);
  link.run("dev", "tool-bash", now);
  const memoryToolIds = [
    "tool-search-memory",
    "tool-read-memory",
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

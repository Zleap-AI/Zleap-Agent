import type { AgentConfig, AgentRunInput, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, ToolDefinition, WorkspaceDefinition, WorkspaceSession } from "../types";
import { AttentionBudget, AttentionBudgetManager, DEFAULT_ATTENTION_BUDGET, estimateTokens } from "./attention-budget";
import { createId } from "./id";

function memoryPartition(memories: MemoryRow[]): { impressions: MemoryRow[]; rollupEvents: MemoryRow[]; resultEvents: MemoryRow[]; processEvents: MemoryRow[]; skillMemories: MemoryRow[] } {
  const eventMemories = memories.filter((memory) => memory.memoryType === "event");
  return {
    impressions: memories.filter((memory) => memory.memoryType === "impression"),
    rollupEvents: eventMemories.filter((memory) => memoryEventKind(memory) === "rollup"),
    resultEvents: eventMemories.filter((memory) => memoryEventKind(memory) === "result"),
    processEvents: eventMemories.filter((memory) => memoryEventKind(memory) === "process"),
    skillMemories: memories.filter((memory) => memory.memoryType === "skill")
  };
}

function parseTools(toolsJson: string): ToolDefinition[] {
  try {
    const value = JSON.parse(toolsJson) as unknown;
    return Array.isArray(value) ? value as ToolDefinition[] : [];
  } catch {
    return [];
  }
}

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function memoryEventKind(memory: MemoryRow): string {
  const metadata = parseRecord(memory.metadataJson);
  return typeof metadata.eventKind === "string" ? metadata.eventKind : "";
}

function projectMemoryBase(memory: MemoryRow): Record<string, unknown> {
  return {
    id: memory.id,
    title: memory.title,
    summary: memory.summary,
    disclosure: "summary_only",
    detailAvailable: true,
    detailInjected: false,
    readTool: "readMemory",
    readInstruction: "如果用户追问这条记忆的细节、要求展开说明，或你需要依据完整内容回答，先调用 readMemory(memoryId)；不要把摘要脑补成详情。",
    relationId: memory.relationId,
    version: memory.version,
    updatedAt: memory.updatedAt
  };
}

function projectImpression(memory: MemoryRow): Record<string, unknown> {
  return {
    ...projectMemoryBase(memory),
    scope: memory.userId ? "user" : "agent"
  };
}

function projectResultEvent(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    eventKind: "result",
    outcome: metadata.outcome,
    source: metadata.source,
    conversationId: metadata.conversationId
  };
}

function projectRollupEvent(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    eventKind: "rollup",
    source: metadata.source,
    triggerSource: metadata.triggerSource,
    conversationId: metadata.conversationId,
    rollupMode: metadata.rollupMode,
    sourceEventIds: Array.isArray(metadata.sourceEventIds) ? metadata.sourceEventIds : [],
    sourceRefs: Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : []
  };
}

function projectProcessEvent(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    eventKind: "process",
    source: metadata.source,
    conversationId: metadata.conversationId
  };
}

function projectSkill(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    disclosure: "summary_only",
    detailAvailable: true,
    detailInjected: false,
    readTool: "readSkill",
    readInstruction: "如果这条 skill 与当前任务高度相关，先调用 readSkill(skillId) 读取完整 procedure/appliesWhen/avoidWhen/detail。",
    confidence: metadata.confidence
  };
}

function memoryDisclosureProtocol(userMessage: string): Record<string, unknown> {
  const normalized = userMessage.replace(/\s+/g, "");
  const detailIntent = /(详细|詳细|詳述|展开|展開|具体|具體|细节|細節|多说|多說|说清楚|說清楚|仔细|仔細|再说|再說|详细说说|詳細說說)/.test(normalized);
  return {
    defaultDisclosure: "summary_only",
    detailInjectedByDefault: false,
    ordinaryMemoryReadTool: "readMemory",
    skillReadTool: "readSkill",
    currentUserMessageLooksLikeDetailRequest: detailIntent,
    activeReadTriggers: [
      "用户追问详细说说、展开讲讲、具体一点、还有哪些细节。",
      "用户的问题直接要求回忆过去、解释你为什么知道、或核对旧记忆依据。",
      "自动召回/searchMemory 只给了 summary，但回答需要完整 detail 才可靠。"
    ],
    rules: [
      "自动召回的 impression/event 只提供 id、标题、摘要和读取入口；过程事件也不注入 detailSnippet，不包含完整 detail。",
      "如果用户追问某条已召回记忆的详情、要求展开说明，或回答需要依赖完整事实，必须先调用 readMemory(memoryId)。",
      "如果 currentUserMessageLooksLikeDetailRequest=true，优先从已召回 impression/event 中选择最相关 memoryId 调用 readMemory；不要先自然语言扩写。",
      "正例：用户先问“你认识我吗”，你可基于 impression summary 简答；用户随后说“详细说说”，下一步必须 readMemory，而不是继续自然语言回答。",
      "反例：把 summary 里的三四个词扩写成项目经历、履历或时间线，这是错误的；没有 readMemory 返回 detail，就不能制造细节。",
      "不要把 summary/snippet 扩写成看似详细的事实；没有 readMemory 返回的 detail，就只能明确基于摘要简述。"
    ]
  };
}

function parsePromptGuidelines(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toolPromptSummary(tool: ToolDefinition): string {
  return (tool.promptSnippet ?? tool.description).replace(/\s+/g, " ").trim();
}

function toolContext(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    id: tool.id,
    workspaceId: tool.workspaceId,
    name: tool.name,
    summary: toolPromptSummary(tool),
    guidelines: parsePromptGuidelines(tool.promptGuidelinesJson),
    executionMode: tool.executionMode,
    riskLevel: tool.riskLevel,
    bindingType: tool.bindingType,
    providerCallable: true,
    mcpServerId: tool.mcpServerId,
    mcpToolName: tool.mcpToolName
  }));
}

function toolPromptSection(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "No provider-callable tools are enabled for this workspace.";
  return tools.map((tool) => {
    const guidelines = parsePromptGuidelines(tool.promptGuidelinesJson);
    const lines = [
      `- ${tool.name}: ${toolPromptSummary(tool)} [risk=${tool.riskLevel}; executionMode=${tool.executionMode}]`
    ];
    for (const guideline of guidelines) {
      lines.push(`  - ${guideline.replace(/\s+/g, " ").trim()}`);
    }
    return lines.join("\n");
  }).join("\n");
}

function runtimeSystemContract(input: {
  run: AgentRunInput;
  workspace: WorkspaceDefinition;
}): string {
  const workspaceRule = input.workspace.id === "main"
    ? "主工作空间根据工作空间契约中的可用工作空间清单选择是否调用 enterWorkspace，并负责整合子工作空间返回的 WorkspaceResult。"
    : "当前是子工作空间。任务完成、失败、阻塞或需要用户信息时，必须调用 exitWorkspace 返回结构化 WorkspaceResult，由主工作空间决定下一步。";

  return [
    "内部运行策略：",
    `- 当前用户：${input.run.userId}`,
    `- 当前角色：${input.run.userRole}`,
    `- 当前工作空间：${input.workspace.id}`,
    "- 只使用当前工作空间暴露的 function call 工具；代码会强制决定 active workspace、可见工具、memory scope、approval、tenant ownership 和持久化边界。",
    "- 不要向用户暴露 runtime、workspace、context stack、memory injection、tool orchestration 等内部机制；需要工具时直接 function call。",
    "- 面向用户的回答必须使用用户当前消息的主要语言；用户用中文就用中文，用户用英文就用英文。除非用户明确要求翻译或指定语言，不要中英混杂或随意切换语言。",
    `- ${workspaceRule}`,
    "",
    "记忆写入协议：",
    "- writeUserImpression 只用于“当前用户”的稳定长期偏好、背景、身份、称呼、约束、工作习惯、长期项目或公开背景。例如用户说自己叫什么、喜欢什么回答风格、长期希望你遵守什么，或你通过用户授权的搜索/工具结果确认了当前用户的稳定身份与背景。不要把 agent 自己的名字、身份、职责、人格、能力边界写进 user impression。",
    "- 写 user impression 不需要等用户说“记住”。如果用户问“我是谁/你知道我是谁吗”、纠正自己的身份信息，或要求搜索关于自己的信息，而你已经在当前上下文、工具结果或 workspace 返回结果中得到可信的稳定用户信息，应先调用 writeUserImpression 保存紧凑印象，再继续回答或退出工作空间。",
    "- 不要把整段搜索结果、网页原文、一次性任务细节、未经确认的猜测、敏感隐私或短期事实写成 user impression。只保存可长期复用的精简结论，并在 detail 中说明来源是用户陈述、用户纠正，还是用户授权的搜索/工具结果。",
    "- writeAgentSelfImpression 只用于“agent 自己”的长期自我认识，例如 agent 的名字、身份定位、职责边界、默认行为原则或 creator 授权的自我设定。只有当前角色是 creator 且用户明确授权修改 agent 自我认知时才可调用；不要把用户偏好或用户身份写进 agent self impression。",
    "- 事件记忆由 runtime 生命周期 hook 按会话窗口、工作空间退出等程序化时机自动提取；模型没有事件记忆写入工具。",
    "- searchMemory 是低频补查工具，不是每轮默认动作。runtime 每轮已经自动召回印象、当前工作空间结果事件、相关过程事件和 Skill 简介；只有自动上下文明显不足、用户明确问“你还记得/之前说过/以前做过什么”、需要核对不在当前上下文里的旧事件/偏好/经验，或当前任务明确依赖旧记忆证据时，才调用 searchMemory。",
    "- 不要为了确认当前上下文里已经出现的信息而调用 searchMemory；不要把 searchMemory 当作普通搜索、workspace 发现、工具发现或每轮安全检查；不要连续用多个泛泛 query 试探记忆库。调用时必须使用具体 query，并优先用 memoryType 限定 impression/event/skill。",
    "- Memory 也采用渐进式披露：上下文和 searchMemory 结果通常只适合先看 id/title/summary/snippet，默认不注入完整 detail。若用户主动要求回忆、你需要依据某条 impression/event 的具体内容回答、或摘要不足以确认事实，应调用 readMemory(memoryId) 读取该条记忆的完整 detail；不要凭摘要脑补。",
    "- 主动读取规则：当用户追问“详细说说”“展开讲讲”“具体一点”“还有哪些细节”“你为什么知道”“你还记得什么”等，或者用户要求解释某个已召回 impression/event 的依据时，要先从当前 memory 分区或 searchMemory 结果中选出最相关的 memoryId 调用 readMemory，再回答。",
    "- 特别注意：如果用户在你基于自动召回摘要回答后继续追问详情，且上下文里已有相关 memory id，这就是 readMemory 的典型触发场景。必须先读详情，再给用户展开说明；不要直接把 summary 改写成更长的回答。",
    "- 如果上下文里没有足够相关的 memory id，但用户明确在问旧记忆或过往细节，先用具体 query 调用 searchMemory；找到候选后，再用 readMemory 读取最相关的一条，而不是直接回答“没有更多细节”。",
    "- 操作示例：用户问“你认识我吗”时，可以用自动召回的 impression summary 简短回答；如果用户接着说“详细说说”，你的下一条输出应该是 readMemory 的 function call，参数使用该 impression 的 memoryId，而不是直接编写更长的自然语言说明。",
    "- 操作反例：只根据 title/summary 把用户背景、经历、项目、时间线扩写成详细叙述，这是记忆幻觉；必须先 readMemory 获取 detail。",
    "- Skill 采用渐进式披露：上下文里只会看到当前工作空间最近的 skill 名称和简介。如果某条 skill 简介与当前任务高度相关、能减少失败或能指导工具使用，先调用 readSkill 读取完整 procedure/appliesWhen/avoidWhen/detail，再应用该经验。",
    "- 当用户或 agent 明确要求沉淀可复用经验，或你发现了已经脱敏、可复用且能减少未来失败的方法时，可以调用 writeSkillMemory；skill 必须属于当前工作空间，并包含 procedure、appliesWhen、avoidWhen、desensitized=true 和 confidence。",
    "- Skill 不是普通总结。只有可迁移的方法、失败后找到的稳定规避方式、经过验证的工具流程、或能降低同类任务失败率的经验才值得写入。不要写“认真检查”“合理使用工具”“保持上下文”这类空泛内容。",
    "- 生命周期 hook 也可以保守地提取 skill，但必须脱敏，并且只有在确实得到可复用方法时才写入；不要为了写记忆而强行总结经验。",
    "- 如果不确定某条信息是在描述用户还是描述 agent 自己，不要写 impression；继续保持在当前对话上下文里。",
    "- memory 工具调用中不要传 userId、agentId、workspaceId、relationId、version 等 scope 字段；这些由 runtime 代码绑定。",
    "- 记忆演化采用追加新记录/读取最新有效记录的方式；模型不能通过工具更新或删除既有记忆。"
  ].join("\n");
}

function workspaceDecisionContract(input: {
  run: AgentRunInput;
  workspace: WorkspaceDefinition;
}): string {
  const roleRule = input.workspace.id === "main"
    ? [
      "- 你当前在 main workspace。main 是任务编排者和结果整合者，不直接拥有所有专业工具。",
      "- main 会看到可用 workspace 清单。需要文件、命令行、外部 MCP 能力或其他专门工具时，选择最合适的 workspace 并调用 enterWorkspace。",
      "- main 负责拆分多阶段任务：例如先进入搜索类 workspace 获取资料，再根据返回的搜索证据进入开发/文件类 workspace 生成网页或写文件。不要期待一个子 workspace 顺手完成另一个 workspace 的产物。",
      "- 子 workspace 返回 WorkspaceResult 后，main 负责整合结果：继续进入其他 workspace、请求用户补充信息，或给用户自然语言最终答复。"
    ]
    : [
      `- 你当前在子 workspace：${input.workspace.id}。子 workspace 是一个专门能力环境，只能使用当前暴露的工具和当前局部上下文。`,
      "- 子 workspace 也会看到可用 workspace manifest 清单；这是一份跨 workspace 共享的环境记忆/能力地图，类似一个人使用某个软件时也知道还有别的软件存在。",
      "- 这份能力地图只用于判断是否需要其他能力；子 workspace 不能直接进入其他 workspace，也不会暴露 enterWorkspace。",
      "- 子 workspace 只负责完成自己能力范围内的那一段任务。完成当前能力切片后，必须调用 exitWorkspace，把结果、证据、限制和建议下一步交回 main。",
      "- 不要在子 workspace 里继续做下游产物任务。搜索类 workspace 搜索完就返回搜索结果、来源、可信度和建议；生成网页、写文件、运行本地命令等属于其他 workspace 时，应写入 suggestedNextSteps，由 main 调度到对应 workspace。",
      "- 不要伪造当前工具没有真实产出的 artifacts。只有当前 workspace 的工具实际创建、修改或导出的文件/网页/报告，才能作为 artifacts 返回；否则只能作为 observations 或 suggestedNextSteps。",
      "- 子 workspace 自己决定何时退出：任务完成、失败、阻塞、需要用户信息、需要审批、或发现当前工具无法继续满足目标时，都应调用 exitWorkspace。",
      "- 如果需要另一个 workspace 的工具，不要在子 workspace 里直接切换；用 exitWorkspace 把已完成内容、困难、缺失能力和建议下一步交给 main，由 main 决定是否进入其他 workspace。"
    ];

  return [
    "内部 workspace 决策契约：",
    "- workspace 是内部能力边界，不是面向用户解释的概念。用户只看到一条连续任务线；不要在最终答复里解释 workspace、runtime、context stack 或 tool orchestration。",
    "- 每次 user message 保持干净。系统/人格/策略/工作空间说明在 system message；记忆和本地对话由 runtime 作为工具结果注入。",
    "- 选择 workspace 的核心标准是能力匹配：当前工具能解决就继续；当前工具不足、目标属于其他专业能力、或需要组合多个能力时，回到 main 重新编排。",
    "- 工作空间有产物责任边界：当前 workspace 只能交付自己工具和说明真实支持的结果；不能因为知道用户最终想要什么，就在错误 workspace 中生成文件、网页、报告或其他下游产物。",
    "- runtime 会在 workspace 切换时自动注入有限的 handoffContext：进入子 workspace 时携带总体要求、当前用户请求和少量用户原话参考；这些原话只作为理解任务的参考，不是当前子 workspace 的本地对话。进入交接包不携带父 workspace 工具协议、assistant 执行记录或 sibling workspace 记录；返回 main 时只携带子 workspace 的结果上下文、AI 回复摘要、最后助手结论和关键工具结果，不携带工具调用参数或冗长中间过程。模型不要自己伪造这些交叉上下文，也不要在最终答复里解释它。",
    "- 像软件之间交付产物一样对待 handoffContext：不需要复述子 workspace 的完整操作过程，但必须忠于子 workspace 交付的 WorkspaceResult、最终结论和关键工具结果。不要把这些结果再随意压缩、改写或遗漏关键事实。",
    ...roleRule,
    "- exitWorkspace 的输出必须是 WorkspaceResult：status、summary、artifacts、observations、errors、suggestedNextSteps。",
    "- status 用 completed、failed、blocked、needs_user_input 或 needs_approval。不要返回 running。",
    "- summary 写给 main 整合用；observations 放关键事实；errors 放失败原因；suggestedNextSteps 放建议 main 接下来进入哪个 workspace、问用户什么，或如何继续。",
    "",
    runtimeSystemContract(input)
  ].join("\n");
}

export class ContextBuilder {
  private readonly attentionBudget: AttentionBudgetManager;

  constructor(budget: AttentionBudget = DEFAULT_ATTENTION_BUDGET) {
    this.attentionBudget = new AttentionBudgetManager(budget);
  }

  build(input: {
    llmCallId: string;
    conversationId: string;
    agent: AgentConfig;
    run: AgentRunInput;
    workspace: WorkspaceDefinition;
    workspaceRegistry: WorkspaceDefinition[];
    activeSession: WorkspaceSession;
    workspaceTrace: WorkspaceSession[];
    memories: MemoryRow[];
    history: Array<{ role: string; content: string }>;
    toolsJson: string;
  }): ContextSegment[] {
    const partitionedMemory = memoryPartition(input.memories);
    const currentTools = parseTools(input.toolsJson);
    const availableWorkspaces = input.workspaceRegistry.map((workspace) => workspace.manifest);
    const completedWorkspaceResults = input.workspaceTrace
      .filter((session) => session.status !== "running")
      .filter((session) => input.workspace.id === "main" || session.workspaceId === input.workspace.id)
      .map((session) => session.result);

    const segments: Array<Omit<ContextSegment, "id" | "llmCallId" | "conversationId" | "tokenEstimate">> = [
      {
        segmentType: "system",
        title: "系统提示词",
        content: [
          "## 基础系统提示词",
          input.agent.systemPrompt,
          "",
          "## 人格提示词",
          input.agent.personalityPrompt,
          "",
          "## 内部运行策略",
          workspaceDecisionContract({ run: input.run, workspace: input.workspace }),
          "",
          "## Available tools",
          toolPromptSection(currentTools)
        ].join("\n"),
        sortOrder: 10
      },
      {
        segmentType: "workspace",
        title: "工作空间信息",
        content: JSON.stringify({
          currentWorkspace: {
            id: input.workspace.id,
            name: input.workspace.name,
            description: input.workspace.description,
            manifest: input.workspace.manifest,
            instructions: input.workspace.instructions,
            toolInstructions: input.workspace.toolInstructions,
            memoryPolicy: input.workspace.memoryPolicy
          },
          availableWorkspaces
        }, null, 2),
        sortOrder: 20
      },
      {
        segmentType: "tools",
        title: "Callable Tools",
        content: JSON.stringify({
          activeWorkspaceId: input.workspace.id,
          toolCount: currentTools.length,
          tools: toolContext(currentTools)
        }, null, 2),
        sortOrder: 25
      },
      {
        segmentType: "memory",
        title: "记忆",
        content: JSON.stringify({
          memoryDisclosureProtocol: memoryDisclosureProtocol(input.run.message),
          crossWorkspaceImpressionMemory: partitionedMemory.impressions.map(projectImpression),
          currentWorkspaceEventRollups: partitionedMemory.rollupEvents.map(projectRollupEvent),
          currentWorkspaceResultEvents: partitionedMemory.resultEvents.map(projectResultEvent),
          currentWorkspaceRelevantProcessEvents: partitionedMemory.processEvents.map(projectProcessEvent),
          currentWorkspaceSkillMemory: partitionedMemory.skillMemories.map(projectSkill)
        }, null, 2),
        sortOrder: 30
      },
      {
        segmentType: "history",
        title: "本地对话片段",
        content: JSON.stringify({
          messages: input.history,
          currentTask: input.activeSession.task,
          completedWorkspaceResults,
          crossWorkspaceHandoffContext: input.activeSession.localContext.handoffContext ?? [],
          recentToolEvidence: input.activeSession.localContext.recentToolCalls
        }, null, 2),
        sortOrder: 40
      },
      {
        segmentType: "user",
        title: "干净用户消息",
        content: input.run.message,
        sortOrder: 50
      }
    ];

    return this.attentionBudget.apply(segments).map((segment) => ({
      ...segment,
      id: createId("ctx"),
      llmCallId: input.llmCallId,
      conversationId: input.conversationId,
      tokenEstimate: estimateTokens(segment.content)
    }));
  }
}

export class PromptAssembler {
  assemble(segments: ContextSegment[], userMessage: string): LLMMessage[] {
    const byType = new Map(segments.map((segment) => [segment.segmentType, segment]));
    const parseSegment = (type: ContextSegment["segmentType"], fallback: unknown) => {
      const content = byType.get(type)?.content;
      if (!content) return fallback;
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return fallback;
      }
    };
    const systemSegment = byType.get("system");
    const systemContent = systemSegment ? `## ${systemSegment.title}\n${systemSegment.content}` : "";

    const workspaceToolCallId = "runtime_context_workspace";
    const resourcesToolCallId = "runtime_context_resources";
    const toolsToolCallId = "runtime_context_tools";
    const memoryToolCallId = "runtime_context_memory";
    const localConversationToolCallId = "runtime_context_local_conversation";
    return [
      {
        role: "system",
        content: systemContent
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: workspaceToolCallId,
            type: "function",
            function: {
              name: "runtime_context.workspace",
              arguments: "{}"
            }
          },
          {
            id: resourcesToolCallId,
            type: "function",
            function: {
              name: "runtime_context.resources",
              arguments: "{}"
            }
          },
          {
            id: toolsToolCallId,
            type: "function",
            function: {
              name: "runtime_context.tools",
              arguments: "{}"
            }
          },
          {
            id: memoryToolCallId,
            type: "function",
            function: {
              name: "runtime_context.memory",
              arguments: "{}"
            }
          },
          {
            id: localConversationToolCallId,
            type: "function",
            function: {
              name: "runtime_context.local_conversation",
              arguments: "{}"
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: workspaceToolCallId,
        name: "runtime_context.workspace",
        content: JSON.stringify(parseSegment("workspace", {
          currentWorkspace: {},
          availableWorkspaces: []
        }), null, 2)
      },
      {
        role: "tool",
        tool_call_id: resourcesToolCallId,
        name: "runtime_context.resources",
        content: JSON.stringify(parseSegment("resources", {
          instructions: [],
          promptTemplates: [],
          filesystemSkills: [],
          rules: []
        }), null, 2)
      },
      {
        role: "tool",
        tool_call_id: toolsToolCallId,
        name: "runtime_context.tools",
        content: JSON.stringify(parseSegment("tools", {
          activeWorkspaceId: "",
          toolCount: 0,
          tools: []
        }), null, 2)
      },
      {
        role: "tool",
        tool_call_id: memoryToolCallId,
        name: "runtime_context.memory",
        content: JSON.stringify(parseSegment("memory", {
          crossWorkspaceImpressionMemory: [],
          currentWorkspaceResultEvents: [],
          currentWorkspaceRelevantProcessEvents: [],
          currentWorkspaceSkillMemory: []
        }), null, 2)
      },
      {
        role: "tool",
        tool_call_id: localConversationToolCallId,
        name: "runtime_context.local_conversation",
        content: JSON.stringify(parseSegment("history", {
          messages: [],
          currentTask: {},
          completedWorkspaceResults: [],
          crossWorkspaceHandoffContext: [],
          recentToolEvidence: []
        }), null, 2)
      },
      {
        role: "user",
        content: userMessage
      }
    ];
  }
}

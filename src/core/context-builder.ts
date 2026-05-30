import type { AgentConfig, AgentRunInput, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, ToolDefinition, WorkspaceDefinition, WorkspaceSession } from "../types";
import { AttentionBudget, AttentionBudgetManager, DEFAULT_ATTENTION_BUDGET, estimateTokens } from "./attention-budget";
import { createId } from "./id";

function memoryPartition(memories: MemoryRow[]): { impressions: MemoryRow[]; resultEvents: MemoryRow[]; processEvents: MemoryRow[]; skillMemories: MemoryRow[] } {
  const eventMemories = memories.filter((memory) => memory.memoryType === "event");
  return {
    impressions: memories.filter((memory) => memory.memoryType === "impression"),
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

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function projectMemoryBase(memory: MemoryRow): Record<string, unknown> {
  return {
    id: memory.id,
    title: memory.title,
    summary: memory.summary,
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

function projectProcessEvent(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    eventKind: "process",
    source: metadata.source,
    conversationId: metadata.conversationId,
    detailSnippet: truncate(memory.detail, 480)
  };
}

function projectSkill(memory: MemoryRow): Record<string, unknown> {
  const metadata = parseRecord(memory.metadataJson);
  return {
    ...projectMemoryBase(memory),
    procedure: Array.isArray(metadata.procedure) ? metadata.procedure : undefined,
    appliesWhen: Array.isArray(metadata.appliesWhen) ? metadata.appliesWhen : undefined,
    avoidWhen: Array.isArray(metadata.avoidWhen) ? metadata.avoidWhen : undefined,
    confidence: metadata.confidence,
    detailSnippet: truncate(memory.detail, 480)
  };
}

function toolContext(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    id: tool.id,
    workspaceId: tool.workspaceId,
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    bindingType: tool.bindingType,
    mcpServerId: tool.mcpServerId,
    mcpToolName: tool.mcpToolName,
    parameters: parseJsonOrRaw(tool.parametersJson),
    binding: parseJsonOrRaw(tool.bindingJson)
  }));
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
    `- ${workspaceRule}`,
    "",
    "记忆写入协议：",
    "- writeUserImpression 只用于“当前用户”的稳定长期偏好、背景、身份、称呼、约束或工作习惯。例如用户说自己叫什么、喜欢什么回答风格、长期希望你遵守什么。不要把 agent 自己的名字、身份、职责、人格、能力边界写进 user impression。",
    "- writeAgentSelfImpression 只用于“agent 自己”的长期自我认识，例如 agent 的名字、身份定位、职责边界、默认行为原则或 creator 授权的自我设定。只有当前角色是 creator 且用户明确授权修改 agent 自我认知时才可调用；不要把用户偏好或用户身份写进 agent self impression。",
    "- 事件记忆由 runtime 生命周期 hook 按会话窗口、工作空间退出等程序化时机自动提取；模型没有事件记忆写入工具。",
    "- 当用户或 agent 明确要求沉淀可复用经验，或你发现了已经脱敏、可复用的方法时，可以调用 writeSkillMemory；skill 必须属于当前工作空间，并包含 procedure、appliesWhen、avoidWhen、desensitized=true 和 confidence。",
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
      "- 子 workspace 返回 WorkspaceResult 后，main 负责整合结果：继续进入其他 workspace、请求用户补充信息，或给用户自然语言最终答复。"
    ]
    : [
      `- 你当前在子 workspace：${input.workspace.id}。子 workspace 是一个专门能力环境，只能使用当前暴露的工具和当前局部上下文。`,
      "- 子 workspace 也会看到可用 workspace manifest 清单；这是一份跨 workspace 共享的环境记忆/能力地图，类似一个人使用某个软件时也知道还有别的软件存在。",
      "- 这份能力地图只用于判断是否需要其他能力；子 workspace 不能直接进入其他 workspace，也不会暴露 enterWorkspace。",
      "- 子 workspace 自己决定何时退出：任务完成、失败、阻塞、需要用户信息、需要审批、或发现当前工具无法继续满足目标时，都应调用 exitWorkspace。",
      "- 如果需要另一个 workspace 的工具，不要在子 workspace 里直接切换；用 exitWorkspace 把已完成内容、困难、缺失能力和建议下一步交给 main，由 main 决定是否进入其他 workspace。"
    ];

  return [
    "内部 workspace 决策契约：",
    "- workspace 是内部能力边界，不是面向用户解释的概念。用户只看到一条连续任务线；不要在最终答复里解释 workspace、runtime、context stack 或 tool orchestration。",
    "- 每次 user message 保持干净。系统/人格/策略/工作空间说明在 system message；记忆和本地对话由 runtime 作为工具结果注入。",
    "- 选择 workspace 的核心标准是能力匹配：当前工具能解决就继续；当前工具不足、目标属于其他专业能力、或需要组合多个能力时，回到 main 重新编排。",
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
          workspaceDecisionContract({ run: input.run, workspace: input.workspace })
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
          crossWorkspaceImpressionMemory: partitionedMemory.impressions.map(projectImpression),
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
    const systemContent = ["system", "workspace"]
      .map((key) => byType.get(key as ContextSegment["segmentType"]))
      .filter(Boolean)
      .map((segment) => `## ${segment!.title}\n${segment!.content}`)
      .join("\n\n");

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

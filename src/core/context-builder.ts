import type { AgentConfig, AgentRunInput, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, WorkspaceDefinition, WorkspaceSession } from "../types";
import { AttentionBudget, AttentionBudgetManager, DEFAULT_ATTENTION_BUDGET, estimateTokens } from "./attention-budget";
import { createId } from "./id";

function memoryPartition(memories: MemoryRow[]): { impressions: MemoryRow[]; eventMemories: MemoryRow[]; skillMemories: MemoryRow[] } {
  return {
    impressions: memories.filter((memory) => memory.memoryType === "impression"),
    eventMemories: memories.filter((memory) => memory.memoryType === "event"),
    skillMemories: memories.filter((memory) => memory.memoryType === "skill")
  };
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
    const visibleWorkspaceRegistry = input.workspace.id === "main"
      ? input.workspaceRegistry.map((workspace) => workspace.manifest)
      : [];
    const segments: Array<Omit<ContextSegment, "id" | "llmCallId" | "conversationId" | "tokenEstimate">> = [
      { segmentType: "system", title: "系统提示词", content: input.agent.systemPrompt, sortOrder: 10 },
      { segmentType: "personality", title: "人格提示词", content: input.agent.personalityPrompt, sortOrder: 20 },
      {
        segmentType: "policy",
        title: "内部运行策略",
        content: [
          `Current userId: ${input.run.userId}`,
          `Current role: ${input.run.userRole}`,
          `Active workspace: ${input.workspace.id}`,
          "Use only tools registered to the active workspace. Memory tools are mounted in every workspace, but event/skill memory scope is code-bound to the active workspace; never pass userId, agentId, or workspaceId as memory tool arguments. Memory writes and high-risk tool calls are policy-gated.",
          [
            "Memory write protocol:",
            "- Call writeUserImpression only when the user expresses a stable long-term preference, background, identity, or constraint. Do not write short-term task facts as impressions.",
            "- Call writeSkillMemory when the user explicitly asks to save reusable experience, or when you discover a desensitized reusable method. Skill memory must be workspace-scoped and include procedure, appliesWhen, avoidWhen, desensitized=true, and confidence.",
            "- Prefer runtime hooks for routine event memory. Call writeEventMemory only when the current event is unusually important and should be preserved before the normal conversation-window or workspace-exit hook.",
            "- Call writeAgentSelfImpression only for creator-authorized updates to the agent's long-term self-understanding."
          ].join("\n"),
          input.workspace.id === "main"
            ? "Main workspace should choose child workspaces through enterWorkspace and integrate returned WorkspaceResult objects."
            : "When the child workspace task is complete or blocked, call exitWorkspace with a structured WorkspaceResult so main workspace can integrate the result.",
          "这些 runtime/workspace/context/tool 信息只用于内部决策。最终面向用户的回答不得暴露这些内部机制；需要工具时直接 function call，不要向用户说明正在调用工具或切换内部模块。"
        ].join("\n"),
        sortOrder: 30
      },
      {
        segmentType: "workspace",
        title: "内部工作空间契约",
        content: [
          `Workspace: ${input.workspace.id}`,
          `Purpose: ${input.workspace.description}`,
          `Manifest: ${JSON.stringify(input.workspace.manifest, null, 2)}`,
          `Memory policy: ${JSON.stringify(input.workspace.memoryPolicy, null, 2)}`,
          `Instructions: ${input.workspace.instructions}`,
          `Tool instructions: ${input.workspace.toolInstructions}`
        ].join("\n"),
        sortOrder: 40
      },
      {
        segmentType: "workspace_registry",
        title: "可用工作空间清单",
        content: JSON.stringify(visibleWorkspaceRegistry, null, 2),
        sortOrder: 45
      },
      {
        segmentType: "task",
        title: "当前结构化任务包",
        content: JSON.stringify(input.activeSession.task, null, 2),
        sortOrder: 47
      },
      {
        segmentType: "workspace_result",
        title: "已完成工作空间结果",
        content: JSON.stringify(input.workspaceTrace.map((session) => session.result), null, 2),
        sortOrder: 48
      },
      {
        segmentType: "workspace_local_context",
        title: "工作空间局部上下文",
        content: JSON.stringify(input.activeSession.localContext, null, 2),
        sortOrder: 49
      },
      { segmentType: "tools", title: "当前工作空间工具定义", content: input.toolsJson, sortOrder: 50 },
      {
        segmentType: "impression_memory",
        title: "跨工作空间印象记忆",
        content: JSON.stringify({ impressions: partitionedMemory.impressions }, null, 2),
        sortOrder: 60
      },
      {
        segmentType: "event_memory",
        title: "当前工作空间事件记忆",
        content: JSON.stringify({ eventMemories: partitionedMemory.eventMemories }, null, 2),
        sortOrder: 62
      },
      {
        segmentType: "skill_memory",
        title: "当前工作空间经验记忆",
        content: JSON.stringify({ skillMemories: partitionedMemory.skillMemories }, null, 2),
        sortOrder: 64
      },
      {
        segmentType: "history",
        title: "本地对话片段",
        content: JSON.stringify(input.history, null, 2),
        sortOrder: 70
      },
      { segmentType: "user", title: "干净用户消息", content: input.run.message, sortOrder: 80 }
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
    const systemContent = ["system", "personality", "policy", "workspace", "workspace_registry", "tools"]
      .map((key) => byType.get(key as ContextSegment["segmentType"]))
      .filter(Boolean)
      .map((segment) => `## ${segment!.title}\n${segment!.content}`)
      .join("\n\n");

    const taskToolCallId = "runtime_context_task";
    const memoryToolCallId = "runtime_context_memory";
    const historyToolCallId = "runtime_context_history";
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
            id: taskToolCallId,
            type: "function",
            function: {
              name: "runtime_context.task",
              arguments: "{}"
            }
          },
          {
            id: memoryToolCallId,
            type: "function",
            function: {
              name: "runtime_context.load",
              arguments: "{}"
            }
          },
          {
            id: historyToolCallId,
            type: "function",
            function: {
              name: "runtime_context.history",
              arguments: "{}"
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: taskToolCallId,
        name: "runtime_context.task",
        content: JSON.stringify({
          task: byType.get("task")?.content ? JSON.parse(byType.get("task")!.content) : {},
          workspaceResults: byType.get("workspace_result")?.content ? JSON.parse(byType.get("workspace_result")!.content) : [],
          workspaceLocalContext: byType.get("workspace_local_context")?.content ? JSON.parse(byType.get("workspace_local_context")!.content) : {}
        }, null, 2)
      },
      {
        role: "tool",
        tool_call_id: memoryToolCallId,
        name: "runtime_context.load",
        content: JSON.stringify({
          ...(parseSegment("impression_memory", { impressions: [] }) as object),
          ...(parseSegment("event_memory", { eventMemories: [] }) as object),
          ...(parseSegment("skill_memory", { skillMemories: [] }) as object)
        }, null, 2)
      },
      {
        role: "tool",
        tool_call_id: historyToolCallId,
        name: "runtime_context.history",
        content: byType.get("history")?.content ?? "[]"
      },
      {
        role: "user",
        content: userMessage
      }
    ];
  }
}

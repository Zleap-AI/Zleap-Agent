import type { AgentConfig, AgentRunInput, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, ToolDefinition, WorkspaceDefinition, WorkspaceSession } from "../types";
import { AttentionBudget, AttentionBudgetManager, DEFAULT_ATTENTION_BUDGET, estimateTokens } from "./attention-budget";
import { createId } from "./id";

function memoryPartition(memories: MemoryRow[]): { impressions: MemoryRow[]; eventMemories: MemoryRow[]; skillMemories: MemoryRow[] } {
  return {
    impressions: memories.filter((memory) => memory.memoryType === "impression"),
    eventMemories: memories.filter((memory) => memory.memoryType === "event"),
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
    "- 当用户表达稳定的长期偏好、背景、身份或约束时，可以调用 writeUserImpression 写入跨工作空间印象记忆；不要把短期任务事实写成 impression。",
    "- 当用户或 agent 明确要求沉淀可复用经验，或你发现了已经脱敏、可复用的方法时，可以调用 writeSkillMemory；skill 必须属于当前工作空间，并包含 procedure、appliesWhen、avoidWhen、desensitized=true 和 confidence。",
    "- 普通事件优先交给生命周期 hooks 自动沉淀；只有特别重要、需要立即保留的事件才调用 writeEventMemory。",
    "- writeAgentSelfImpression 只用于 creator 授权的 agent 长期自我认识更新。",
    "- memory 工具调用中不要传 userId、agentId、workspaceId、relationId、version 等 scope 字段；这些由 runtime 代码绑定。"
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
    const availableWorkspaces = input.workspace.id === "main"
      ? input.workspaceRegistry.map((workspace) => workspace.manifest)
      : undefined;
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
          runtimeSystemContract({ run: input.run, workspace: input.workspace })
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
            memoryPolicy: input.workspace.memoryPolicy,
            tools: currentTools
          },
          availableWorkspaces
        }, null, 2),
        sortOrder: 20
      },
      {
        segmentType: "memory",
        title: "记忆",
        content: JSON.stringify({
          crossWorkspaceImpressionMemory: partitionedMemory.impressions,
          currentWorkspaceEventMemory: partitionedMemory.eventMemories,
          currentWorkspaceSkillMemory: partitionedMemory.skillMemories
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
          currentWorkspaceEventMemory: [],
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

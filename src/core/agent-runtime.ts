import type { AgentConfig, AgentRunInput, AgentRunOutput, AgentRunPrepared, AgentStreamEvent, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, WorkspaceHandoffContext, WorkspaceResult, WorkspaceSession } from "../types";
import { Repositories } from "../db/repositories";
import { ContextBuilder, PromptAssembler } from "./context-builder";
import { AttentionBudgetManager, estimateTokens } from "./attention-budget";
import { createId, nowIso } from "./id";
import { ChatCompletionOutput, LLMClient, LLMStreamEvent, normalizeChatCompletionsEndpoint, normalizeProviderBaseUrl, OpenAICompatibleClient } from "./llm-client";
import { WorkspaceRuntime } from "./workspace-runtime";
import { MemoryService } from "./memory-service";
import { PolicyEngine } from "./policy-engine";
import { HookManager } from "./hook-manager";
import type { ToolExecutionResult } from "./tool-registry";
import { ToolRegistry } from "./tool-registry";

type LLMToolCall = NonNullable<LLMMessage["tool_calls"]>[number];
type ToolCallAccumulator = Partial<LLMToolCall> & { function: { name: string; arguments: string } };
const DEFAULT_MAX_TOOL_ROUNDS = 100;
const configuredMaxToolRounds = Number.parseInt(process.env.ZLEAP_MAX_TOOL_ROUNDS ?? "", 10);
const MAX_TOOL_ROUNDS = Number.isFinite(configuredMaxToolRounds) && configuredMaxToolRounds > 0
  ? configuredMaxToolRounds
  : DEFAULT_MAX_TOOL_ROUNDS;
const TOOL_LOOP_LIMIT_USER_MESSAGE = "这一步还没有形成稳定的可交付结果。我先暂停在这里；你可以让我继续推进，或者补充更具体的目标。";

function summarizeAssistantMessage(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function summarizeToolResultForChat(content: string, maxLength = 700): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string") {
      text = `失败：${(parsed as { error: string }).error}`;
    } else {
      text = JSON.stringify(parsed, null, 2);
    }
  } catch {
    text = content;
  }
  const normalized = text.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function compactJsonOrText(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function summarizeToolArgumentsForChat(argumentsJson: string, maxLength = 180): string {
  let text = compactJsonOrText(argumentsJson);
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (typeof parsed.command === "string") text = `$ ${parsed.command}`;
    else if (typeof parsed.query === "string") text = parsed.query;
    else if (typeof parsed.path === "string") text = parsed.path;
    else if (typeof parsed.workspaceId === "string") text = parsed.workspaceId;
    else if (typeof parsed.summary === "string") text = parsed.summary;
    else if (typeof parsed.title === "string") text = parsed.title;
  } catch {
    text = argumentsJson;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function extractToolReason(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    return typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolCallForChat(toolCall: LLMToolCall): string {
  const args = summarizeToolArgumentsForChat(toolCall.function.arguments);
  return args ? `${toolCall.function.name} ${args}` : toolCall.function.name;
}

function summarizeToolResultItemForChat(message: LLMMessage, maxLength = 220): string {
  const name = message.name ?? "tool";
  const content = message.content ?? "";
  let text = content;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.error === "string") text = `失败：${parsed.error}`;
    else if (typeof parsed.stdout === "string" && parsed.stdout.trim()) text = parsed.stdout;
    else if (typeof parsed.output === "string" && parsed.output.trim()) text = parsed.output;
    else if (typeof parsed.summary === "string" && parsed.summary.trim()) text = parsed.summary;
    else if (typeof parsed.response === "string" && parsed.response.trim()) text = parsed.response;
    else if (typeof parsed.question === "string" && parsed.question.trim()) text = parsed.question;
    else if (typeof parsed.type === "string") text = parsed.type;
    else text = JSON.stringify(parsed);
  } catch {
    text = content;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const summary = normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
  return summary ? `${name}: ${summary}` : name;
}

function truncateHandoffContent(value: string, maxLength = 1200): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function llmResponseSnapshot(completion: ChatCompletionOutput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(completion.raw && typeof completion.raw === "object" ? completion.raw as Record<string, unknown> : { raw: completion.raw }),
    message: completion.message,
    ...extra
  };
}

export class AgentRuntime {
  private readonly contextBuilder = new ContextBuilder();
  private readonly promptAssembler = new PromptAssembler();
  private readonly attentionBudget = new AttentionBudgetManager();
  private readonly workspaceRuntime: WorkspaceRuntime;
  private readonly memoryService: MemoryService;
  private readonly policy = new PolicyEngine();
  private readonly hookManager: HookManager;
  private readonly toolRegistry: ToolRegistry;

  constructor(
    private readonly repos: Repositories,
    private readonly llmClient: LLMClient = new OpenAICompatibleClient()
  ) {
    this.workspaceRuntime = new WorkspaceRuntime(repos);
    this.memoryService = new MemoryService(repos);
    this.hookManager = new HookManager(repos);
    this.toolRegistry = new ToolRegistry(repos, this.memoryService, this.workspaceRuntime, this.policy);
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const prepared = this.prepare(input);
    let completion: ChatCompletionOutput;
    try {
      completion = await this.llmClient.complete({
        baseUrl: prepared.llm.baseUrl,
        apiKey: prepared.llm.apiKey,
        model: prepared.llm.model,
        messages: prepared.finalMessages,
        tools: prepared.callableTools,
        temperature: prepared.llm.temperature,
        signal: input.abortSignal
      });
      this.repos.markLlmCallCompleted(prepared.llmCallId, llmResponseSnapshot(completion));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repos.markLlmCallFailed(prepared.llmCallId, message);
      throw error;
    }

    const loopResult = await this.runToolLoop(input, prepared, completion);
    completion = loopResult.completion;

    const assistantMessage = completion.message.content ?? "我已经处理了这一步，但没有生成可展示的文字结果。";
    this.commitMainAssistantResponse(prepared, assistantMessage, { source: "directAssistantMessage" });
    this.repos.addMessage(input.conversationId, "assistant", assistantMessage, completion.raw);
    const memoryWrites = [
      ...loopResult.memoryWrites,
      ...this.memoryService.afterAgentTurn({
      run: input,
      activeWorkspaceId: prepared.activeWorkspaceId,
      assistantMessage
      })
    ];
    this.hookManager.record({
      hook: "afterAgentTurn",
      actorId: input.userId,
      actorRole: input.userRole,
      metadata: {
        conversationId: input.conversationId,
        workspaceId: prepared.activeWorkspaceId,
        llmCallId: prepared.llmCallId,
        memoryWriteCount: memoryWrites.length
      }
    });

    return {
      conversationId: prepared.conversationId,
      assistantMessage,
      activeWorkspaceId: prepared.activeWorkspaceId,
      workspaceTrace: prepared.workspaceTrace,
      contextSegments: prepared.contextSegments,
      finalMessages: loopResult.finalMessages,
      memoryWrites
    };
  }

  async *runStream(input: AgentRunInput): AsyncGenerator<AgentStreamEvent> {
    const prepared = this.prepare(input);
    yield {
      type: "start",
      output: {
        conversationId: prepared.conversationId,
        activeWorkspaceId: prepared.activeWorkspaceId,
        workspaceTrace: prepared.workspaceTrace,
        contextSegments: prepared.contextSegments,
        finalMessages: prepared.finalMessages,
        memoryWrites: []
      }
    };

    const streamEvents = this.llmClient.streamEvents?.bind(this.llmClient);
    const stream = this.llmClient.stream?.bind(this.llmClient);
    if (!streamEvents && !stream) {
      const message = "Configured LLM client does not support streaming.";
      this.repos.markLlmCallFailed(prepared.llmCallId, message);
      throw new Error(message);
    }

    let assistantMessage = "";
    if (streamEvents) {
      let currentLlmCallId = prepared.llmCallId;
      let messages = prepared.finalMessages;
      const memoryWrites: MemoryRow[] = [];
      try {
        for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round += 1) {
          let roundText = "";
          const toolCallDeltas = new Map<number, ToolCallAccumulator>();
          for await (const event of streamEvents({
            baseUrl: prepared.llm.baseUrl,
            apiKey: prepared.llm.apiKey,
            model: prepared.llm.model,
            messages,
            tools: prepared.callableTools,
            temperature: prepared.llm.temperature,
            signal: input.abortSignal
          })) {
            if (event.type === "content") roundText += event.text;
            if (event.type === "tool_call_delta") this.mergeToolCallDelta(toolCallDeltas, event);
          }
          const toolCalls = this.materializeToolCalls(toolCallDeltas);
          const activeWorkspaceBeforeTools = prepared.activeWorkspaceId;
          this.repos.markLlmCallCompleted(currentLlmCallId, {
            streamed: true,
            returnedTextLength: roundText.length,
            assistantMessage: roundText,
            toolCallCount: toolCalls.length,
            toolLoopRound: round
          });

          if (toolCalls.length === 0) {
            if (prepared.activeWorkspaceId !== "main") {
              if (roundText.trim()) {
                yield {
                  type: "workspace",
                  workspaceId: prepared.activeWorkspaceId,
                  eventKind: "assistant",
                  title: `${prepared.activeWorkspaceId} 工作空间 LLM`,
                  text: roundText,
                  llmCallId: currentLlmCallId
                };
              }
              const exitRequest = this.requireChildWorkspaceExit(input, prepared, messages, {
                role: "assistant",
                content: roundText || null
              }, { streamed: true, toolLoopRound: round });
              messages = exitRequest.messages;
              currentLlmCallId = exitRequest.llmCallId;
              continue;
            }
            assistantMessage = roundText;
            this.commitMainAssistantResponse(prepared, assistantMessage, { source: "streamedDirectAssistantMessage" });
            if (assistantMessage) yield { type: "delta", text: assistantMessage };
            this.repos.addMessage(input.conversationId, "assistant", assistantMessage, { streamed: true });
            const hookWrites = this.memoryService.afterAgentTurn({
              run: input,
              activeWorkspaceId: prepared.activeWorkspaceId,
              assistantMessage
            });
            this.hookManager.record({
              hook: "afterAgentTurn",
              actorId: input.userId,
              actorRole: input.userRole,
              metadata: {
                conversationId: input.conversationId,
                workspaceId: prepared.activeWorkspaceId,
                llmCallId: currentLlmCallId,
                streamed: true,
                memoryWriteCount: memoryWrites.length + hookWrites.length
              }
            });
            yield {
              type: "done",
              output: {
                conversationId: prepared.conversationId,
                assistantMessage,
              activeWorkspaceId: prepared.activeWorkspaceId,
              workspaceTrace: prepared.workspaceTrace,
              contextSegments: prepared.contextSegments,
              finalMessages: [
                ...messages,
                {
                  role: "assistant",
                  content: assistantMessage
                }
              ],
              memoryWrites: [...memoryWrites, ...hookWrites]
            }
          };
            return;
          }

          if (round > MAX_TOOL_ROUNDS) {
            this.repos.audit(input.userId, "system", "tool_loop_stopped", "conversation", input.conversationId, {
              conversationId: input.conversationId,
              workspaceId: prepared.activeWorkspaceId,
              maxToolRounds: MAX_TOOL_ROUNDS,
              requestedToolCount: toolCalls.length,
              streamed: true
            });
            assistantMessage = TOOL_LOOP_LIMIT_USER_MESSAGE;
            if (prepared.activeWorkspaceId === "main") {
              this.commitMainAssistantResponse(prepared, assistantMessage, { source: "streamedToolLoopLimit", stoppedBy: "maxToolRounds" });
            }
            yield { type: "delta", text: assistantMessage };
            this.repos.addMessage(input.conversationId, "assistant", assistantMessage, { streamed: true, stoppedBy: "maxToolRounds" });
            const hookWrites = this.memoryService.afterAgentTurn({
              run: input,
              activeWorkspaceId: prepared.activeWorkspaceId,
              assistantMessage
            });
            this.hookManager.record({
              hook: "afterAgentTurn",
              actorId: input.userId,
              actorRole: input.userRole,
              metadata: {
                conversationId: input.conversationId,
                workspaceId: prepared.activeWorkspaceId,
                llmCallId: currentLlmCallId,
                streamed: true,
                memoryWriteCount: memoryWrites.length + hookWrites.length,
                stoppedBy: "maxToolRounds"
              }
            });
            yield {
              type: "done",
              output: {
                conversationId: prepared.conversationId,
                assistantMessage,
                activeWorkspaceId: prepared.activeWorkspaceId,
                workspaceTrace: prepared.workspaceTrace,
                contextSegments: prepared.contextSegments,
                finalMessages: messages,
                memoryWrites: [...memoryWrites, ...hookWrites]
              }
            };
            return;
          }

          const assistantToolMessage: LLMMessage = {
            role: "assistant",
            content: roundText || null,
            tool_calls: toolCalls
          };
          if (activeWorkspaceBeforeTools !== "main" && roundText.trim()) {
            yield {
              type: "workspace",
              workspaceId: activeWorkspaceBeforeTools,
              eventKind: "assistant",
              title: `${activeWorkspaceBeforeTools} 工作空间 LLM`,
              text: roundText,
              llmCallId: currentLlmCallId
            };
          }
          if (activeWorkspaceBeforeTools !== "main" && toolCalls.length > 0) {
            const toolCallItems = toolCalls.map((toolCall) => ({
              toolName: toolCall.function.name,
              reason: extractToolReason(toolCall.function.arguments),
              summary: summarizeToolCallForChat(toolCall),
              argumentsJson: toolCall.function.arguments
            }));
            yield {
              type: "workspace",
              workspaceId: activeWorkspaceBeforeTools,
              eventKind: "tool_call",
              title: `${activeWorkspaceBeforeTools} 工具调用`,
              text: toolCallItems.map((item) => item.summary).join("\n"),
              llmCallId: currentLlmCallId,
              toolNames: toolCalls.map((toolCall) => toolCall.function.name),
              items: toolCallItems
            };
          }
          const toolExecution = await this.executeToolCalls(input, prepared, toolCalls);
          memoryWrites.push(...toolExecution.memoryWrites);
          if (activeWorkspaceBeforeTools !== "main" && toolExecution.toolMessages.length > 0) {
            const toolResultItems = toolExecution.toolMessages.map((message) => ({
              toolName: message.name ?? "tool",
              reason: extractToolReason(toolCalls.find((toolCall) => toolCall.id === message.tool_call_id)?.function.arguments ?? ""),
              summary: summarizeToolResultItemForChat(message),
              resultJson: message.content ?? ""
            }));
            yield {
              type: "workspace",
              workspaceId: activeWorkspaceBeforeTools,
              eventKind: "tool_result",
              title: `${activeWorkspaceBeforeTools} 工具结果`,
              text: toolResultItems.map((item) => item.summary).join("\n"),
              llmCallId: currentLlmCallId,
              toolNames: toolExecution.toolMessages.map((message) => message.name ?? "tool"),
              items: toolResultItems
            };
          }
          const transition = this.applyWorkspaceTransition(input, prepared, toolExecution.enteredWorkspaceSession, assistantToolMessage, toolExecution.toolMessages)
            ?? this.applyWorkspaceExitTransition(input, prepared, toolExecution.exitedWorkspaceSession, assistantToolMessage, toolExecution.toolMessages);
          if (toolExecution.enteredWorkspaceSession) {
            yield {
              type: "workspace",
              workspaceId: toolExecution.enteredWorkspaceSession.workspaceId,
              eventKind: "entered",
              title: `进入 ${toolExecution.enteredWorkspaceSession.workspaceId} 工作空间`,
              text: toolExecution.enteredWorkspaceSession.objective,
              llmCallId: transition?.llmCallId ?? currentLlmCallId,
              status: toolExecution.enteredWorkspaceSession.status
            };
          }
          if (toolExecution.exitedWorkspaceSession) {
            yield {
              type: "workspace",
              workspaceId: toolExecution.exitedWorkspaceSession.workspaceId,
              eventKind: "exit",
              title: `${toolExecution.exitedWorkspaceSession.workspaceId} 工作空间返回 main`,
              text: toolExecution.exitedWorkspaceSession.summary,
              llmCallId: transition?.llmCallId ?? currentLlmCallId,
              status: toolExecution.exitedWorkspaceSession.status
            };
          }
          messages = transition?.messages ?? [...messages, assistantToolMessage, ...toolExecution.toolMessages];
          if (toolExecution.terminalAssistantMessage) {
            assistantMessage = toolExecution.terminalAssistantMessage;
            yield { type: "delta", text: assistantMessage };
            this.repos.addMessage(input.conversationId, "assistant", assistantMessage, { streamed: true, terminalToolResult: true });
            const hookWrites = this.memoryService.afterAgentTurn({
              run: input,
              activeWorkspaceId: prepared.activeWorkspaceId,
              assistantMessage
            });
            this.hookManager.record({
              hook: "afterAgentTurn",
              actorId: input.userId,
              actorRole: input.userRole,
              metadata: {
                conversationId: input.conversationId,
                workspaceId: prepared.activeWorkspaceId,
                llmCallId: currentLlmCallId,
                streamed: true,
                terminalToolResult: true,
                memoryWriteCount: memoryWrites.length + hookWrites.length
              }
            });
            yield {
              type: "done",
              output: {
                conversationId: prepared.conversationId,
                assistantMessage,
                activeWorkspaceId: prepared.activeWorkspaceId,
                workspaceTrace: prepared.workspaceTrace,
                contextSegments: prepared.contextSegments,
                finalMessages: messages,
                memoryWrites: [...memoryWrites, ...hookWrites]
              }
            };
            return;
          }
          currentLlmCallId = transition?.llmCallId ?? this.saveFollowUpLlmCall(input, prepared, messages, toolExecution.toolMessages);
        }
        if (prepared.activeWorkspaceId !== "main") {
          this.repos.audit(input.userId, "system", "workspace_exit_missing", "conversation", input.conversationId, {
            conversationId: input.conversationId,
            workspaceId: prepared.activeWorkspaceId,
            maxToolRounds: MAX_TOOL_ROUNDS,
            streamed: true
          });
          assistantMessage = "当前步骤还没有形成可靠的可交付结果。请确认是否继续推进，或补充下一步要求。";
          yield { type: "delta", text: assistantMessage };
          this.repos.addMessage(input.conversationId, "assistant", assistantMessage, { streamed: true, stoppedBy: "missingWorkspaceExit" });
          const hookWrites = this.memoryService.afterAgentTurn({
            run: input,
            activeWorkspaceId: prepared.activeWorkspaceId,
            assistantMessage
          });
          this.hookManager.record({
            hook: "afterAgentTurn",
            actorId: input.userId,
            actorRole: input.userRole,
            metadata: {
              conversationId: input.conversationId,
              workspaceId: prepared.activeWorkspaceId,
              llmCallId: currentLlmCallId,
              streamed: true,
              memoryWriteCount: memoryWrites.length + hookWrites.length,
              stoppedBy: "missingWorkspaceExit"
            }
          });
          yield {
            type: "done",
            output: {
              conversationId: prepared.conversationId,
              assistantMessage,
              activeWorkspaceId: prepared.activeWorkspaceId,
              workspaceTrace: prepared.workspaceTrace,
              contextSegments: prepared.contextSegments,
              finalMessages: [
                ...messages,
                {
                  role: "assistant",
                  content: assistantMessage
                }
              ],
              memoryWrites: [...memoryWrites, ...hookWrites]
            }
          };
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repos.markLlmCallFailed(currentLlmCallId, message);
        throw error;
      }
    } else if (stream) {
      try {
        for await (const chunk of stream({
          baseUrl: prepared.llm.baseUrl,
          apiKey: prepared.llm.apiKey,
          model: prepared.llm.model,
          messages: prepared.finalMessages,
          tools: prepared.callableTools,
          temperature: prepared.llm.temperature,
          signal: input.abortSignal
        })) {
          assistantMessage += chunk;
          yield { type: "delta", text: chunk };
        }
        this.repos.markLlmCallCompleted(prepared.llmCallId, {
          streamed: true,
          returnedTextLength: assistantMessage.length,
          assistantMessage
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repos.markLlmCallFailed(prepared.llmCallId, message);
        throw error;
      }
    }

    this.commitMainAssistantResponse(prepared, assistantMessage, { source: "chunkStreamAssistantMessage" });
    this.repos.addMessage(input.conversationId, "assistant", assistantMessage, { streamed: true });
    const memoryWrites = this.memoryService.afterAgentTurn({
      run: input,
      activeWorkspaceId: prepared.activeWorkspaceId,
      assistantMessage
    });
    this.hookManager.record({
      hook: "afterAgentTurn",
      actorId: input.userId,
      actorRole: input.userRole,
      metadata: {
        conversationId: input.conversationId,
        workspaceId: prepared.activeWorkspaceId,
        llmCallId: prepared.llmCallId,
        streamed: true,
        memoryWriteCount: memoryWrites.length
      }
    });
    yield {
      type: "done",
      output: {
        conversationId: prepared.conversationId,
        assistantMessage,
        activeWorkspaceId: prepared.activeWorkspaceId,
        workspaceTrace: prepared.workspaceTrace,
        contextSegments: prepared.contextSegments,
        finalMessages: prepared.finalMessages,
        memoryWrites
      }
    };
  }

  private prepare(input: AgentRunInput): AgentRunPrepared {
    const agent = this.repos.getAgent(input.agentId);
    const baseUrl = normalizeProviderBaseUrl(input.llm?.baseUrl || process.env.ZLEAP_LLM_API_URL || agent.defaultBaseUrl);
    const apiKey = input.llm?.apiKey || process.env.ZLEAP_LLM_API_KEY;
    const model = input.llm?.model || process.env.ZLEAP_LLM_MODEL || agent.defaultModel;
    if (!apiKey) throw new Error("Missing LLM API key. Set ZLEAP_LLM_API_KEY or provide apiKey for this server session.");

    this.repos.ensureConversation(input.conversationId, input.agentId, input.userId);
    const resumableSession = this.findResumableWorkspaceSession(input);
    this.hookManager.record({
      hook: "beforeAgentTurn",
      actorId: input.userId,
      actorRole: input.userRole,
      metadata: {
        conversationId: input.conversationId,
        agentId: input.agentId,
        model,
        hasApiKey: Boolean(apiKey),
        resumedWorkspaceId: resumableSession?.workspaceId,
        resumedWorkspaceSessionId: resumableSession?.id
      }
    });
    this.repos.addMessage(input.conversationId, "user", input.message);

    if (resumableSession) {
      const activeSession = this.resumeWorkspaceSession(input, resumableSession);
      const priorSessions = this.repos
        .listWorkspaceSessions(input.conversationId, input.userId)
        .map((session) => session.id === activeSession.id ? activeSession : session);
      const workspaceTrace = priorSessions.some((session) => session.id === activeSession.id)
        ? priorSessions
        : [...priorSessions, activeSession];
      const llmCallId = createId("llm");
      const context = this.buildLlmContext({
        input,
        agent,
        llmCallId,
        llmBaseUrl: baseUrl,
        llmModel: model,
        workspaceId: activeSession.workspaceId,
        activeSession,
        workspaceTrace
      });
      this.repos.saveLlmCall(context.snapshot, context.contextSegments);

      return {
        conversationId: input.conversationId,
        activeWorkspaceId: activeSession.workspaceId,
        workspaceTrace,
        contextSegments: context.contextSegments,
        finalMessages: context.messages,
        memoryWrites: [],
        llmCallId,
        callableTools: context.callableTools,
        llm: {
          baseUrl,
          apiKey,
          model,
          temperature: input.llm?.temperature
        }
      };
    }

    const mainSession = this.workspaceRuntime.run({ run: input, workspaceId: "main", objective: "Plan the user request and choose a workspace." });
    const workspaceTrace = [mainSession];
    const llmCallId = createId("llm");
    const context = this.buildLlmContext({
      input,
      agent,
      llmCallId,
      llmBaseUrl: baseUrl,
      llmModel: model,
      workspaceId: "main",
      activeSession: mainSession,
      workspaceTrace
    });
    this.repos.saveLlmCall(context.snapshot, context.contextSegments);

    return {
      conversationId: input.conversationId,
      activeWorkspaceId: "main",
      workspaceTrace,
      contextSegments: context.contextSegments,
      finalMessages: context.messages,
      memoryWrites: [],
      llmCallId,
      callableTools: context.callableTools,
      llm: {
        baseUrl,
        apiKey,
        model,
        temperature: input.llm?.temperature
      }
    };
  }

  private findResumableWorkspaceSession(input: AgentRunInput): WorkspaceSession | undefined {
    return [...this.repos.listWorkspaceSessions(input.conversationId, input.userId)]
      .reverse()
      .find((session) => session.workspaceId !== "main" && this.isResumableWorkspaceStatus(session.status));
  }

  private isResumableWorkspaceStatus(status: WorkspaceSession["status"]): boolean {
    return status === "running"
      || status === "failed"
      || status === "blocked"
      || status === "needs_user_input"
      || status === "needs_approval";
  }

  private resumeWorkspaceSession(input: AgentRunInput, session: WorkspaceSession): WorkspaceSession {
    const next: WorkspaceSession = {
      ...session,
      status: "running",
      completedAt: undefined,
      summary: session.summary || `继续 ${session.workspaceId} 工作空间任务。`,
      result: {
        ...session.result,
        status: "running",
        summary: session.result.summary || session.summary || `继续 ${session.workspaceId} 工作空间任务。`
      },
      task: {
        ...session.task,
        relevantUserRequest: input.message
      },
      localContext: {
        ...session.localContext,
        parentContextSummary: `用户在 ${session.workspaceId} 工作空间中断或失败后继续输入：${truncateHandoffContent(input.message, 500)}`
      }
    };
    const observation = `用户继续了 ${session.workspaceId} 工作空间中的未完成任务。`;
    if (!next.observations.includes(observation)) next.observations = [...next.observations, observation];
    if (!next.result.observations.includes(observation)) next.result = {
      ...next.result,
      observations: [...next.result.observations, observation]
    };
    this.repos.updateWorkspaceSessionLocalContext(next);
    this.repos.audit(input.userId, "system", "workspace_session_resumed", "workspace_session", session.id, {
      conversationId: input.conversationId,
      workspaceId: session.workspaceId,
      taskId: session.taskId,
      previousStatus: session.status,
      userMessage: input.message
    });
    return next;
  }

  private buildLlmContext(input: {
    input: AgentRunInput;
    agent: AgentConfig;
    llmCallId: string;
    llmBaseUrl: string;
    llmModel: string;
    workspaceId: string;
    activeSession: WorkspaceSession;
    workspaceTrace: WorkspaceSession[];
    assistantToolMessage?: LLMMessage;
    toolMessages?: LLMMessage[];
  }): {
    callableTools: AgentRunPrepared["callableTools"];
    contextSegments: ContextSegment[];
    messages: LLMMessage[];
    snapshot: LLMCallSnapshot;
  } {
    const workspace = this.repos.getWorkspace(input.workspaceId);
    const workspaceRegistry = this.repos.listWorkspaces();
    const memories = [
      ...input.activeSession.localContext.recalledImpressions,
      ...input.activeSession.localContext.recalledEventMemories,
      ...input.activeSession.localContext.recalledSkillMemories
    ];
    const history = this.selectLocalHistory(input.input.conversationId, input.workspaceId, input.input.userId, input.input.userRole);
    const callableTools = this.toolRegistry.getCallableTools(input.workspaceId);
    const toolsJson = JSON.stringify(callableTools, null, 2);
    const baseSegments = this.contextBuilder.build({
      llmCallId: input.llmCallId,
      conversationId: input.input.conversationId,
      agent: input.agent,
      run: input.input,
      workspace,
      workspaceRegistry,
      activeSession: input.activeSession,
      workspaceTrace: input.workspaceTrace,
      memories,
      history,
      toolsJson
    });
    const baseMessages = this.promptAssembler.assemble(baseSegments, input.input.message);
    const messages = input.assistantToolMessage && input.toolMessages?.length
      ? [...baseMessages, input.assistantToolMessage, ...input.toolMessages]
      : baseMessages;
    const segments = [...baseSegments];
    if (input.toolMessages?.length) {
      const toolResultContent = this.attentionBudget.fitSegment("tool_result", JSON.stringify(input.toolMessages, null, 2));
      segments.push({
        id: createId("ctx"),
        llmCallId: input.llmCallId,
        conversationId: input.input.conversationId,
        segmentType: "tool_result",
        title: "Tool Results For Follow-up LLM Call",
        content: toolResultContent,
        tokenEstimate: estimateTokens(toolResultContent),
        sortOrder: 75
      });
    }
    const finalMessagesContent = JSON.stringify(messages, null, 2);
    segments.push({
      id: createId("ctx"),
      llmCallId: input.llmCallId,
      conversationId: input.input.conversationId,
      segmentType: "final_messages",
      title: "Final LLM Messages",
      content: finalMessagesContent,
      tokenEstimate: estimateTokens(finalMessagesContent),
      sortOrder: 90
    });
    const snapshot: LLMCallSnapshot = {
      id: input.llmCallId,
      conversationId: input.input.conversationId,
      userId: input.input.userId,
      providerBaseUrl: normalizeProviderBaseUrl(input.llmBaseUrl),
      normalizedEndpoint: normalizeChatCompletionsEndpoint(input.llmBaseUrl),
      model: input.llmModel,
      messagesJson: JSON.stringify(messages),
      toolsJson,
      status: "pending",
      responseJson: "{}",
      createdAt: nowIso()
    };
    return {
      callableTools,
      contextSegments: segments,
      messages,
      snapshot
    };
  }

  private mergeToolCallDelta(target: Map<number, ToolCallAccumulator>, event: Extract<LLMStreamEvent, { type: "tool_call_delta" }>): void {
    const current = target.get(event.index) ?? {
      id: event.id ?? `call_${event.index}`,
      type: "function" as const,
      function: { name: "", arguments: "" }
    };
    if (event.id) current.id = event.id;
    current.type = "function";
    if (event.name) current.function.name += event.name;
    if (event.arguments) current.function.arguments += event.arguments;
    target.set(event.index, current);
  }

  private materializeToolCalls(target: Map<number, ToolCallAccumulator>): LLMToolCall[] {
    return [...target.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, value]) => ({
        id: value.id ?? `call_${index}`,
        type: "function" as const,
        function: {
          name: value.function.name,
          arguments: value.function.arguments || "{}"
        }
      }))
      .filter((toolCall) => toolCall.function.name);
  }

  private selectLocalHistory(conversationId: string, workspaceId: string, userId: string, userRole: AgentRunInput["userRole"]): Array<{ role: string; content: string }> {
    if (workspaceId === "main") return this.repos.listMessages(conversationId, 20).map((message) => ({
      role: message.role,
      content: message.content
    }));

    const trace = this.repos.getTrace(conversationId, userId, userRole);
    const localToolNames = this.localWorkspaceToolNames(workspaceId);
    const localToolCallNames = (toolCalls: LLMToolCall[] | undefined): string[] => (toolCalls ?? [])
      .map((toolCall) => toolCall.function.name)
      .filter((toolName) => localToolNames.has(toolName));
    const workspaceCallIds = new Set(
      trace.contextSegments
        .filter((segment) => segment.segmentType === "workspace")
        .filter((segment) => {
          const payload = parseJsonValue<{ currentWorkspace?: { id?: string } }>(segment.content, {});
          return payload.currentWorkspace?.id === workspaceId;
        })
        .map((segment) => segment.llmCallId)
    );
    const localMessages: Array<{ role: string; content: string }> = [];
    for (const call of [...trace.llmCalls].reverse().filter((item) => workspaceCallIds.has(item.id))) {
      const payload = parseJsonValue<{ message?: LLMMessage; assistantMessage?: string }>(call.responseJson, {});
      const message = payload.message;
      if (payload.assistantMessage?.trim()) {
        localMessages.push({ role: "assistant", content: payload.assistantMessage });
      }
      if (message?.content?.trim()) {
        localMessages.push({ role: "assistant", content: message.content });
      }
      if (message?.tool_calls?.length) {
        const toolNames = localToolCallNames(message.tool_calls);
        if (toolNames.length > 0) {
          localMessages.push({
            role: "assistant",
            content: `调用工具：${toolNames.join(", ")}`
          });
        }
      }
    }
    for (const segment of trace.contextSegments.filter((item) => item.segmentType === "final_messages" && workspaceCallIds.has(item.llmCallId))) {
      const messages = parseJsonValue<LLMMessage[]>(segment.content, []);
      for (const message of messages) {
        if (message.role === "assistant" && message.content?.trim()) {
          localMessages.push({ role: "assistant", content: message.content });
        }
        if (message.role === "assistant" && message.tool_calls?.length) {
          const toolNames = localToolCallNames(message.tool_calls);
          if (toolNames.length > 0) {
            localMessages.push({
              role: "assistant",
              content: `调用工具：${toolNames.join(", ")}`
            });
          }
        }
        if (message.role === "tool" && message.name && localToolNames.has(message.name)) {
          localMessages.push({
            role: "tool",
            content: `${message.name}: ${summarizeToolResultForChat(message.content ?? "", 500)}`
          });
        }
      }
    }
    return localMessages.slice(-20);
  }

  private localWorkspaceToolNames(workspaceId: string): Set<string> {
    return new Set(this.toolRegistry.getCallableTools(workspaceId).map((tool) => tool.name));
  }

  private createParentToChildHandoff(input: AgentRunInput, prepared: AgentRunPrepared, session: WorkspaceSession, _toolMessages: LLMMessage[]): WorkspaceHandoffContext {
    const recentUserMessages = this.repos.listMessages(input.conversationId, 30)
      .filter((message) => message.role === "user" && message.content.trim().length > 0);
    if (recentUserMessages.length > 0 && recentUserMessages[recentUserMessages.length - 1].content.trim() === input.message.trim()) {
      recentUserMessages.pop();
    }
    const referenceMessages = recentUserMessages.slice(-6).map((message, index) => ({
      kind: "message" as const,
      role: "user",
      title: `用户原话参考 ${index + 1}`,
      content: truncateHandoffContent(message.content, 700),
      workspaceId: prepared.activeWorkspaceId
    }));
    const currentMessage = {
      kind: "message" as const,
      role: "user",
      title: "当前用户请求",
      content: truncateHandoffContent(input.message, 900),
      workspaceId: prepared.activeWorkspaceId
    };
    const taskItem = {
      kind: "message" as const,
      role: "system",
      title: "总体要求与工作空间入口任务",
      content: truncateHandoffContent(JSON.stringify({
        objective: session.task.objective,
        constraints: session.task.constraints,
        expectedOutput: session.task.expectedOutput,
        parentContextSummary: session.task.parentContextSummary
      }, null, 2), 1200),
      workspaceId: session.workspaceId
    };
    return {
      id: createId("handoff"),
      direction: "parent_to_child",
      fromWorkspaceId: prepared.activeWorkspaceId,
      toWorkspaceId: session.workspaceId,
      reason: "workspace_enter",
      createdAt: nowIso(),
      items: [taskItem, ...referenceMessages, currentMessage]
    };
  }

  private createChildToMainHandoff(input: AgentRunInput, session: WorkspaceSession, toolMessages: LLMMessage[]): WorkspaceHandoffContext {
    const tailItems = this.selectWorkspaceRawTail(input.conversationId, session.workspaceId, input.userId, input.userRole, 10);
    const resultItem = {
      kind: "workspace_result" as const,
      title: `${session.workspaceId} WorkspaceResult`,
      content: JSON.stringify(session.result, null, 2),
      workspaceId: session.workspaceId
    };
    const exitToolResultItems = toolMessages
      .filter((message) => message.name === "exitWorkspace")
      .map((message) => ({
        kind: "tool_result" as const,
        role: "tool",
        title: "退出工作空间结果",
        content: truncateHandoffContent(message.content ?? "", 1200),
        workspaceId: session.workspaceId,
        toolName: message.name
      }));
    const toolEvidence = session.localContext.recentToolCalls.slice(0, 8).map((toolCall) => ({
      kind: "tool_evidence" as const,
      title: `子工作空间工具结果 ${toolCall.toolName}`,
      content: truncateHandoffContent(JSON.stringify({
        result: parseJsonValue(toolCall.resultJson, toolCall.resultJson),
        status: toolCall.status
      }), 1600),
      workspaceId: session.workspaceId,
      toolName: toolCall.toolName
    }));
    return {
      id: createId("handoff"),
      direction: "child_to_parent",
      fromWorkspaceId: session.workspaceId,
      toWorkspaceId: "main",
      reason: "workspace_exit",
      createdAt: nowIso(),
      items: [resultItem, ...tailItems, ...exitToolResultItems, ...toolEvidence].slice(-14)
    };
  }

  private selectWorkspaceRawTail(conversationId: string, workspaceId: string, userId: string, userRole: AgentRunInput["userRole"], limit: number): WorkspaceHandoffContext["items"] {
    const trace = this.repos.getTrace(conversationId, userId, userRole);
    const localToolNames = this.localWorkspaceToolNames(workspaceId);
    const workspaceCallIds = new Set(
      trace.contextSegments
        .filter((segment) => segment.segmentType === "workspace")
        .filter((segment) => {
          const payload = parseJsonValue<{ currentWorkspace?: { id?: string } }>(segment.content, {});
          return payload.currentWorkspace?.id === workspaceId;
        })
        .map((segment) => segment.llmCallId)
    );
    const items: WorkspaceHandoffContext["items"] = [];
    for (const segment of trace.contextSegments.filter((item) => item.segmentType === "final_messages" && workspaceCallIds.has(item.llmCallId))) {
      const messages = parseJsonValue<LLMMessage[]>(segment.content, []);
      for (const message of messages) {
        if (message.role === "system") continue;
        if (message.name?.startsWith("runtime_context.")) continue;
        if (message.role === "assistant" && message.content?.trim()) {
          items.push({
            kind: "message",
            role: "assistant",
            title: `${workspaceId} 助手上下文`,
            content: truncateHandoffContent(message.content, 1200),
            workspaceId,
            llmCallId: segment.llmCallId
          });
        }
        if (message.role === "tool" && message.name && localToolNames.has(message.name)) {
          items.push({
            kind: "tool_result",
            role: "tool",
            title: `${workspaceId} 工具结果 ${message.name}`,
            content: truncateHandoffContent(message.content ?? "", 1600),
            workspaceId,
            llmCallId: segment.llmCallId,
            toolName: message.name
          });
        }
      }
    }
    return items.slice(-limit);
  }

  private async executeToolCalls(input: AgentRunInput, prepared: AgentRunPrepared, toolCalls: LLMToolCall[]): Promise<{ toolMessages: LLMMessage[]; memoryWrites: MemoryRow[]; enteredWorkspaceSession?: WorkspaceSession; exitedWorkspaceSession?: WorkspaceSession; terminalAssistantMessage?: string }> {
    const memoryWrites: MemoryRow[] = [];
    const toolMessages: LLMMessage[] = [];
    let enteredWorkspaceSession: WorkspaceSession | undefined;
    let exitedWorkspaceSession: WorkspaceSession | undefined;
    let terminalAssistantMessage: string | undefined;
    let workspaceExitedInBatch = false;
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const activeSession = this.findActiveWorkspaceSession(prepared);
      let justExitedWorkspaceSession: WorkspaceSession | undefined;
      const rejectAfterExit = workspaceExitedInBatch && prepared.activeWorkspaceId !== "main";
      this.hookManager.record({
        hook: "beforeToolCall",
        actorId: input.userId,
        actorRole: input.userRole,
        resourceKind: "tool",
        metadata: {
          conversationId: input.conversationId,
          workspaceId: prepared.activeWorkspaceId,
          workspaceSessionId: activeSession?.id,
          taskId: activeSession?.taskId,
          toolName
        }
      });
      const result: ToolExecutionResult = rejectAfterExit
        ? {
          ok: false,
          status: "failed",
          result: {
            error: "The active child workspace already exited earlier in this assistant tool-call batch. Later same-batch child tool calls are rejected and not executed.",
            toolName,
            workspaceId: prepared.activeWorkspaceId,
            workspaceSessionId: activeSession?.id ?? null,
            taskId: activeSession?.taskId ?? null
          }
        }
        : await this.toolRegistry.execute({
          run: input,
          activeWorkspaceId: prepared.activeWorkspaceId,
          activeWorkspaceSession: activeSession,
          callableTools: prepared.callableTools,
          toolName,
          argumentsJson: toolCall.function.arguments
        });
      if (result.memory) memoryWrites.push(result.memory);
      if (result.workspaceSession) enteredWorkspaceSession = result.workspaceSession;
      if (result.exitedWorkspaceResult) {
        justExitedWorkspaceSession = this.applyExitWorkspaceResult(prepared, result.exitedWorkspaceResult);
        exitedWorkspaceSession = justExitedWorkspaceSession;
      }
      if (result.mainWorkspaceResult) {
        this.applyMainWorkspaceResult(prepared, result.mainWorkspaceResult);
      }
      if (result.terminalAssistantMessage) {
        terminalAssistantMessage = result.terminalAssistantMessage;
      }
      const savedToolCall = this.repos.saveToolCall({
        conversationId: input.conversationId,
        userId: input.userId,
        workspaceId: prepared.activeWorkspaceId,
        workspaceSessionId: activeSession?.id,
        taskId: activeSession?.taskId,
        toolName,
        argumentsJson: toolCall.function.arguments,
        resultJson: JSON.stringify(result.result),
        status: result.status
      });
      if (!rejectAfterExit) this.recordToolCallInActiveWorkspaceSession(prepared, savedToolCall);
      this.hookManager.record({
        hook: "afterToolCall",
        actorId: input.userId,
        actorRole: input.userRole,
        resourceKind: "tool",
        resourceId: savedToolCall.id,
        metadata: {
          conversationId: input.conversationId,
          workspaceId: prepared.activeWorkspaceId,
          workspaceSessionId: activeSession?.id,
          taskId: activeSession?.taskId,
          toolCallId: savedToolCall.id,
          toolName,
          status: result.status
        }
      });
      if (justExitedWorkspaceSession) {
        memoryWrites.push(...this.memoryService.afterWorkspaceExit({
          run: input,
          session: justExitedWorkspaceSession
        }));
        workspaceExitedInBatch = true;
      }
      toolMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: JSON.stringify(result.result)
      });
    }
    return { toolMessages, memoryWrites, enteredWorkspaceSession, exitedWorkspaceSession, terminalAssistantMessage };
  }

  private findActiveWorkspaceSession(prepared: AgentRunPrepared): WorkspaceSession | undefined {
    return [...prepared.workspaceTrace].reverse().find((item) => item.workspaceId === prepared.activeWorkspaceId);
  }

  private recordToolCallInActiveWorkspaceSession(prepared: AgentRunPrepared, toolCall: ReturnType<Repositories["saveToolCall"]>): void {
    const session = this.findActiveWorkspaceSession(prepared);
    if (!session) return;
    session.localContext.recentToolCalls = [
      toolCall,
      ...session.localContext.recentToolCalls.filter((item) => item.id !== toolCall.id)
    ].slice(0, 12);
    const observation = `Tool ${toolCall.toolName} finished with status ${toolCall.status}.`;
    if (!session.observations.includes(observation)) session.observations.push(observation);
    if (!session.result.observations.includes(observation)) session.result.observations.push(observation);
    this.repos.updateWorkspaceSessionLocalContext(session);
  }

  private applyExitWorkspaceResult(prepared: AgentRunPrepared, result: Partial<WorkspaceResult>): WorkspaceSession | undefined {
    if (prepared.activeWorkspaceId === "main") return undefined;
    const session = [...prepared.workspaceTrace].reverse().find((item) => item.workspaceId === prepared.activeWorkspaceId);
    if (!session) return undefined;
    this.repos.audit(session.userId, "system", "hook.beforeWorkspaceExit", "workspace", session.workspaceId, {
      hook: "beforeWorkspaceExit",
      conversationId: session.conversationId,
      workspaceId: session.workspaceId,
      taskId: session.taskId
    });
    const nextResult: WorkspaceResult = {
      taskId: session.taskId,
      workspaceId: session.workspaceId,
      status: result.status ?? session.result.status,
      summary: result.summary ?? session.result.summary,
      artifacts: result.artifacts ?? session.result.artifacts,
      observations: result.observations ?? session.result.observations,
      errors: result.errors ?? session.result.errors,
      suggestedNextSteps: result.suggestedNextSteps ?? session.result.suggestedNextSteps
    };
    session.status = nextResult.status;
    session.summary = nextResult.summary;
    session.result = nextResult;
    session.observations = nextResult.observations;
    session.errors = nextResult.errors;
    session.completedAt = nowIso();
    this.repos.updateWorkspaceSessionLocalContext(session);
    this.repos.audit(session.userId, "system", "hook.afterWorkspaceExit", "workspace_session", session.id, {
      hook: "afterWorkspaceExit",
      conversationId: session.conversationId,
      workspaceId: session.workspaceId,
      taskId: session.taskId,
      status: session.status
    });
    return session;
  }

  private applyMainWorkspaceResult(prepared: AgentRunPrepared, result: Partial<WorkspaceResult>): WorkspaceSession | undefined {
    const session = prepared.workspaceTrace.find((item) => item.workspaceId === "main");
    if (!session) return undefined;
    const nextResult: WorkspaceResult = {
      taskId: session.taskId,
      workspaceId: "main",
      status: result.status ?? session.result.status,
      summary: result.summary ?? session.result.summary,
      artifacts: result.artifacts ?? session.result.artifacts,
      observations: result.observations ?? session.result.observations,
      errors: result.errors ?? session.result.errors,
      suggestedNextSteps: result.suggestedNextSteps ?? session.result.suggestedNextSteps
    };
    session.status = nextResult.status;
    session.summary = nextResult.summary;
    session.result = nextResult;
    session.observations = nextResult.observations;
    session.errors = nextResult.errors;
    session.completedAt = nowIso();
    this.repos.updateWorkspaceSessionLocalContext(session);
    this.repos.audit(session.userId, "system", "main_workspace_result_committed", "workspace_session", session.id, {
      conversationId: session.conversationId,
      workspaceId: "main",
      taskId: session.taskId,
      status: session.status
    });
    return session;
  }

  private commitMainAssistantResponse(prepared: AgentRunPrepared, assistantMessage: string, metadata: Record<string, unknown> = {}): WorkspaceSession | undefined {
    if (prepared.activeWorkspaceId !== "main") return undefined;
    const session = prepared.workspaceTrace.find((item) => item.workspaceId === "main");
    if (!session || session.status !== "running") return undefined;
    const committed = this.applyMainWorkspaceResult(prepared, {
      status: "completed",
      summary: summarizeAssistantMessage(assistantMessage) || "Main workspace produced a final user-facing response.",
      observations: [
        ...session.result.observations,
        "Main workspace produced a final user-facing response."
      ],
      suggestedNextSteps: []
    });
    if (committed) {
      this.repos.audit(session.userId, "system", "main_workspace_direct_response_committed", "workspace_session", session.id, {
        conversationId: session.conversationId,
        workspaceId: "main",
        taskId: session.taskId,
        status: committed.status,
        assistantTextLength: assistantMessage.length,
        ...metadata
      });
    }
    return committed;
  }

  private applyWorkspaceTransition(
    input: AgentRunInput,
    prepared: AgentRunPrepared,
    session: WorkspaceSession | undefined,
    assistantToolMessage: LLMMessage,
    toolMessages: LLMMessage[]
  ): { llmCallId: string; messages: LLMMessage[] } | undefined {
    if (!session || session.workspaceId === prepared.activeWorkspaceId) return undefined;
    const agent = this.repos.getAgent(input.agentId);
    const llmCallId = createId("llm");
    const workspaceTrace = [...prepared.workspaceTrace, session];
    session.task.parentContextSummary = `从 ${prepared.activeWorkspaceId} 进入 ${session.workspaceId}，runtime 携带总体要求、当前用户请求和少量用户原话参考；这些只是交接参考，不是当前子 workspace 的本地对话，也不包含父 workspace 工具协议、assistant 执行记录或 sibling workspace 记录。`;
    session.localContext.parentContextSummary = session.task.parentContextSummary;
    const handoffContext = this.createParentToChildHandoff(input, prepared, session, toolMessages);
    session.localContext.handoffContext = [
      handoffContext,
      ...(session.localContext.handoffContext ?? [])
    ].slice(0, 6);
    this.repos.updateWorkspaceSessionLocalContext(session);
    const context = this.buildLlmContext({
      input,
      agent,
      llmCallId,
      llmBaseUrl: prepared.llm.baseUrl,
      llmModel: prepared.llm.model,
      workspaceId: session.workspaceId,
      activeSession: session,
      workspaceTrace,
      assistantToolMessage,
      toolMessages
    });
    const fromWorkspaceId = prepared.activeWorkspaceId;
    prepared.activeWorkspaceId = session.workspaceId;
    prepared.workspaceTrace = workspaceTrace;
    prepared.contextSegments = context.contextSegments;
    prepared.finalMessages = context.messages;
    prepared.callableTools = context.callableTools;
    this.repos.saveLlmCall(context.snapshot, context.contextSegments);
    this.repos.audit(input.userId, "system", "workspace_transition", "workspace_session", session.id, {
      conversationId: input.conversationId,
      workspaceId: session.workspaceId,
      fromWorkspaceId,
      taskId: session.taskId,
      llmCallId
    });
    return { llmCallId, messages: context.messages };
  }

  private applyWorkspaceExitTransition(
    input: AgentRunInput,
    prepared: AgentRunPrepared,
    session: WorkspaceSession | undefined,
    assistantToolMessage: LLMMessage,
    toolMessages: LLMMessage[]
  ): { llmCallId: string; messages: LLMMessage[] } | undefined {
    if (!session || prepared.activeWorkspaceId === "main") return undefined;
    const mainSession = prepared.workspaceTrace.find((item) => item.workspaceId === "main");
    if (!mainSession) return undefined;
    const agent = this.repos.getAgent(input.agentId);
    const llmCallId = createId("llm");
    const handoffContext = this.createChildToMainHandoff(input, session, toolMessages);
    mainSession.localContext.handoffContext = [
      handoffContext,
      ...(mainSession.localContext.handoffContext ?? [])
    ].slice(0, 8);
    this.repos.updateWorkspaceSessionLocalContext(mainSession);
    const context = this.buildLlmContext({
      input,
      agent,
      llmCallId,
      llmBaseUrl: prepared.llm.baseUrl,
      llmModel: prepared.llm.model,
      workspaceId: "main",
      activeSession: mainSession,
      workspaceTrace: prepared.workspaceTrace,
      assistantToolMessage,
      toolMessages
    });
    const fromWorkspaceId = prepared.activeWorkspaceId;
    prepared.activeWorkspaceId = "main";
    prepared.contextSegments = context.contextSegments;
    prepared.finalMessages = context.messages;
    prepared.callableTools = context.callableTools;
    this.repos.saveLlmCall(context.snapshot, context.contextSegments);
    this.repos.audit(input.userId, "system", "workspace_returned_to_main", "workspace_session", session.id, {
      conversationId: input.conversationId,
      workspaceId: "main",
      fromWorkspaceId,
      taskId: session.taskId,
      llmCallId,
      status: session.status
    });
    return { llmCallId, messages: context.messages };
  }

  private saveFollowUpLlmCall(input: AgentRunInput, prepared: AgentRunPrepared, messages: LLMMessage[], toolMessages: LLMMessage[] = []): string {
    const llmCallId = createId("llm");
    const baseSegments = prepared.contextSegments
      .filter((segment) => segment.segmentType !== "tool_result" && segment.segmentType !== "final_messages")
      .map((segment) => ({
        ...segment,
        id: createId("ctx"),
        llmCallId,
        conversationId: input.conversationId
      }));
    const snapshot: LLMCallSnapshot = {
      id: llmCallId,
      conversationId: input.conversationId,
      userId: input.userId,
      providerBaseUrl: prepared.llm.baseUrl,
      normalizedEndpoint: normalizeChatCompletionsEndpoint(prepared.llm.baseUrl),
      model: prepared.llm.model,
      messagesJson: JSON.stringify(messages),
      toolsJson: JSON.stringify(prepared.callableTools, null, 2),
      status: "pending",
      responseJson: "{}",
      createdAt: nowIso()
    };
    const segments: ContextSegment[] = [...baseSegments];
    const actualToolResults = messages.filter((message) => (
      message.role === "tool" &&
      !(message.name ?? "").startsWith("runtime_context.")
    ));
    const assistantToolCalls = messages
      .filter((message) => message.role === "assistant" && message.tool_calls?.length)
      .map((message) => ({
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls
      }));
    const followUpToolContext = {
      assistantToolCalls,
      toolResults: actualToolResults.length > 0 ? actualToolResults : toolMessages
    };
    if (followUpToolContext.assistantToolCalls.length > 0 || followUpToolContext.toolResults.length > 0) {
      const content = this.attentionBudget.fitSegment("tool_result", JSON.stringify(followUpToolContext, null, 2));
      segments.push({
        id: createId("ctx"),
        llmCallId,
        conversationId: input.conversationId,
        segmentType: "tool_result",
        title: "Function Calls And Tool Results For Follow-up LLM Call",
        content,
        tokenEstimate: estimateTokens(content),
        sortOrder: 75
      });
    }
    const finalMessagesContent = JSON.stringify(messages, null, 2);
    segments.push({
      id: createId("ctx"),
      llmCallId,
      conversationId: input.conversationId,
      segmentType: "final_messages",
      title: "Final LLM Messages",
      content: finalMessagesContent,
      tokenEstimate: estimateTokens(finalMessagesContent),
      sortOrder: 90
    });
    this.repos.saveLlmCall(snapshot, segments);
    return llmCallId;
  }

  private async runToolLoop(
    input: AgentRunInput,
    prepared: AgentRunPrepared,
    initialCompletion: ChatCompletionOutput
  ): Promise<{ completion: ChatCompletionOutput; memoryWrites: MemoryRow[]; finalMessages: LLMMessage[] }> {
    const memoryWrites: MemoryRow[] = [];
    let completion = initialCompletion;
    let messages = prepared.finalMessages;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
      const toolCalls = completion.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        if (prepared.activeWorkspaceId !== "main") {
          const exitRequest = this.requireChildWorkspaceExit(input, prepared, messages, completion.message, { toolLoopRound: round });
          messages = exitRequest.messages;
          try {
            completion = await this.llmClient.complete({
              baseUrl: prepared.llm.baseUrl,
              apiKey: prepared.llm.apiKey,
              model: prepared.llm.model,
              messages,
              tools: prepared.callableTools,
              temperature: prepared.llm.temperature,
              signal: input.abortSignal
            });
            this.repos.markLlmCallCompleted(exitRequest.llmCallId, llmResponseSnapshot(completion, {
              toolLoopRound: round,
              afterRequiredWorkspaceExit: true
            }));
            continue;
          } catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            this.repos.markLlmCallFailed(exitRequest.llmCallId, errorText);
            throw error;
          }
        }
        return { completion, memoryWrites, finalMessages: messages };
      }

      const toolExecution = await this.executeToolCalls(input, prepared, toolCalls);
      memoryWrites.push(...toolExecution.memoryWrites);
      const transition = this.applyWorkspaceTransition(input, prepared, toolExecution.enteredWorkspaceSession, completion.message, toolExecution.toolMessages)
        ?? this.applyWorkspaceExitTransition(input, prepared, toolExecution.exitedWorkspaceSession, completion.message, toolExecution.toolMessages);
      messages = transition?.messages ?? [...messages, completion.message, ...toolExecution.toolMessages];
      if (toolExecution.terminalAssistantMessage) {
        const terminalMessage: LLMMessage = {
          role: "assistant",
          content: toolExecution.terminalAssistantMessage
        };
        return {
          completion: {
            message: terminalMessage,
            raw: {
              terminalToolResult: true,
              activeWorkspaceId: prepared.activeWorkspaceId
            }
          },
          memoryWrites,
          finalMessages: [...messages, terminalMessage]
        };
      }
      const llmCallId = transition?.llmCallId ?? this.saveFollowUpLlmCall(input, prepared, messages, toolExecution.toolMessages);

      try {
        completion = await this.llmClient.complete({
          baseUrl: prepared.llm.baseUrl,
          apiKey: prepared.llm.apiKey,
          model: prepared.llm.model,
          messages,
          tools: prepared.callableTools,
          temperature: prepared.llm.temperature,
          signal: input.abortSignal
        });
        this.repos.markLlmCallCompleted(llmCallId, llmResponseSnapshot(completion, {
          toolLoopRound: round
        }));
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        this.repos.markLlmCallFailed(llmCallId, errorText);
        throw error;
      }
    }

    if ((completion.message.tool_calls ?? []).length > 0) {
      this.repos.audit(input.userId, "system", "tool_loop_stopped", "conversation", input.conversationId, {
        conversationId: input.conversationId,
        workspaceId: prepared.activeWorkspaceId,
        maxToolRounds: MAX_TOOL_ROUNDS,
        requestedToolCount: completion.message.tool_calls?.length ?? 0
      });
      completion = {
        message: {
          role: "assistant",
          content: TOOL_LOOP_LIMIT_USER_MESSAGE
        },
        raw: { stoppedBy: "maxToolRounds", maxToolRounds: MAX_TOOL_ROUNDS }
      };
    }
    if (prepared.activeWorkspaceId !== "main") {
      this.repos.audit(input.userId, "system", "workspace_exit_missing", "conversation", input.conversationId, {
        conversationId: input.conversationId,
        workspaceId: prepared.activeWorkspaceId,
        maxToolRounds: MAX_TOOL_ROUNDS,
        lastAssistantTextLength: completion.message.content?.length ?? 0
      });
      completion = {
        message: {
          role: "assistant",
          content: "当前步骤还没有形成可靠的可交付结果。请确认是否继续推进，或补充下一步要求。"
        },
        raw: { stoppedBy: "missingWorkspaceExit", maxToolRounds: MAX_TOOL_ROUNDS }
      };
    }

    return { completion, memoryWrites, finalMessages: messages };
  }

  private requireChildWorkspaceExit(
    input: AgentRunInput,
    prepared: AgentRunPrepared,
    messages: LLMMessage[],
    assistantMessage: LLMMessage,
    metadata: Record<string, unknown> = {}
  ): { llmCallId: string; messages: LLMMessage[] } {
    const session = this.findActiveWorkspaceSession(prepared);
    const reminder: LLMMessage = {
      role: "system",
      content: [
        `The active workspace is ${prepared.activeWorkspaceId}.`,
        "A child workspace cannot produce the final user-facing answer directly.",
        "Return a structured WorkspaceResult by calling exitWorkspace with status, summary, artifacts, observations, errors, and suggestedNextSteps.",
        "Keep raw local evidence in the workspace session; main workspace will integrate the returned result."
      ].join("\n")
    };
    const nextMessages = [...messages, assistantMessage, reminder];
    const llmCallId = this.saveFollowUpLlmCall(input, prepared, nextMessages);
    this.repos.audit(input.userId, "system", "workspace_exit_required", "workspace_session", session?.id, {
      conversationId: input.conversationId,
      workspaceId: prepared.activeWorkspaceId,
      workspaceSessionId: session?.id,
      taskId: session?.taskId,
      llmCallId,
      assistantTextLength: assistantMessage.content?.length ?? 0,
      ...metadata
    });
    return { llmCallId, messages: nextMessages };
  }
}

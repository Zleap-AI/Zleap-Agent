import type { AgentConfig, AgentRunInput, AgentRunOutput, AgentRunPrepared, ContextSegment, LLMCallSnapshot, LLMMessage, MemoryRow, WorkspaceResult, WorkspaceSession } from "../types";
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
const MAX_TOOL_ROUNDS = 4;

function summarizeAssistantMessage(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
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
        temperature: prepared.llm.temperature
      });
      this.repos.markLlmCallCompleted(prepared.llmCallId, completion.raw);
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

  async *runStream(input: AgentRunInput): AsyncGenerator<{ type: "start"; output: Omit<AgentRunOutput, "assistantMessage"> } | { type: "delta"; text: string } | { type: "done"; output: AgentRunOutput }> {
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
            temperature: prepared.llm.temperature
          })) {
            if (event.type === "content") roundText += event.text;
            if (event.type === "tool_call_delta") this.mergeToolCallDelta(toolCallDeltas, event);
          }
          const toolCalls = this.materializeToolCalls(toolCallDeltas);
          this.repos.markLlmCallCompleted(currentLlmCallId, {
            streamed: true,
            returnedTextLength: roundText.length,
            assistantMessage: roundText,
            toolCallCount: toolCalls.length,
            toolLoopRound: round
          });

          if (toolCalls.length === 0) {
            if (prepared.activeWorkspaceId !== "main") {
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
            assistantMessage = "\u6211\u5df2\u7ecf\u5b8c\u6210\u4e86\u5f53\u524d\u5141\u8bb8\u7684\u8fde\u7eed\u64cd\u4f5c\u8f6e\u6b21\u3002\u8bf7\u786e\u8ba4\u4e0b\u4e00\u6b65\u8981\u7ee7\u7eed\u6267\u884c\u54ea\u4e00\u90e8\u5206\u3002";
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
          const toolExecution = await this.executeToolCalls(input, prepared, toolCalls);
          memoryWrites.push(...toolExecution.memoryWrites);
          const transition = this.applyWorkspaceTransition(input, prepared, toolExecution.enteredWorkspaceSession, assistantToolMessage, toolExecution.toolMessages)
            ?? this.applyWorkspaceExitTransition(input, prepared, toolExecution.exitedWorkspaceSession, assistantToolMessage, toolExecution.toolMessages);
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
          temperature: prepared.llm.temperature
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
    this.hookManager.record({
      hook: "beforeAgentTurn",
      actorId: input.userId,
      actorRole: input.userRole,
      metadata: {
        conversationId: input.conversationId,
        agentId: input.agentId,
        model,
        hasApiKey: Boolean(apiKey)
      }
    });
    this.repos.addMessage(input.conversationId, "user", input.message);

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
    const history = this.selectLocalHistory(input.input.conversationId, input.workspaceId);
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

  private selectLocalHistory(conversationId: string, workspaceId: string): Array<{ role: string; content: string }> {
    if (workspaceId !== "main") return [];
    return this.repos.listMessages(conversationId, 12).map((message) => ({
      role: message.role,
      content: message.content
    }));
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
    const segments: ContextSegment[] = [];
    if (toolMessages.length > 0) {
      const content = this.attentionBudget.fitSegment("tool_result", JSON.stringify(toolMessages, null, 2));
      segments.push({
        id: createId("ctx"),
        llmCallId,
        conversationId: input.conversationId,
        segmentType: "tool_result",
        title: "Tool Results For Follow-up LLM Call",
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
              temperature: prepared.llm.temperature
            });
            this.repos.markLlmCallCompleted(exitRequest.llmCallId, {
              ...(completion.raw && typeof completion.raw === "object" ? completion.raw as Record<string, unknown> : { raw: completion.raw }),
              toolLoopRound: round,
              afterRequiredWorkspaceExit: true
            });
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
          temperature: prepared.llm.temperature
        });
        this.repos.markLlmCallCompleted(llmCallId, {
          ...(completion.raw && typeof completion.raw === "object" ? completion.raw as Record<string, unknown> : { raw: completion.raw }),
          toolLoopRound: round
        });
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
          content: "我已经完成了当前允许的连续操作轮次。请确认下一步要继续执行哪一部分。"
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

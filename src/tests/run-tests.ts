import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { migrate } from "../db/schema";
import { seedDefaults } from "../db/seed";
import { Repositories, mcpServerToBindingJson } from "../db/repositories";
import { AgentRuntime } from "../core/agent-runtime";
import { conversationWorkspaceRoot, defaultFileWorkspaceBaseRoot } from "../core/builtin-tools";
import { MemoryService } from "../core/memory-service";
import { WorkspaceRuntime } from "../core/workspace-runtime";
import { McpToolExecutor } from "../core/mcp-executor";
import { parseActor, parseActorFromSearchParams } from "../server/actor";
import { createZleapServer } from "../server/index";
import type { ChatCompletionInput, ChatCompletionOutput, LLMClient, LLMStreamEvent } from "../core/llm-client";
import { normalizeChatCompletionsEndpoint, normalizeProviderBaseUrl, OpenAICompatibleClient } from "../core/llm-client";
import type { ContextSegment, MemoryRow } from "../types";

async function pathExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
}

class FakeLLMClient implements LLMClient {
  lastInput: ChatCompletionInput | undefined;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.lastInput = input;
    return {
      message: {
        role: "assistant",
        content: "fake response"
      },
      raw: { ok: true }
    };
  }

  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    this.lastInput = input;
    yield "fake ";
    yield "stream";
  }
}

async function testWebUiMasterPlanContracts() {
  const webSource = await fs.readFile(path.resolve("src/web/main.tsx"), "utf8");
  const serverSource = await fs.readFile(path.resolve("src/server/index.ts"), "utf8");

  const expectWeb = (needle: string) => assert.ok(webSource.includes(needle), `Web UI contract missing: ${needle}`);
  const expectServer = (needle: string) => assert.ok(serverSource.includes(needle), `Server stream contract missing: ${needle}`);

  for (const tab of ["chat", "workspace", "memory", "logs", "tables", "config", "concept"]) {
    expectWeb(`renderTabPanel("${tab}"`);
  }
  expectWeb("aria-hidden={tab !== item}");
  expectWeb("const [apiKey, setApiKey] = useState(cached.apiKey ?? \"\")");
  expectWeb("const [agents, setAgents] = useState<AgentConfig[]>([])");
  expectWeb("const chatHeaderSubtitle = messages.length > 0 ? currentConversation?.title ?? \"新对话\" : \"新对话\"");
  expectWeb("void refreshConversations(conversationId, true)");
  expectWeb("当前智能体");
  expectWeb("新建智能体");
  expectWeb("defaultModel: model || sourceAgent.defaultModel");
  expectWeb("saveCache({ agentId: selectedAgentId, userId, userRole, conversationId, baseUrl, model, apiKey, contextPanelWidth, messages, output, retryMessage, selectedTurnId, selectedLlmCallId, agentDraft: agent ?? undefined })");
  expectWeb("normalizeCachedMessages(cached.messages)");
  expectWeb("if (item.failed) return false");
  expectWeb("setMessages((items) => items.filter((item) => item.runId !== runId && item.id !== userMessageId && item.id !== assistantMessageId))");
  expectWeb("currentRunControllerRef.current?.abort()");
  expectWeb("signal: controller.signal");
  expectWeb("content: item.content || \"已停止运行。\", streaming: false, failed: false, requestText: undefined");
  expectWeb("await api(`/api/conversations/${encodeURIComponent(conversationId)}`");
  expectWeb("method: \"DELETE\"");
  expectWeb("function MarkdownMessage");
  assert.equal(webSource.includes("dangerouslySetInnerHTML"), false);
  expectWeb("showRawContextLogs ? \"显示结构化视图\" : \"显示原始日志\"");
  expectWeb("placeholder=\"搜索原始日志关键词\"");
  expectWeb("renderRawLogSearchHighlights");
  expectWeb("rawLogMatchCount");
  expectWeb("toolProcessMessagesForTurn");
  expectWeb("main 函数调用");
  expectWeb("MemoryEvidencePanel");
  expectWeb("记忆只保存语义投影");
  expectWeb("relationId");

  expectServer("const abortController = new AbortController()");
  expectServer("request.on(\"aborted\", stopRun)");
  expectServer("response.on(\"close\", stopRun)");
  expectServer("runtime.runStream({ ...body, abortSignal: abortController.signal })");
}

function assertFollowUpContextStacksIncludeBaseSegments(trace: ReturnType<Repositories["getTrace"]>): void {
  const followUpSegments = trace.contextSegments.filter((segment) => segment.segmentType === "tool_result");
  assert.equal(followUpSegments.length > 0, true);
  const requiredTypes: ContextSegment["segmentType"][] = ["system", "workspace", "tools", "memory", "history", "user", "tool_result", "final_messages"];
  for (const followUpSegment of followUpSegments) {
    const segmentsForCall = trace.contextSegments.filter((segment) => segment.llmCallId === followUpSegment.llmCallId);
    const segmentTypes = new Set(segmentsForCall.map((segment) => segment.segmentType));
    for (const requiredType of requiredTypes) {
      assert.equal(segmentTypes.has(requiredType), true, `follow-up ${followUpSegment.llmCallId} missing ${requiredType}`);
    }
    assert.equal(followUpSegment.content.includes("assistantToolCalls"), true);
    assert.equal(followUpSegment.content.includes("toolResults"), true);
    assert.equal(followUpSegment.content.includes("writeUserImpression"), true);
  }
}

class MainToFileLLMClient implements LLMClient {
  calls = 0;
  inputs: ChatCompletionInput[] = [];

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    this.inputs.push(input);
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
      assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), false);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "search files for runtime" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), true);
      assert.equal(input.tools.some((tool) => tool.name === "runCommand"), true);
      assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "enterWorkspace"), true);
      return {
        message: {
          role: "assistant",
          content: "child attempted direct response"
        },
        raw: { childDirectResponse: true }
      };
    }
    if (this.calls === 3) {
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      assert.equal(input.messages.some((message) => message.role === "system" && (message.content ?? "").includes("cannot produce the final user-facing answer")), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-file-after-direct-response",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "File workspace returned structured evidence after a direct-response guard.",
                artifacts: [],
                observations: ["File workspace attempted direct response and then returned a WorkspaceResult."],
                errors: [],
                suggestedNextSteps: ["Main workspace should integrate the file result."]
              })
            }
          }]
        },
        raw: { returnedWorkspace: "dev", afterDirectResponseGuard: true }
      };
    }
    assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
    assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), false);
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "exitWorkspace"), true);
    return {
      message: {
        role: "assistant",
        content: "fake response"
      },
      raw: {
        ok: true,
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168
        }
      }
    };
  }
}

class MainToFileExitToMainLLMClient implements LLMClient {
  calls = 0;
  inputs: ChatCompletionInput[] = [];

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    this.inputs.push(input);
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), false);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-exit-test",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "inspect file evidence" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), true);
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      return {
        message: {
          role: "assistant",
          content: "我已经检查 dev 工作空间的证据能力，确认可以把搜索结论和后续建议交回 main。",
          tool_calls: [{
            id: "call-exit-file",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "File workspace inspected available evidence.",
                artifacts: [],
                observations: ["File workspace had searchFiles available."],
                errors: [],
                suggestedNextSteps: ["Return to main for final response."]
              })
            }
          }]
        },
        raw: { returnedWorkspace: "dev" }
      };
    }
    assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
    assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), false);
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "exitWorkspace"), true);
    return {
      message: {
        role: "assistant",
        content: "main integrated file result"
      },
      raw: { final: true }
    };
  }
}

class ResumeChildWorkspaceLLMClient implements LLMClient {
  calls = 0;
  inputs: ChatCompletionInput[] = [];

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    this.inputs.push(input);
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "writeFile"), true);
      assert.equal(input.tools.some((tool) => tool.name === "runCommand"), true);
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), false);
      const workspaceMessage = input.messages.find((message) => message.role === "tool" && message.name === "runtime_context.workspace");
      const workspaceContent = workspaceMessage?.content ?? "";
      assert.equal(workspaceContent.includes("\"id\":\"dev\"") || workspaceContent.includes("\"id\": \"dev\""), true);
      const localMessage = input.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
      assert.equal((localMessage?.content ?? "").includes("继续修复刚才的写入任务"), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-resumed-dev",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "恢复后的 dev 工作空间已经完成写入任务。",
                artifacts: [{ kind: "file", ref: "notes/resumed.md", description: "恢复后写入的文件" }],
                observations: ["用户的新输入直接接续到 dev 工作空间。"],
                errors: [],
                suggestedNextSteps: ["main 根据恢复后的结果回复用户。"]
              })
            }
          }]
        },
        raw: { resumedWorkspace: "dev" }
      };
    }
    assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
    assert.equal(input.tools.some((tool) => tool.name === "writeFile"), false);
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "exitWorkspace"), true);
    return {
      message: {
        role: "assistant",
        content: "已经接着刚才的 dev 工作空间完成了。"
      },
      raw: { final: true }
    };
  }
}

class MainToFileExitWithExtraToolLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-extra-tool",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "inspect file evidence with a batched exit" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-exit-file-extra-tool",
              type: "function",
              function: {
                name: "exitWorkspace",
                arguments: JSON.stringify({
                  status: "completed",
                  summary: "File workspace completed the batched exit.",
                  artifacts: [],
                  observations: ["File workspace is ready to return to main."],
                  errors: [],
                  suggestedNextSteps: ["Main should integrate this result."]
                })
              }
            },
            {
              id: "call-search-after-exit-same-batch",
              type: "function",
              function: {
                name: "searchFiles",
                arguments: JSON.stringify({ query: "late evidence" })
              }
            }
          ]
        },
        raw: { returnedWorkspace: "dev", sameBatchToolAfterExit: true }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "main integrated batched file result"
      },
      raw: { final: true }
    };
  }
}

class MainToFileDoubleExitLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-double-exit",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "inspect file evidence with duplicate exits" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-exit-file-first",
              type: "function",
              function: {
                name: "exitWorkspace",
                arguments: JSON.stringify({
                  status: "completed",
                  summary: "First valid file result.",
                  artifacts: [],
                  observations: ["The first exit result should be committed."],
                  errors: [],
                  suggestedNextSteps: ["Main should integrate the first result."]
                })
              }
            },
            {
              id: "call-exit-file-second",
              type: "function",
              function: {
                name: "exitWorkspace",
                arguments: JSON.stringify({
                  status: "failed",
                  summary: "Second duplicate file result must not overwrite the first.",
                  artifacts: [],
                  observations: ["This duplicate exit should fail."],
                  errors: ["duplicate exit"],
                  suggestedNextSteps: ["Do not overwrite the committed result."]
                })
              }
            }
          ]
        },
        raw: { duplicateExit: true }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "main integrated first file result"
      },
      raw: { final: true }
    };
  }
}

class MainToFileMalformedExitLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-malformed-exit",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "inspect file evidence" })
            }
          }]
        },
        raw: { step: "enter-file" }
      };
    }
    if (this.calls === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-bad-exit-file",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "running",
                summary: "A child workspace must not hand running state back to main.",
                artifacts: [],
                observations: [],
                errors: [],
                suggestedNextSteps: []
              })
            }
          }]
        },
        raw: { step: "bad-exit" }
      };
    }
    if (this.calls === 3) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-incomplete-exit-file",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "This exit is missing required WorkspaceResult arrays."
              })
            }
          }]
        },
        raw: { step: "incomplete-exit" }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "bad exit handled"
      },
      raw: { final: true }
    };
  }
}

class TwoFileSessionsLLMClient implements LLMClient {
  calls = 0;
  inputs: ChatCompletionInput[] = [];

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    this.inputs.push(input);
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-first",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "first file session" })
            }
          }]
        },
        raw: { step: "enter-first-file" }
      };
    }
    if (this.calls === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-file-first",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "First file session finished.",
                artifacts: [],
                observations: ["First file session observation."],
                errors: [],
                suggestedNextSteps: []
              })
            }
          }]
        },
        raw: { step: "exit-first-file" }
      };
    }
    if (this.calls === 3) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-second",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "second file session" })
            }
          }]
        },
        raw: { step: "enter-second-file" }
      };
    }
    if (this.calls === 4) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-file-second",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "Second file session finished.",
                artifacts: [],
                observations: ["Second file session observation."],
                errors: [],
                suggestedNextSteps: []
              })
            }
          }]
        },
        raw: { step: "exit-second-file" }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "second file session ready"
      },
      raw: { final: true }
    };
  }
}

class MainToCliLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-cli",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "run command or test task" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    assert.equal(input.tools.some((tool) => tool.name === "runCommand"), true);
    return {
      message: {
        role: "assistant",
        content: "fake response"
      },
      raw: { ok: true }
    };
  }
}

class MainToCliToolRequestLLMClient implements LLMClient {
  calls = 0;
  lastToolResult = "";

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown> = {}
  ) {}

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-cli",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "run CLI tool" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === this.toolName), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-${this.toolName}`,
            type: "function",
            function: {
              name: this.toolName,
              arguments: JSON.stringify(this.args)
            }
          }]
        },
        raw: { requestedTool: this.toolName }
      };
    }
    const toolMessage = [...input.messages].reverse().find((message) => message.role === "tool" && message.name === this.toolName);
    this.lastToolResult = toolMessage?.content ?? "";
    return {
      message: {
        role: "assistant",
        content: "tool handled"
      },
      raw: { final: true }
    };
  }
}

class MainToWorkspaceToolRequestLLMClient implements LLMClient {
  calls = 0;
  lastToolResult = "";

  constructor(
    private readonly workspaceId: string,
    private readonly toolName: string,
    private readonly args: Record<string, unknown> = {}
  ) {}

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-enter-${this.workspaceId}`,
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: this.workspaceId, objective: `use ${this.toolName}` })
            }
          }]
        },
        raw: { plannedWorkspace: this.workspaceId }
      };
    }
    if (this.calls === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-${this.toolName}`,
            type: "function",
            function: {
              name: this.toolName,
              arguments: JSON.stringify(this.args)
            }
          }]
        },
        raw: { requestedTool: this.toolName }
      };
    }
    const toolMessage = [...input.messages].reverse().find((message) => message.role === "tool" && message.name === this.toolName);
    this.lastToolResult = toolMessage?.content ?? "";
    if (this.calls === 3) {
      const failed = this.lastToolResult.includes("\"error\"");
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-exit-${this.workspaceId}`,
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                result: {
                  status: failed ? "failed" : "completed",
                  summary: failed ? `${this.toolName} failed.` : `${this.toolName} completed.`,
                  artifacts: [],
                  observations: [this.lastToolResult],
                  errors: failed ? [this.lastToolResult] : [],
                  suggestedNextSteps: []
                }
              })
            }
          }]
        },
        raw: { requestedExit: true }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "tool handled"
      },
      raw: { final: true }
    };
  }
}

class MainToCliRunCommandExitLLMClient implements LLMClient {
  calls = 0;
  lastToolResult = "";

  constructor(private readonly command: string) {}

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-cli-run-command",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "run reusable command workflow" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-run-command-for-skill",
            type: "function",
            function: {
              name: "runCommand",
              arguments: JSON.stringify({ command: this.command })
            }
          }]
        },
        raw: { requestedTool: "runCommand" }
      };
    }
    const toolMessage = [...input.messages].reverse().find((message) => message.role === "tool" && message.name === "runCommand");
    this.lastToolResult = toolMessage?.content ?? "";
    if (this.calls === 3) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-cli-after-run-command",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "runCommand completed.",
                artifacts: [],
                observations: [this.lastToolResult],
                errors: [],
                suggestedNextSteps: []
              })
            }
          }]
        },
        raw: { requestedExit: true }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "tool handled"
      },
      raw: { final: true }
    };
  }
}

class ChildMainOnlyToolAttemptLLMClient implements LLMClient {
  calls = 0;
  childToolNames: string[] = [];
  childEnterWorkspaceResult = "";

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-enter-file-main-only-bound",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "verify child orchestration boundary" })
            }
          }]
        },
        raw: { plannedWorkspace: "dev" }
      };
    }
    if (this.calls === 2) {
      this.childToolNames = input.tools.map((tool) => tool.name);
      assert.equal(this.childToolNames.includes("enterWorkspace"), false);
      assert.equal(this.childToolNames.includes("askUser"), false);
      assert.equal(this.childToolNames.includes("finishTask"), false);
      assert.equal(this.childToolNames.includes("exitWorkspace"), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-child-enter-cli-should-fail",
            type: "function",
            function: {
              name: "enterWorkspace",
              arguments: JSON.stringify({ workspaceId: "dev", objective: "child should not jump to sibling" })
            }
          }]
        },
        raw: { attemptedSiblingJump: true }
      };
    }
    if (this.calls === 3) {
      this.childEnterWorkspaceResult = [...input.messages].reverse().find((message) => message.role === "tool" && message.name === "enterWorkspace")?.content ?? "";
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-exit-file-after-main-only-block",
            type: "function",
            function: {
              name: "exitWorkspace",
              arguments: JSON.stringify({
                status: "completed",
                summary: "Child respected the main-only orchestration boundary.",
                artifacts: [],
                observations: ["Sibling workspace selection must be returned to main as suggestedNextSteps."],
                errors: [],
                suggestedNextSteps: ["Main may decide whether to enter cli."]
              })
            }
          }]
        },
        raw: { exitedAfterBlockedJump: true }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "main handled child boundary result"
      },
      raw: { final: true }
    };
  }
}

class FailingLLMClient implements LLMClient {
  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("provider timeout");
  }
}

class ToolCallingLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "writeUserImpression"), true);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-memory",
            type: "function",
            function: {
              name: "writeUserImpression",
              arguments: JSON.stringify({
                title: "Language preference",
                summary: "Prefers concise Chinese answers",
                detail: "The user asked the agent to remember concise Chinese answers."
              })
            }
          }]
        },
        raw: { tool: true }
      };
    }
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "writeUserImpression"), true);
    return {
      message: {
        role: "assistant",
        content: "memory saved"
      },
      raw: { final: true }
    };
  }
}

class StreamingToolCallingLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming test");
  }

  async *streamEvents(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "writeUserImpression"), true);
      yield { type: "tool_call_delta", index: 0, id: "stream-call", name: "writeUserImpression" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          title: "Streaming preference",
          summary: "Prefers streaming memory support",
          detail: "The agent should write memory during streaming requests too."
        })
      };
      return;
    }
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "writeUserImpression"), true);
    yield { type: "content", text: "stream " };
    yield { type: "content", text: "final" };
  }
}

class StreamingToolThenFailureLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming failure test");
  }

  async *streamEvents(): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "tool_call_delta", index: 0, id: "stream-call-before-failure", name: "writeUserImpression" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          title: "Streaming follow-up failure",
          summary: "Follow-up streaming failures should close the pending LLM call",
          detail: "When a streamed tool result is followed by a provider failure, the runtime must mark the saved follow-up LLM call failed."
        })
      };
      return;
    }
    throw new Error("provider stream idle timeout");
  }
}

class StreamingContentOnlyLLMClient implements LLMClient {
  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming content-only test");
  }

  async *streamEvents(): AsyncGenerator<LLMStreamEvent> {
    yield { type: "content", text: "streamed " };
    yield { type: "content", text: "assistant" };
  }
}

class StreamingToolTextLeakLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming leak test");
  }

  async *streamEvents(): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "content", text: "internal workspace routing text" };
      yield { type: "tool_call_delta", index: 0, id: "stream-leak-call", name: "writeUserImpression" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          title: "Streaming leak guard",
          summary: "Intermediate tool-round text should not stream to users",
          detail: "Streaming tool rounds may contain internal narration that must stay in logs only."
        })
      };
      return;
    }
    yield { type: "content", text: "final user answer" };
  }
}

class StreamingWorkspaceVisibilityLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming workspace visibility test");
  }

  async *streamEvents(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(input.tools.some((tool) => tool.name === "enterWorkspace"), true);
      yield { type: "tool_call_delta", index: 0, id: "stream-enter-file", name: "enterWorkspace" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({ workspaceId: "dev", objective: "inspect streamed workspace visibility" })
      };
      return;
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      yield { type: "content", text: "file workspace explains its intermediate step" };
      yield { type: "tool_call_delta", index: 0, id: "stream-exit-file-visible", name: "exitWorkspace" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          status: "completed",
          summary: "File workspace returned visible intermediate evidence.",
          artifacts: [],
          observations: ["The child workspace LLM interaction should be visible in chat."],
          errors: [],
          suggestedNextSteps: ["Main should produce the final answer."]
        })
      };
      return;
    }
    yield { type: "content", text: "main final answer" };
  }
}

class SingleToolRequestLLMClient implements LLMClient {
  calls = 0;
  lastToolResult = "";

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown> = {}
  ) {}

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-${this.toolName}`,
            type: "function",
            function: {
              name: this.toolName,
              arguments: JSON.stringify(this.args)
            }
          }]
        },
        raw: { requestedTool: this.toolName }
      };
    }
    const toolMessage = input.messages.find((message) => message.role === "tool" && message.name === this.toolName);
    this.lastToolResult = toolMessage?.content ?? "";
    return {
      message: {
        role: "assistant",
        content: "tool handled"
      },
      raw: { final: true }
    };
  }
}

class MultiStepToolLoopLLMClient implements LLMClient {
  calls = 0;

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-first-memory",
            type: "function",
            function: {
              name: "writeUserImpression",
              arguments: JSON.stringify({
                title: "Loop preference one",
                summary: "First loop memory write",
                detail: "The first tool loop writes a user impression."
              })
            }
          }]
        },
        raw: { step: 1 }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.messages.filter((message) => message.role === "tool").length, 4);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-second-memory",
            type: "function",
            function: {
              name: "writeUserImpression",
              arguments: JSON.stringify({
                title: "Loop preference two",
                summary: "Second loop memory write",
                detail: "The second tool loop writes another user impression."
              })
            }
          }]
        },
        raw: { step: 2 }
      };
    }
    assert.equal(input.messages.filter((message) => message.role === "tool" && message.name === "writeUserImpression").length, 2);
    return {
      message: {
        role: "assistant",
        content: "multi-step final"
      },
      raw: { final: true }
    };
  }
}

class NeverEndingToolLoopLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    this.calls += 1;
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-loop-${this.calls}`,
          type: "function",
          function: {
            name: "writeUserImpression",
            arguments: JSON.stringify({
              title: "Loop limit preference",
              summary: "Repeated tool loop request",
              detail: "The model keeps requesting the same memory write."
            })
          }
        }]
      },
      raw: { loop: this.calls }
    };
  }
}

class StreamingMultiStepToolLoopLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming multi-step test");
  }

  async *streamEvents(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "tool_call_delta", index: 0, id: "stream-first-memory", name: "writeUserImpression" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          title: "Streaming loop preference one",
          summary: "First streaming loop memory write",
          detail: "The first streaming tool loop writes a user impression."
        })
      };
      return;
    }
    if (this.calls === 2) {
      assert.equal(input.messages.filter((message) => message.role === "tool").length, 4);
      yield { type: "tool_call_delta", index: 0, id: "stream-second-memory", name: "writeUserImpression" };
      yield {
        type: "tool_call_delta",
        index: 0,
        arguments: JSON.stringify({
          title: "Streaming loop preference two",
          summary: "Second streaming loop memory write",
          detail: "The second streaming tool loop writes another user impression."
        })
      };
      return;
    }
    assert.equal(input.messages.filter((message) => message.role === "tool" && message.name === "writeUserImpression").length, 2);
    yield { type: "content", text: "stream multi " };
    yield { type: "content", text: "final" };
  }
}

class StreamingNeverEndingToolLoopLLMClient implements LLMClient {
  calls = 0;

  async complete(): Promise<ChatCompletionOutput> {
    throw new Error("complete should not be used in streaming loop limit test");
  }

  async *streamEvents(): AsyncGenerator<LLMStreamEvent> {
    this.calls += 1;
    yield { type: "tool_call_delta", index: 0, id: `stream-loop-${this.calls}`, name: "writeUserImpression" };
    yield {
      type: "tool_call_delta",
      index: 0,
      arguments: JSON.stringify({
        title: "Streaming loop limit preference",
        summary: "Repeated streaming tool loop request",
        detail: "The streaming model keeps requesting the same memory write."
      })
    };
  }
}

function createRepos(): Repositories {
  const db = new Database(":memory:");
  migrate(db);
  seedDefaults(db);
  return new Repositories(db);
}

async function withTestHttpServer<T>(repos: Repositories, callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createZleapServer({
    repos,
    runtime: new AgentRuntime(repos, new FakeLLMClient()),
    memoryService: new MemoryService(repos),
    mcpToolExecutor: new McpToolExecutor(),
    serveStatic: async () => false
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function httpJson(baseUrl: string, pathName: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

function metadataOf(memory: { metadataJson: string }): Record<string, any> {
  return JSON.parse(memory.metadataJson) as Record<string, any>;
}

function metadataSourceIds(memory: { metadataJson: string }, table: string): string[] {
  const metadata = metadataOf(memory);
  const refs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : [];
  const ref = refs.find((item: any) => item?.table === table);
  return Array.isArray(ref?.ids) ? ref.ids : [];
}

function promptSection(content: string, heading: string, nextHeading: string): string {
  const start = content.indexOf(heading);
  assert.equal(start >= 0, true, `Missing prompt heading: ${heading}`);
  const bodyStart = start + heading.length;
  const end = content.indexOf(nextHeading, bodyStart);
  assert.equal(end >= 0, true, `Missing next prompt heading: ${nextHeading}`);
  return content.slice(bodyStart, end).trim();
}

const RAW_MEMORY_METADATA_PAYLOAD_KEYS = [
  "messages",
  "windowMessages",
  "rawMessages",
  "toolCalls",
  "workspaceSessions",
  "workspaceSession",
  "llmCalls",
  "contextSegments",
  "argumentsJson",
  "resultJson",
  "messagesJson",
  "toolsJson",
  "responseJson",
  "rawJson",
  "finalMessages",
  "localContextJson",
  "taskJson"
];

function updateWorkspaceMemoryPolicy(repos: Repositories, workspaceId: string, patch: Record<string, unknown>) {
  const workspace = repos.getWorkspace(workspaceId);
  const memoryPolicy = { ...workspace.memoryPolicy, ...patch };
  repos.upsertWorkspace({
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    capabilitiesJson: workspace.capabilitiesJson,
    inputKindsJson: workspace.inputKindsJson,
    outputKindsJson: workspace.outputKindsJson,
    requiresApproval: workspace.requiresApproval,
    instructions: workspace.instructions,
    toolInstructions: workspace.toolInstructions,
    memoryPolicyJson: JSON.stringify(memoryPolicy),
    riskLevel: workspace.riskLevel,
    createdBy: workspace.createdBy,
    manifest: workspace.manifest,
    memoryPolicy,
    toolIds: workspace.tools.map((tool) => tool.id),
    actorId: "creator",
    actorRole: "creator"
  });
}

function updateWorkspaceGate(repos: Repositories, workspaceId: string, patch: { requiresApproval?: number; riskLevel?: "low" | "medium" | "high" }) {
  const workspace = repos.getWorkspace(workspaceId);
  repos.upsertWorkspace({
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    capabilitiesJson: workspace.capabilitiesJson,
    inputKindsJson: workspace.inputKindsJson,
    outputKindsJson: workspace.outputKindsJson,
    requiresApproval: patch.requiresApproval ?? workspace.requiresApproval,
    instructions: workspace.instructions,
    toolInstructions: workspace.toolInstructions,
    memoryPolicyJson: workspace.memoryPolicyJson,
    riskLevel: patch.riskLevel ?? workspace.riskLevel,
    createdBy: workspace.createdBy,
    manifest: workspace.manifest,
    memoryPolicy: workspace.memoryPolicy,
    toolIds: workspace.tools.map((tool) => tool.id),
    actorId: "creator",
    actorRole: "creator"
  });
}

async function testDatabaseAndMemory() {
  const repos = createRepos();
  assert.throws(() => repos.ensureConversation("", "default-agent", "user-a"));
  assert.throws(() => repos.ensureConversation("conv-empty-user", "default-agent", ""));
  repos.ensureConversation("conv-owner", "default-agent", "user-a");
  repos.addMessage("conv-owner", "user", "owner message");
  const ownerConversations = repos.listConversations({ actorId: "user-a", actorRole: "user", agentId: "default-agent" });
  assert.equal(ownerConversations.length, 1);
  assert.equal(ownerConversations[0].id, "conv-owner");
  assert.equal(ownerConversations[0].title, "owner message");
  assert.equal(ownerConversations[0].messageCount, 1);
  assert.equal(ownerConversations[0].lastMessagePreview, "owner message");
  assert.equal(repos.listConversations({ actorId: "other-user", actorRole: "user" }).length, 0);
  assert.equal(repos.listConversationMessages("conv-owner", "user-a", "user").length, 1);
  assert.throws(() => repos.listConversationMessages("conv-owner", "other-user", "user"), /owner/);
  const renamedConversation = repos.updateConversationTitle("conv-owner", "  Renamed   conversation  ", "user-a", "user");
  assert.equal(renamedConversation.title, "Renamed conversation");
  assert.throws(() => repos.updateConversationTitle("conv-owner", "bad", "other-user", "user"), /owner/);
  const tableList = repos.listDatabaseTables("creator");
  const tableNames = new Set(tableList.map((table) => table.name));
  for (const expectedTable of [
    "agents",
    "approval_requests",
    "audit_logs",
    "context_segments",
    "conversations",
    "llm_calls",
    "llm_profiles",
    "mcp_servers",
    "memories",
    "memories_fts",
    "messages",
    "runtime_config",
    "schema_migrations",
    "tool_calls",
    "tool_definitions",
    "users",
    "workspace_sessions",
    "workspace_tools",
    "workspaces"
  ]) {
    assert.equal(tableNames.has(expectedTable), true, `missing database table ${expectedTable}`);
  }
  const assertTableColumns = (table: string, columns: string[]) => {
    const rows = repos.readDatabaseTable(table, { actorRole: "creator", limit: 1, offset: 0 });
    for (const column of columns) {
      assert.equal(rows.columns.includes(column), true, `missing database column ${table}.${column}`);
    }
  };
  assertTableColumns("agents", ["id", "systemPrompt", "personalityPrompt", "defaultModel", "defaultBaseUrl"]);
  assertTableColumns("workspaces", ["id", "capabilitiesJson", "inputKindsJson", "outputKindsJson", "requiresApproval", "memoryPolicyJson", "riskLevel"]);
  assertTableColumns("mcp_servers", ["id", "workspaceId", "transport", "command", "argsJson", "envJson", "url", "headersJson", "timeoutMs"]);
  assertTableColumns("tool_definitions", ["id", "name", "workspaceId", "bindingType", "bindingJson", "mcpServerId", "mcpToolName"]);
  assertTableColumns("tool_calls", ["id", "conversationId", "userId", "workspaceId", "workspaceSessionId", "taskId", "toolName", "argumentsJson", "resultJson", "status"]);
  assertTableColumns("memories", ["id", "memoryType", "userId", "agentId", "workspaceId", "relationId", "version", "metadataJson", "deletedAt"]);
  assertTableColumns("runtime_config", ["key", "category", "valueType", "valueJson", "defaultValueJson", "minValue", "maxValue"]);
  assertTableColumns("llm_calls", ["id", "conversationId", "userId", "providerBaseUrl", "normalizedEndpoint", "messagesJson", "toolsJson", "status", "responseJson", "errorText", "completedAt"]);
  assertTableColumns("context_segments", ["id", "llmCallId", "conversationId", "segmentType", "content", "sortOrder"]);
  assertTableColumns("workspace_sessions", ["id", "conversationId", "userId", "workspaceId", "taskId", "status", "taskJson", "resultJson", "localContextJson"]);
  assert.equal(tableList.some((table) => table.name === "messages" && table.rowCount >= 1), true);
  const messageRows = repos.readDatabaseTable("messages", { actorRole: "creator", limit: 10, offset: 0 });
  assert.equal(messageRows.columns.includes("conversationId"), true);
  assert.equal(messageRows.rows.some((row) => row.conversationId === "conv-owner"), true);
  assert.throws(() => repos.listDatabaseTables("user"));
  assert.throws(() => repos.readDatabaseTable("not_a_real_table", { actorRole: "creator" }));
  repos.ensureConversation("conv-owner", "default-agent", "user-a");
  assert.throws(() => repos.ensureConversation("conv-owner", "default-agent", "user-b"));
  repos.createMemory({
    memoryType: "impression",
    agentId: "other-agent",
    relationId: "impression:agent:other-agent:conversation-owner-test",
    title: "Other agent exists",
    summary: "Other agent fixture",
    detail: "Other agent fixture"
  }, "creator", "creator");
  assert.throws(() => repos.ensureConversation("conv-owner", "other-agent", "user-a"));
  assert.equal(repos.listMessagesDetailed("conv-owner").length, 1);

  const oldEvent = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "dev",
    relationId: "rel-test",
    version: 1,
    title: "Old file search",
    summary: "Old search used npm",
    detail: "Old detail",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "result" })
  }, "creator", "creator");
  const latestEvent = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "dev",
    relationId: "rel-test",
    version: 2,
    title: "Latest file search",
    summary: "Latest search uses ripgrep",
    detail: "Latest detail",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "result" })
  }, "creator", "creator");
  const dottedProcessEvent = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "dev",
    title: "Dotted provider search",
    summary: "Use 302.AI provider evidence when checking memory search.",
    detail: "Dotted tokens such as 302.AI must not break SQLite FTS5.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "process" })
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    title: "Search first",
    summary: "Use ripgrep before editing",
    detail: "Skill detail"
  }, "creator", "creator");
  for (let index = 0; index < 12; index += 1) {
    repos.createMemory({
      memoryType: "skill",
      workspaceId: "dev",
      title: `Noisy search skill ${index}`,
      summary: `Noisy ripgrep search skill ${index}`,
      detail: "These newer skills should not starve event recall."
    }, "creator", "creator");
  }

  const recalled = repos.recallMemories({ userId: "user-a", agentId: "default-agent", workspaceId: "dev", query: "ripgrep search" });
  assert.equal(recalled.some((item) => item.title === "Latest file search"), true);
  assert.equal(recalled.some((item) => item.title === "Old file search"), false);
  assert.equal(recalled.some((item) => item.memoryType === "skill"), true);
  assert.equal(recalled.filter((item) => item.memoryType === "skill").length, 8);
  assert.equal(recalled.filter((item) => item.memoryType === "event").some((item) => item.id === latestEvent.id), true);
  const dottedList = repos.listMemories({ query: "302.AI", userId: "user-a", workspaceId: "dev" });
  assert.equal(dottedList.some((item) => item.id === dottedProcessEvent.id), true);
  const dottedRecall = repos.recallMemories({ userId: "user-a", agentId: "default-agent", workspaceId: "dev", query: "302.AI", resultEventLimit: 0, skillLimit: 0 });
  assert.equal(dottedRecall.some((item) => item.id === dottedProcessEvent.id), true);

  const collisionLatest = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "dev",
    relationId: "rel-collision",
    version: 2,
    title: "Scoped collision latest",
    summary: "Scoped collision ripgrep search should stay visible.",
    detail: "Current partition relation collision fixture.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "result" })
  }, "creator", "creator");
  const otherUserCollision = repos.createMemory({
    memoryType: "event",
    userId: "user-b",
    workspaceId: "dev",
    relationId: "rel-collision",
    version: 99,
    title: "Other user same relation",
    summary: "Other user ripgrep search should not hide user-a relation.",
    detail: "Cross-user relation collision fixture.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "result" })
  }, "creator", "creator");
  const otherWorkspaceCollision = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "other-workspace",
    relationId: "rel-collision",
    version: 100,
    title: "Other workspace same relation",
    summary: "Other workspace ripgrep search should not hide file relation.",
    detail: "Cross-workspace relation collision fixture.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-owner", eventKind: "result" })
  }, "creator", "creator");
  const otherTypeCollision = repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "rel-collision",
    version: 101,
    title: "Other type same relation",
    summary: "Other memory type ripgrep search should not hide event relation.",
    detail: "Cross-type relation collision fixture."
  }, "creator", "creator");
  const collidedRecall = repos.recallMemories({ userId: "user-a", agentId: "default-agent", workspaceId: "dev", query: "ripgrep search" });
  assert.equal(collidedRecall.some((item) => item.id === collisionLatest.id), true);
  assert.equal(collidedRecall.some((item) => item.title === "Other user same relation"), false);
  assert.equal(collidedRecall.some((item) => item.title === "Other workspace same relation"), false);
  assert.equal(collidedRecall.some((item) => item.title === "Other type same relation"), true);
  assert.equal(repos.getMemoryByRelation("event", "rel-collision", { userId: "user-a", agentId: "default-agent", workspaceId: "dev" })?.id, collisionLatest.id);
  assert.equal(repos.getMemoryByRelation("event", "rel-collision", { userId: "user-b", agentId: "default-agent", workspaceId: "dev" })?.id, otherUserCollision.id);
  assert.equal(repos.getMemoryByRelation("event", "rel-collision", { userId: "user-a", agentId: "default-agent", workspaceId: "other-workspace" })?.id, otherWorkspaceCollision.id);
  assert.equal(repos.getMemoryByRelation("skill", "rel-collision", { agentId: "default-agent", workspaceId: "dev" })?.id, otherTypeCollision.id);
  assert.equal(repos.getMemoryByRelation("event", "rel-collision", { userId: "missing-user", agentId: "default-agent", workspaceId: "dev" }), undefined);
  assert.throws(
    () => (repos.getMemoryByRelation as unknown as (memoryType: string, relationId: string) => unknown)("event", "rel-collision"),
    /explicit userId\/agentId\/workspaceId scope/
  );

  repos.deleteMemory(latestEvent.id, "creator", "creator", "superseded event cleanup");
  const afterSoftDelete = repos.recallMemories({ userId: "user-a", agentId: "default-agent", workspaceId: "dev", query: "ripgrep search" });
  assert.equal(afterSoftDelete.some((item) => item.id === latestEvent.id), false);
  assert.equal(afterSoftDelete.some((item) => item.id === oldEvent.id), true);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "user-a", workspaceId: "dev" }).some((item) => item.id === latestEvent.id), false);
  assert.throws(() => repos.getMemory(latestEvent.id));
  const deletedLatest = repos.getMemoryIncludingDeleted(latestEvent.id);
  assert.equal(Boolean(deletedLatest.deletedAt), true);
  assert.equal(deletedLatest.deletedBy, "creator");
  assert.equal(deletedLatest.deleteReason, "superseded event cleanup");
  assert.equal(repos.getMemoryByRelation("event", "rel-test", { userId: "user-a", agentId: "default-agent", workspaceId: "dev" })?.id, oldEvent.id);

  for (let index = 0; index < 25; index += 1) {
    repos.createMemory({
      memoryType: "impression",
      userId: "user-a",
      relationId: `impression:user-a:fixed:${index}`,
      title: `Fixed impression ${index}`,
      summary: "Stable impression loaded without query selection.",
      detail: "This impression intentionally does not match the current query."
    }, "creator", "creator");
  }
  const fixedImpressions = repos.recallMemories({
    userId: "user-a",
    agentId: "default-agent",
    workspaceId: "dev",
    query: "phrase that matches no impression",
    impressionLimit: 20,
    eventLimit: 0,
    skillLimit: 0
  });
  assert.equal(fixedImpressions.filter((item) => item.memoryType === "impression").length, 20);

  const memory = repos.createMemory({
    memoryType: "impression",
    userId: "user-a",
    title: "Language",
    summary: "Prefers Chinese",
    detail: "Use Chinese for planning"
  }, "creator", "creator");
  repos.updateMemory(memory.id, { summary: "Prefers Chinese for architecture" }, "creator", "creator");
  assert.equal(repos.getMemory(memory.id).summary, "Prefers Chinese for architecture");
  repos.deleteMemory(memory.id, "creator", "creator");
  assert.throws(() => repos.getMemory(memory.id));
  assert.equal(repos.getMemoryIncludingDeleted(memory.id).deletedBy, "creator");
}

async function testAgentUpdateRequiresCreatorRole() {
  const repos = createRepos();
  const agent = repos.getAgent("default-agent");
  assert.equal(repos.listAgents().some((item) => item.id === "default-agent"), true);

  assert.throws(() => repos.createAgent({
    id: "user-agent",
    name: "User Agent",
    systemPrompt: agent.systemPrompt,
    personalityPrompt: agent.personalityPrompt,
    defaultModel: agent.defaultModel,
    defaultBaseUrl: agent.defaultBaseUrl,
    actorId: "ordinary-user",
    actorRole: "user"
  }), /creator role/);

  const created = repos.createAgent({
    id: "creator-agent",
    name: "Creator Agent",
    systemPrompt: agent.systemPrompt,
    personalityPrompt: agent.personalityPrompt,
    defaultModel: "qwen3.6-35b-a3b",
    defaultBaseUrl: "https://api.302ai.com",
    actorId: "creator",
    actorRole: "creator"
  });
  assert.equal(created.id, "creator-agent");
  assert.equal(created.defaultModel, "qwen3.6-35b-a3b");
  assert.equal(repos.listAuditLogs({ limit: 20 }).some((log) => log.action === "agent_create" && log.resourceId === "creator-agent"), true);

  assert.throws(() => repos.updateAgent({
    ...agent,
    name: "User-mutated agent",
    actorId: "ordinary-user",
    actorRole: "user"
  }), /creator role/);

  const updated = repos.updateAgent({
    ...agent,
    name: "Creator-mutated agent",
    defaultModel: "gpt-5-mini",
    actorId: "creator",
    actorRole: "creator"
  });
  assert.equal(updated.name, "Creator-mutated agent");
  assert.equal(repos.listAuditLogs({ limit: 20 }).some((log) => log.action === "agent_update" && log.resourceId === "default-agent"), true);
}

async function testHttpActorParsingRequiresExplicitIdentity() {
  assert.throws(() => parseActor({}, "Trace API"), /actorId/);
  assert.throws(() => parseActor({ actorId: "user-a" }, "Trace API"), /actorRole/);
  assert.throws(() => parseActor({ actorId: "user-a", actorRole: "system" }, "Trace API"), /actorRole/);

  assert.deepEqual(parseActor({
    actorId: " user-a ",
    actorRole: "user"
  }, "Trace API"), {
    actorId: "user-a",
    actorRole: "user"
  });

  const params = new URLSearchParams({ actorId: "creator", actorRole: "creator" });
  assert.deepEqual(parseActorFromSearchParams(params, "LLM log API"), {
    actorId: "creator",
    actorRole: "creator"
  });
}

async function testSensitiveHttpEndpointsRequireExplicitActor() {
  const repos = createRepos();
  repos.ensureConversation("conv-http-actor", "default-agent", "http-owner");
  const approval = repos.createApprovalRequest({
    userId: "http-owner",
    conversationId: "conv-http-actor",
    workspaceId: "dev",
    toolName: "runCommand",
    argumentsJson: "{}",
    reason: "HTTP actor boundary fixture"
  });
  const memory = repos.createMemory({
    memoryType: "impression",
    userId: "http-owner",
    title: "HTTP actor memory",
    summary: "HTTP actor boundary fixture.",
    detail: "This memory must not be mutated without an explicit actor.",
    metadataJson: JSON.stringify({ source: "httpActorTest", impressionKind: "userImpression" })
  }, "creator", "creator");
  const originalAgentName = repos.getAgent("default-agent").name;

  const workspaceBody = {
    id: "http-actor-workspace",
    name: "HTTP Actor Workspace",
    description: "Should never be created without explicit actor.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "HTTP actor boundary.",
    toolInstructions: "HTTP actor boundary.",
    memoryPolicyJson: JSON.stringify({
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    }),
    riskLevel: "low",
    createdBy: "creator",
    manifest: {
      id: "http-actor-workspace",
      name: "HTTP Actor Workspace",
      description: "Should never be created without explicit actor.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy: {
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    },
    toolIds: []
  };

  const requestWithBody = (method: string, body: Record<string, unknown>): RequestInit => ({
    method,
    body: JSON.stringify(body)
  });
  const sensitiveEndpoints: Array<{
    label: string;
    path: string;
    init: RequestInit;
    invalidRolePath?: string;
    invalidRoleBody?: Record<string, unknown>;
  }> = [
    { label: "llm logs", path: "/api/llm-calls", init: { method: "GET" } },
    { label: "approval list", path: "/api/approvals", init: { method: "GET" } },
    { label: "approval resolve", path: `/api/approvals/${approval.id}/resolve`, init: requestWithBody("POST", { status: "approved" }), invalidRoleBody: { status: "approved" } },
    { label: "agent create", path: "/api/agents", init: requestWithBody("POST", { id: "missing-actor-agent", name: "Missing actor agent", systemPrompt: "sys", personalityPrompt: "person", defaultModel: "gpt-5-mini", defaultBaseUrl: "https://api.302ai.com" }), invalidRoleBody: { id: "invalid-actor-agent", name: "Invalid actor agent", systemPrompt: "sys", personalityPrompt: "person", defaultModel: "gpt-5-mini", defaultBaseUrl: "https://api.302ai.com" } },
    { label: "agent update", path: "/api/agents/default-agent", init: requestWithBody("PUT", { name: "Missing actor agent" }), invalidRoleBody: { name: "Invalid actor agent" } },
    { label: "workspace create", path: "/api/workspaces", init: requestWithBody("POST", workspaceBody), invalidRoleBody: workspaceBody },
    { label: "workspace update", path: "/api/workspaces/dev", init: requestWithBody("PUT", { name: "Missing actor workspace" }), invalidRoleBody: { name: "Invalid actor workspace" } },
    { label: "workspace delete", path: "/api/workspaces/dev", init: requestWithBody("DELETE", { deleteReason: "missing actor" }), invalidRoleBody: { deleteReason: "invalid actor" } },
    { label: "memory list", path: "/api/memories", init: { method: "GET" } },
    { label: "memory create", path: "/api/memories", init: requestWithBody("POST", { memoryType: "impression", userId: "http-owner", title: "Missing actor create", summary: "No actor.", detail: "No actor." }), invalidRoleBody: { memoryType: "impression", userId: "http-owner", title: "Invalid actor create", summary: "Bad actor.", detail: "Bad actor." } },
    { label: "memory update", path: `/api/memories/${memory.id}`, init: requestWithBody("PUT", { summary: "Missing actor mutation" }), invalidRoleBody: { summary: "Invalid actor mutation" } },
    { label: "memory delete", path: `/api/memories/${memory.id}`, init: requestWithBody("DELETE", { deleteReason: "missing actor" }), invalidRoleBody: { deleteReason: "invalid actor" } },
    { label: "conversation trace", path: "/api/conversations/conv-http-actor/trace", init: { method: "GET" } },
    { label: "conversation delete", path: "/api/conversations/conv-http-actor", init: requestWithBody("DELETE", { deleteReason: "missing actor" }), invalidRoleBody: { deleteReason: "invalid actor" } }
  ];

  await withTestHttpServer(repos, async (baseUrl) => {
    for (const endpoint of sensitiveEndpoints) {
      const missing = await httpJson(baseUrl, endpoint.path, endpoint.init);
      assert.notEqual(missing.status, 200, endpoint.label);
      assert.match(String(missing.body.error), /actorId/, endpoint.label);

      const invalidRolePath = endpoint.init.method === "GET"
        ? `${endpoint.path}${endpoint.path.includes("?") ? "&" : "?"}actorId=http-owner&actorRole=system`
        : endpoint.path;
      const invalidRoleInit = endpoint.init.method === "GET"
        ? endpoint.init
        : requestWithBody(String(endpoint.init.method), {
          ...(endpoint.invalidRoleBody ?? {}),
          actorId: "http-owner",
          actorRole: "system"
        });
      const invalid = await httpJson(baseUrl, endpoint.invalidRolePath ?? invalidRolePath, invalidRoleInit);
      assert.notEqual(invalid.status, 200, endpoint.label);
      assert.match(String(invalid.body.error), /actorRole/, endpoint.label);
    }
  });

  assert.equal(repos.getAgent("default-agent").name, originalAgentName);
  assert.throws(() => repos.getWorkspace("http-actor-workspace"), /Workspace not found/);
  assert.equal(repos.getMemory(memory.id).summary, "HTTP actor boundary fixture.");
  assert.equal(repos.getApprovalRequest(approval.id).status, "pending");
  assert.equal(Boolean(repos.getConversation("conv-http-actor")), true);
}

async function testTraceAndToolLogsAreUserScoped() {
  const repos = createRepos();
  repos.ensureConversation("conv-trace-owner", "default-agent", "trace-owner");
  const toolCall = repos.saveToolCall({
    conversationId: "conv-trace-owner",
    userId: "trace-owner",
    workspaceId: "main",
    toolName: "finishTask",
    argumentsJson: "{}",
    resultJson: "{}",
    status: "completed"
  });
  const pendingToolCall = repos.saveToolCall({
    conversationId: "conv-trace-owner",
    userId: "trace-owner",
    workspaceId: "main",
    toolName: "askUser",
    argumentsJson: JSON.stringify({ question: "Need input?" }),
    resultJson: "{}",
    status: "pending"
  });
  assert.equal(repos.getTrace("conv-trace-owner", "trace-owner", "user").toolCalls.some((call) => call.id === pendingToolCall.id && call.status === "pending"), true);
  const completedPendingToolCall = repos.updateToolCallResult(pendingToolCall.id, {
    resultJson: JSON.stringify({ ok: true }),
    status: "completed"
  });
  assert.equal(completedPendingToolCall.status, "completed");
  assert.equal(completedPendingToolCall.resultJson.includes("\"ok\":true"), true);

  const ownerTrace = repos.getTrace("conv-trace-owner", "trace-owner", "user");
  assert.equal(ownerTrace.toolCalls.some((call) => call.id === toolCall.id && call.userId === "trace-owner"), true);
  assert.equal(ownerTrace.toolCalls.some((call) => call.id === pendingToolCall.id && call.status === "completed"), true);
  assert.throws(() => (repos.getTrace as unknown as (conversationId: string) => unknown)("conv-trace-owner"), /explicit actor identity/);
  assert.throws(() => repos.getTrace("conv-trace-owner", "trace-intruder", "user"), /different user/);
  assert.equal(repos.listAuditLogs({ limit: 20 }).some((log) => log.action === "trace_read_rejected" && log.resourceId === "conv-trace-owner"), true);
  assert.throws(() => repos.saveToolCall({
    conversationId: "conv-trace-owner",
    userId: "trace-intruder",
    workspaceId: "main",
    toolName: "finishTask",
    argumentsJson: "{}",
    resultJson: "{}",
    status: "completed"
  }), /conversation owner/);
  const workspaceRuntime = new WorkspaceRuntime(repos);
  assert.throws(() => workspaceRuntime.run({
    run: {
      agentId: "default-agent",
      userId: "trace-intruder",
      userRole: "user",
      conversationId: "conv-trace-owner",
      message: "try to attach another user's workspace session"
    },
    workspaceId: "main",
    objective: "mismatched workspace session"
  }), /conversation owner/);
  assert.throws(() => repos.createApprovalRequest({
    userId: "trace-intruder",
    conversationId: "conv-trace-owner",
    workspaceId: "dev",
    toolName: "runCommand",
    argumentsJson: JSON.stringify({ command: "npm test" }),
    reason: "mismatched approval request"
  }), /conversation owner/);
  assert.equal(repos.listAuditLogs({ limit: 50 }).some((log) => log.action === "workspace_session_write_rejected" && log.resourceId), true);
  assert.equal(repos.listAuditLogs({ limit: 50 }).some((log) => log.action === "approval_request_write_rejected"), true);

  const creatorTrace = repos.getTrace("conv-trace-owner", "creator", "creator");
  assert.equal(creatorTrace.toolCalls.some((call) => call.id === toolCall.id), true);
}

async function testLlmLogsAreUserScoped() {
  const repos = createRepos();
  repos.ensureConversation("conv-llm-owner-a", "default-agent", "llm-owner-a");
  repos.ensureConversation("conv-llm-owner-b", "default-agent", "llm-owner-b");
  const createdAt = new Date().toISOString();

  repos.saveLlmCall({
    id: "llm-owner-a-call",
    conversationId: "conv-llm-owner-a",
    userId: "llm-owner-a",
    providerBaseUrl: "https://api.302ai.com",
    normalizedEndpoint: "https://api.302ai.com/v1/chat/completions",
    model: "gpt-5-mini",
    messagesJson: JSON.stringify([{ role: "user", content: "owner a private prompt" }]),
    toolsJson: "[]",
    status: "completed",
    responseJson: "{}",
    createdAt,
    completedAt: createdAt
  }, []);
  repos.saveLlmCall({
    id: "llm-owner-b-call",
    conversationId: "conv-llm-owner-b",
    userId: "llm-owner-b",
    providerBaseUrl: "https://api.302ai.com",
    normalizedEndpoint: "https://api.302ai.com/v1/chat/completions",
    model: "gpt-5-mini",
    messagesJson: JSON.stringify([{ role: "user", content: "owner b private prompt" }]),
    toolsJson: "[]",
    status: "completed",
    responseJson: "{}",
    createdAt,
    completedAt: createdAt
  }, []);

  const ownerALogs = repos.listLlmCalls(20, "llm-owner-a", "user");
  assert.equal(ownerALogs.some((call) => call.id === "llm-owner-a-call"), true);
  assert.equal(ownerALogs.some((call) => call.id === "llm-owner-b-call"), false);
  const creatorLogs = repos.listLlmCalls(20, "creator", "creator");
  assert.equal(creatorLogs.some((call) => call.id === "llm-owner-a-call"), true);
  assert.equal(creatorLogs.some((call) => call.id === "llm-owner-b-call"), true);
  assert.throws(() => repos.saveLlmCall({
    id: "llm-owner-mismatch",
    conversationId: "conv-llm-owner-a",
    userId: "llm-owner-b",
    providerBaseUrl: "https://api.302ai.com",
    normalizedEndpoint: "https://api.302ai.com/v1/chat/completions",
    model: "gpt-5-mini",
    messagesJson: "[]",
    toolsJson: "[]",
    status: "pending",
    responseJson: "{}",
    createdAt
  }, []), /conversation owner/);
}

async function testApprovalListIsUserScoped() {
  const repos = createRepos();
  const ownerA = repos.createApprovalRequest({
    userId: "approval-owner-a",
    conversationId: "conv-approval-owner-a",
    workspaceId: "dev",
    toolName: "runCommand",
    argumentsJson: JSON.stringify({ command: "npm test" }),
    reason: "owner a approval"
  });
  const ownerB = repos.createApprovalRequest({
    userId: "approval-owner-b",
    conversationId: "conv-approval-owner-b",
    workspaceId: "dev",
    toolName: "writeFile",
    argumentsJson: JSON.stringify({ path: "private.txt" }),
    reason: "owner b approval"
  });

  const ownerAList = repos.listApprovalRequests({
    actorId: "approval-owner-a",
    actorRole: "user",
    limit: 20
  });
  assert.equal(ownerAList.some((request) => request.id === ownerA.id), true);
  assert.equal(ownerAList.some((request) => request.id === ownerB.id), false);

  const ownerATargetingB = repos.listApprovalRequests({
    actorId: "approval-owner-a",
    actorRole: "user",
    userId: "approval-owner-b",
    limit: 20
  });
  assert.equal(ownerATargetingB.some((request) => request.id === ownerB.id), false);

  const creatorList = repos.listApprovalRequests({
    actorId: "creator",
    actorRole: "creator",
    limit: 20
  });
  assert.equal(creatorList.some((request) => request.id === ownerA.id), true);
  assert.equal(creatorList.some((request) => request.id === ownerB.id), true);
}

async function testRuntimeContextAndTools() {
  const repos = createRepos();
  repos.ensureConversation("conv-test", "default-agent", "user");
  repos.addMessage("conv-test", "user", "old global user chat unrelated to file workspace");
  repos.addMessage("conv-test", "assistant", "old global assistant reply unrelated to file workspace");
  repos.createMemory({
    memoryType: "impression",
    userId: "user",
    relationId: "impression:user:user:search-style",
    title: "Search style",
    summary: "User prefers focused runtime search notes",
    detail: "When discussing file searches, keep runtime observations concise."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "event",
    userId: "user",
    workspaceId: "dev",
    relationId: "event:user:file:runtime-search",
    title: "Runtime file search event",
    summary: "Runtime search used file workspace",
    detail: "A previous file workspace task searched runtime files.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-test", eventKind: "result", outcome: "completed" })
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:runtime-search",
    title: "Runtime search skill",
    summary: "Search runtime files before editing",
    detail: "Use focused text search before modifying runtime code.",
    metadataJson: JSON.stringify({ desensitized: true, confidence: 0.8 })
  }, "creator", "creator");
  const fake = new MainToFileLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "user",
    userRole: "creator",
    conversationId: "conv-test",
    message: "search files for runtime",
    llm: {
      baseUrl: "https://api.302.ai",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(output.assistantMessage, "fake response");
  assert.equal(output.activeWorkspaceId, "main");
  assert.equal(normalizeProviderBaseUrl("https://api.302.ai"), "https://api.302ai.com");
  assert.equal(normalizeProviderBaseUrl("http://api.302.ai/v1/chat/completions/"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeProviderBaseUrl("api.302.ai"), "https://api.302ai.com");
  assert.equal(normalizeChatCompletionsEndpoint("https://api.302.ai"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeChatCompletionsEndpoint("https://api.302.ai/v1/chat/completions"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeChatCompletionsEndpoint("api.302.ai"), "https://api.302ai.com/v1/chat/completions");
  const firstInput = fake.inputs[0];
  const childInput = fake.inputs[1];
  const lastInput = fake.inputs.at(-1);
  const agent = repos.getAgent("default-agent");
  assert.equal(firstInput?.baseUrl, "https://api.302ai.com");
  assert.equal(normalizeChatCompletionsEndpoint(firstInput!.baseUrl), "https://api.302ai.com/v1/chat/completions");
  assert.equal(firstInput?.messages.at(-1)?.role, "user");
  assert.equal(firstInput?.messages.at(-1)?.content, "search files for runtime");
  const firstLocalConversationToolMessage = firstInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const firstLocalConversationPayload = JSON.parse(firstLocalConversationToolMessage?.content ?? "{}") as { currentTask: { workspaceId: string }; messages: Array<{ content: string }> };
  assert.equal(firstLocalConversationPayload.currentTask.workspaceId, "main");
  assert.equal(firstLocalConversationPayload.messages.some((message) => message.content.includes("old global user chat unrelated to file workspace")), true);
  const systemMessage = lastInput?.messages[0]?.content ?? "";
  const firstSystemMessage = firstInput?.messages[0]?.content ?? "";
  const childSystemMessage = childInput?.messages[0]?.content ?? "";
  assert.equal(promptSection(firstSystemMessage, "## 基础系统提示词", "## 人格提示词"), agent.systemPrompt);
  assert.equal(promptSection(childSystemMessage, "## 基础系统提示词", "## 人格提示词"), agent.systemPrompt);
  assert.equal(promptSection(systemMessage, "## 基础系统提示词", "## 人格提示词"), agent.systemPrompt);
  assert.equal(promptSection(firstSystemMessage, "## 人格提示词", "## 内部运行策略"), agent.personalityPrompt);
  assert.equal(promptSection(childSystemMessage, "## 人格提示词", "## 内部运行策略"), agent.personalityPrompt);
  assert.equal(promptSection(systemMessage, "## 人格提示词", "## 内部运行策略"), agent.personalityPrompt);
  assert.equal(systemMessage.includes("内部运行策略"), true);
  assert.equal(systemMessage.includes("记忆写入协议"), true);
  assert.equal(systemMessage.includes("writeUserImpression"), true);
  assert.equal(systemMessage.includes("稳定长期偏好"), true);
  assert.equal(systemMessage.includes("不需要等用户说“记住”"), true);
  assert.equal(systemMessage.includes("用户授权的搜索/工具结果确认"), true);
  assert.equal(systemMessage.includes("不要把 agent 自己的名字、身份、职责、人格、能力边界写进 user impression"), true);
  const writeUserImpressionTool = lastInput?.tools.find((tool) => tool.name === "writeUserImpression");
  assert.equal(JSON.stringify(writeUserImpressionTool).includes("用户授权搜索"), true);
  assert.equal(systemMessage.includes("writeSkillMemory"), true);
  assert.equal(systemMessage.includes("readSkill"), true);
  assert.equal(systemMessage.includes("searchMemory 是低频补查工具"), true);
  assert.equal(systemMessage.includes("自动上下文明显不足"), true);
  assert.equal(systemMessage.includes("不要把 searchMemory 当作普通搜索"), true);
  assert.equal(systemMessage.includes("优先用 memoryType 限定"), true);
  assert.equal(systemMessage.includes("readMemory(memoryId)"), true);
  assert.equal(systemMessage.includes("不要凭摘要脑补"), true);
  assert.equal(systemMessage.includes("详细说说"), true);
  assert.equal(systemMessage.includes("必须先读详情"), true);
  assert.equal(systemMessage.includes("你的下一条输出应该是 readMemory 的 function call"), true);
  assert.equal(systemMessage.includes("这是记忆幻觉"), true);
  assert.equal(systemMessage.includes("渐进式披露"), true);
  assert.equal(systemMessage.includes("生命周期 hook"), true);
  assert.equal(systemMessage.includes("writeEventMemory"), false);
  assert.equal(systemMessage.includes("writeAgentSelfImpression"), true);
  assert.equal(systemMessage.includes("不要把用户偏好或用户身份写进 agent self impression"), true);
  assert.equal(systemMessage.includes("用户用中文就用中文"), true);
  assert.equal(systemMessage.includes("不要中英混杂或随意切换语言"), true);
  assert.equal(systemMessage.includes("必须忠于子 workspace 交付的 WorkspaceResult"), true);
  assert.equal(systemMessage.includes("workspace 是内部能力边界"), true);
  assert.equal(systemMessage.includes("产物责任边界"), true);
  assert.equal(systemMessage.includes("不能因为知道用户最终想要什么，就在错误 workspace 中生成文件、网页、报告或其他下游产物"), true);
  assert.equal(childSystemMessage.includes("搜索类 workspace 搜索完就返回搜索结果、来源、可信度和建议"), true);
  assert.equal(childSystemMessage.includes("不要伪造当前工具没有真实产出的 artifacts"), true);
  assert.equal(systemMessage.includes("enterWorkspace"), true);
  assert.equal(systemMessage.includes("exitWorkspace"), true);
  assert.equal(systemMessage.includes("suggestedNextSteps"), true);
  assert.equal(systemMessage.includes("## Callable Tools"), false);
  assert.equal(systemMessage.includes("\"toolCount\""), false);
  assert.equal(systemMessage.includes("\"availableWorkspaces\""), false);
  assert.equal(firstInput?.messages.some((message) => message.role === "tool" && message.name === "runtime_context.workspace"), true);
  assert.equal(/workspace|context|runtime/i.test(agent.personalityPrompt), false);
  assert.equal(firstInput?.tools.some((tool) => tool.name === "enterWorkspace"), true);
  assert.equal(firstInput?.tools.some((tool) => tool.name === "searchFiles"), false);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "runCommand"), false);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "searchFiles"), false);
  assert.equal(childInput?.tools.some((tool) => tool.name === "searchFiles"), true);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "writeUserImpression"), true);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "readMemory"), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "tools" && segment.content.includes("\"name\": \"enterWorkspace\"")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "final_messages"), true);
  const firstWorkspaceToolMessage = firstInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.workspace");
  assert.equal(firstWorkspaceToolMessage?.content?.includes("\"id\": \"main\""), true);
  assert.equal(firstWorkspaceToolMessage?.content?.includes("\"id\": \"dev\""), true);
  assert.equal(firstWorkspaceToolMessage?.content?.includes("\"id\": \"file\""), false);
  assert.equal(firstWorkspaceToolMessage?.content?.includes("\"id\": \"cli\""), false);
  const childWorkspaceToolMessage = childInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.workspace");
  assert.equal(childWorkspaceToolMessage?.content?.includes("\"id\": \"dev\""), true);
  const childWorkspacePayload = JSON.parse(childWorkspaceToolMessage?.content ?? "{}") as {
    currentWorkspace?: { id?: string };
    availableWorkspaces?: Array<{ id?: string }>;
  };
  assert.equal(childWorkspacePayload.currentWorkspace?.id, "dev");
  assert.equal(childWorkspacePayload.availableWorkspaces?.some((workspace) => workspace.id === "main"), true);
  assert.equal(childWorkspacePayload.availableWorkspaces?.some((workspace) => workspace.id === "dev"), true);
  assert.equal(childInput?.tools.some((tool) => tool.name === "enterWorkspace"), false);
  assert.equal(childInput?.tools.some((tool) => tool.name === "askUser"), false);
  assert.equal(childInput?.tools.some((tool) => tool.name === "finishTask"), false);
  assert.equal(childInput?.tools.some((tool) => tool.name === "exitWorkspace"), true);
  const childTraceForTools = repos.getTrace("conv-test", "creator", "creator");
  const childWorkspaceSegment = childTraceForTools.contextSegments.find((segment) => {
    if (segment.segmentType !== "workspace") return false;
    const payload = JSON.parse(segment.content) as { currentWorkspace?: { id?: string } };
    return payload.currentWorkspace?.id === "dev";
  });
  assert.equal(Boolean(childWorkspaceSegment), true);
  const childLlmCall = childTraceForTools.llmCalls.find((call) => call.id === childWorkspaceSegment?.llmCallId);
  const childPersistedTools = JSON.parse(childLlmCall?.toolsJson ?? "[]") as Array<{ name?: string }>;
  assert.equal(childPersistedTools.some((tool) => tool.name === "enterWorkspace"), false);
  assert.equal(childPersistedTools.some((tool) => tool.name === "askUser"), false);
  assert.equal(childPersistedTools.some((tool) => tool.name === "finishTask"), false);
  assert.equal(childPersistedTools.some((tool) => tool.name === "exitWorkspace"), true);
  const lastWorkspaceToolMessage = lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.workspace");
  assert.equal(lastWorkspaceToolMessage?.content?.includes("\"id\": \"dev\""), true);
  assert.equal(childWorkspaceToolMessage?.content?.includes("memoryPolicy"), true);
  assert.equal(childWorkspaceToolMessage?.content?.includes("maxEventMemories"), true);
  assert.equal(childInput?.messages.some((message) => message.role === "tool" && message.name === "runtime_context.local_conversation" && (message.content ?? "").includes("\"workspaceId\": \"dev\"")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "history" && segment.content.includes("\"suggestedNextSteps\"")), true);
  assert.equal(output.workspaceTrace[1].localContext.recalledSkillMemories.some((memory) => memory.title === "Runtime search skill"), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Search style")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("\"readTool\": \"readMemory\"")), true);
  assert.equal(output.workspaceTrace[1].localContext.recalledEventMemories.some((memory) => memory.title === "Runtime file search event"), true);
  assert.equal(childInput?.messages.some((message) => message.role === "tool" && message.name === "runtime_context.local_conversation"), true);
  const childLocalConversationToolMessage = childInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const childLocalConversationPayload = JSON.parse(childLocalConversationToolMessage?.content ?? "{}") as { messages: Array<{ content?: string }>; crossWorkspaceHandoffContext?: unknown[]; recentToolEvidence: unknown[] };
  assert.equal(childLocalConversationPayload.messages.length, 0);
  assert.equal(childLocalConversationPayload.messages.some((message) => String(message.content ?? "").includes("old global user chat unrelated to file workspace")), false);
  assert.equal(JSON.stringify(childLocalConversationPayload.crossWorkspaceHandoffContext).includes("old global user chat unrelated to file workspace"), true);
  assert.equal(childLocalConversationPayload.recentToolEvidence.length, 0);
  assert.equal(childInput?.messages[0]?.content?.includes("\"name\": \"searchFiles\""), false);
  assert.equal(childInput?.messages[0]?.content?.includes("\"bindingType\": \"runtime\""), false);
  assert.equal(childInput?.tools.some((tool) => tool.name === "searchFiles"), true);
  const memoryToolMessage = childInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.memory");
  const memoryPayload = JSON.parse(memoryToolMessage?.content ?? "{}") as {
    memoryDisclosureProtocol: { defaultDisclosure: string; detailInjectedByDefault: boolean; ordinaryMemoryReadTool: string; activeReadTriggers?: string[]; rules: string[] };
    crossWorkspaceImpressionMemory: Array<Record<string, unknown>>;
    currentWorkspaceResultEvents: unknown[];
    currentWorkspaceRelevantProcessEvents: unknown[];
    currentWorkspaceSkillMemory: unknown[];
  };
  assert.equal(memoryPayload.memoryDisclosureProtocol.defaultDisclosure, "summary_only");
  assert.equal(memoryPayload.memoryDisclosureProtocol.detailInjectedByDefault, false);
  assert.equal(memoryPayload.memoryDisclosureProtocol.ordinaryMemoryReadTool, "readMemory");
  assert.equal(memoryPayload.memoryDisclosureProtocol.rules.some((rule) => rule.includes("必须先调用 readMemory")), true);
  assert.equal(memoryPayload.memoryDisclosureProtocol.rules.some((rule) => rule.includes("正例")), true);
  assert.equal(memoryPayload.memoryDisclosureProtocol.activeReadTriggers?.some((trigger) => trigger.includes("详细说说")), true);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.length, 1);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory[0].disclosure, "summary_only");
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory[0].detailInjected, false);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory[0].detailAvailable, true);
  assert.equal(String(memoryPayload.crossWorkspaceImpressionMemory[0].readInstruction ?? "").includes("先调用 readMemory"), true);
  assert.equal(memoryPayload.currentWorkspaceResultEvents.length, 1);
  assert.equal(memoryPayload.currentWorkspaceRelevantProcessEvents.length, 0);
  assert.equal(memoryPayload.currentWorkspaceSkillMemory.length, 1);
  assert.equal(output.workspaceTrace.length, 2);
  assert.equal(repos.getWorkspace("dev").manifest.requiresApproval, false);
  assert.equal(repos.getWorkspace("dev").manifest.capabilities.length > 0, true);
  assert.equal(repos.getWorkspace("dev").memoryPolicy.eventRecallEnabled, true);
  assert.equal(output.workspaceTrace[1].task.workspaceId, "dev");
  assert.equal(output.workspaceTrace[1].task.constraints.some((constraint) => constraint.includes("只完成当前 workspace 能力范围内的任务切片")), true);
  assert.equal(output.workspaceTrace[1].task.constraints.some((constraint) => constraint.includes("不要声明当前工具没有真实产出的文件、网页、报告或其他 artifacts")), true);
  assert.equal(output.workspaceTrace[1].result.workspaceId, "dev");
  assert.equal(output.workspaceTrace[1].result.suggestedNextSteps.length > 0, true);
  assert.equal(output.workspaceTrace[1].localContext.recalledEventMemories.some((memory) => memory.title === "Runtime file search event"), true);
  assert.equal(output.workspaceTrace[1].localContext.recalledSkillMemories.some((memory) => memory.title === "Runtime search skill"), true);
  assert.equal(output.workspaceTrace[1].localContext.availableTools.some((tool) => tool.name === "searchFiles"), true);
  const trace = repos.getTrace("conv-test", "creator", "creator");
  const mainSession = trace.sessions.find((session) => session.workspaceId === "main");
  assert.equal(mainSession?.status, "completed");
  assert.equal(mainSession?.result.summary, "fake response");
  assert.equal(trace.auditLogs.some((log) => log.action === "main_workspace_direct_response_committed"), true);
  assert.equal(trace.llmCalls.length >= 4, true);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("\"plannedWorkspace\":\"dev\"")), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("\"ok\":true")), true);
  assert.equal(JSON.stringify({
    llmCalls: trace.llmCalls,
    contextSegments: trace.contextSegments,
    auditLogs: trace.auditLogs
  }).includes("test-key"), false);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "tool_result" && segment.content.includes("enterWorkspace")), true);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "tools" && segment.content.includes("\"activeWorkspaceId\": \"dev\"") && segment.content.includes("\"name\": \"searchFiles\"")), true);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "tools" && segment.content.includes("\"activeWorkspaceId\": \"main\"") && segment.content.includes("\"name\": \"enterWorkspace\"")), true);
  const fileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.task.objective, "search files for runtime");
  assert.equal(fileSession?.result.status, "completed");
  assert.equal(typeof fileSession?.completedAt, "string");
  assert.equal(fileSession?.localContext.recalledEventMemories.some((memory) => memory.title === "Runtime file search event"), true);
  assert.equal(fileSession?.localContext.recalledSkillMemories.some((memory) => memory.title === "Runtime search skill"), true);
  assert.equal(fileSession?.result.observations.some((item) => item.includes("direct response")), true);
  const actions = trace.auditLogs.map((log) => log.action);
  const userMessageAudit = trace.auditLogs.find((log) => log.action === "user_message_received");
  assert.ok(userMessageAudit);
  assert.equal(userMessageAudit.actorId, "user");
  assert.equal(userMessageAudit.resourceKind, "message");
  assert.equal(userMessageAudit.conversationId, "conv-test");
  assert.equal(userMessageAudit.metadataJson.includes("search files for runtime"), false);
  assert.equal(JSON.parse(userMessageAudit.metadataJson).contentLength, "search files for runtime".length);
  assert.equal(actions.includes("hook.beforeAgentTurn"), true);
  assert.equal(actions.includes("hook.afterAgentTurn"), true);
  assert.equal(actions.includes("hook.beforeWorkspaceEnter"), true);
  assert.equal(actions.includes("workspace_exit_required"), true);
  assert.equal(actions.includes("hook.afterWorkspaceExit"), true);
  const afterAgentTurnAudit = trace.auditLogs.find((log) => log.action === "hook.afterAgentTurn");
  assert.ok(afterAgentTurnAudit);
  const afterAgentTurnMetadata = JSON.parse(afterAgentTurnAudit.metadataJson) as { tokenUsage?: Record<string, unknown> };
  assert.equal(afterAgentTurnMetadata.tokenUsage?.prompt_tokens, 123);
  assert.equal(afterAgentTurnMetadata.tokenUsage?.completion_tokens, 45);
  assert.equal(afterAgentTurnMetadata.tokenUsage?.total_tokens, 168);
}

async function testLlmMemoryContextUsesWorkspaceSessionRecall() {
  const repos = createRepos();
  repos.createMemory({
    memoryType: "event",
    userId: "session-recall-user",
    workspaceId: "dev",
    relationId: "event:session-recall-user:file:objective-only",
    title: "Objective-only file event",
    summary: "inspect file evidence with objective-only recall",
    detail: "This memory should be found by the child WorkspaceTask objective, not by the vague user message.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-session-context-recall", eventKind: "process" })
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:objective-only",
    title: "Objective-only file skill",
    summary: "inspect file evidence before returning a workspace result",
    detail: "This skill should travel from WorkspaceSession.localContext into the actual LLM context.",
    metadataJson: JSON.stringify({ desensitized: true, confidence: 0.8 })
  }, "creator", "creator");

  const fake = new MainToFileExitToMainLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "session-recall-user",
    userRole: "creator",
    conversationId: "conv-session-context-recall",
    message: "please handle this request",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  const fileSession = output.workspaceTrace.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.localContext.recalledEventMemories.some((memory) => memory.title === "Objective-only file event"), true);
  assert.equal(fileSession?.localContext.recalledSkillMemories.some((memory) => memory.title === "Objective-only file skill"), true);
  const childInput = fake.inputs[1];
  const childMemoryToolMessage = childInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.memory");
  const childMemoryPayload = JSON.parse(childMemoryToolMessage?.content ?? "{}") as {
    currentWorkspaceResultEvents: Array<Record<string, unknown>>;
    currentWorkspaceRelevantProcessEvents: Array<Record<string, unknown>>;
    currentWorkspaceSkillMemory: Array<Record<string, unknown>>;
  };
  assert.equal(childMemoryPayload.currentWorkspaceRelevantProcessEvents.some((memory) => memory.title === "Objective-only file event"), true);
  const recalledProcessProjection = childMemoryPayload.currentWorkspaceRelevantProcessEvents.find((memory) => memory.title === "Objective-only file event");
  assert.equal(Boolean(recalledProcessProjection?.detailSnippet), false);
  assert.equal(JSON.stringify(recalledProcessProjection).includes("This memory should be found by the child WorkspaceTask objective"), false);
  assert.equal(recalledProcessProjection?.readTool, "readMemory");
  assert.equal(recalledProcessProjection?.detailInjected, false);
  assert.equal(childMemoryPayload.currentWorkspaceSkillMemory.some((memory) => memory.title === "Objective-only file skill"), true);
  assert.equal(JSON.stringify(childMemoryPayload.currentWorkspaceSkillMemory).includes("This skill should travel"), false);
  assert.equal(JSON.stringify(childMemoryPayload.currentWorkspaceSkillMemory).includes("summary_only"), true);
  const trace = repos.getTrace("conv-session-context-recall", "creator", "creator");
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Objective-only file event")), true);
  const fileRecallLog = trace.auditLogs.find((log) => log.action === "memory_recall_requested" && log.workspaceId === "dev");
  assert.ok(fileRecallLog);
  const fileRecallMetadata = JSON.parse(fileRecallLog.metadataJson) as {
    algorithm: string;
    vectorEnabled: boolean;
    query: string;
    rawHitCount: number;
    injectedPartitionCounts: { event: number; processEvent: number; skill: number };
    hitIds: { resultEvents: string[]; processEvents: string[]; skills: string[] };
  };
  assert.equal(fileRecallMetadata.algorithm, "sqlite_fts_relation_version");
  assert.equal(fileRecallMetadata.vectorEnabled, false);
  assert.equal(fileRecallMetadata.query.includes("inspect file evidence"), true);
  assert.equal(fileRecallMetadata.rawHitCount >= 2, true);
  assert.equal(fileRecallMetadata.injectedPartitionCounts.event, 1);
  assert.equal(fileRecallMetadata.injectedPartitionCounts.processEvent, 1);
  assert.equal(fileRecallMetadata.injectedPartitionCounts.skill, 1);
  assert.equal(fileRecallMetadata.hitIds.processEvents.length, 1);
}

async function testMemoryRecallAuditLogsZeroHits() {
  const repos = createRepos();
  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  await runtime.run({
    agentId: "default-agent",
    userId: "recall-log-user",
    userRole: "creator",
    conversationId: "conv-recall-log-zero",
    message: "what is my name?",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  const trace = repos.getTrace("conv-recall-log-zero", "creator", "creator");
  const recallLog = trace.auditLogs.find((log) => log.action === "memory_recall_requested" && log.workspaceId === "main");
  assert.ok(recallLog);
  const metadata = JSON.parse(recallLog.metadataJson) as {
    algorithm: string;
    vectorEnabled: boolean;
    rawHitCount: number;
    injectedHitCount: number;
    injectedPartitionCounts: { impression: number; event: number; resultEvent: number; processEvent: number; skill: number };
  };
  assert.equal(metadata.algorithm, "sqlite_fts_relation_version");
  assert.equal(metadata.vectorEnabled, false);
  assert.equal(metadata.rawHitCount, 0);
  assert.equal(metadata.injectedHitCount, 0);
  assert.deepEqual(metadata.injectedPartitionCounts, { impression: 0, event: 0, resultEvent: 0, processEvent: 0, skill: 0 });
}

async function testAuditLogsStayOutOfModelContext() {
  const repos = createRepos();
  repos.ensureConversation("conv-audit-not-context", "default-agent", "audit-context-user");
  repos.audit("audit-context-user", "system", "audit_only_secret_marker", "conversation", "conv-audit-not-context", {
    conversationId: "conv-audit-not-context",
    workspaceId: "main",
    secretMarker: "AUDIT_ONLY_MARKER_SHOULD_NOT_ENTER_MODEL_CONTEXT"
  });

  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  await runtime.run({
    agentId: "default-agent",
    userId: "audit-context-user",
    userRole: "creator",
    conversationId: "conv-audit-not-context",
    message: "plain audit boundary request",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  const trace = repos.getTrace("conv-audit-not-context", "creator", "creator");
  assert.equal(trace.auditLogs.some((log) => log.action === "audit_only_secret_marker"), true);
  assert.equal(JSON.stringify(fake.lastInput?.messages ?? []).includes("AUDIT_ONLY_MARKER_SHOULD_NOT_ENTER_MODEL_CONTEXT"), false);
  assert.equal(trace.contextSegments.some((segment) => segment.content.includes("AUDIT_ONLY_MARKER_SHOULD_NOT_ENTER_MODEL_CONTEXT")), false);
}

async function testAttentionBudgetTrimsHistoryButKeepsJson() {
  const repos = createRepos();
  const conversationId = "conv-attention-budget";
  repos.ensureConversation(conversationId, "default-agent", "budget-user");
  for (let index = 0; index < 12; index += 1) {
    repos.addMessage(conversationId, index % 2 === 0 ? "user" : "assistant", `long-history-${index} ${"x".repeat(900)}`);
  }

  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  await runtime.run({
    agentId: "default-agent",
    userId: "budget-user",
    userRole: "creator",
    conversationId,
    message: "short request",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  const historyToolMessage = fake.lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const historyContent = historyToolMessage?.content ?? "";
  const parsedHistory = JSON.parse(historyContent) as { messages: unknown[] };
  assert.equal(Array.isArray(parsedHistory.messages), true);
  assert.equal(historyContent.includes("truncated by attention budget"), true);
  assert.equal(historyContent.length < 9000, true);

  const historySegment = repos.getTrace(conversationId, "creator", "creator").contextSegments.find((segment) => segment.segmentType === "history");
  assert.equal((historySegment?.tokenEstimate ?? 0) <= 2200, true);
  const mainSession = repos.getTrace(conversationId, "creator", "creator").sessions.find((session) => session.workspaceId === "main");
  assert.equal(mainSession?.status, "completed");
  assert.equal(mainSession?.result.summary, "fake response");
}

async function testAgentSelfImpressionRecallIsAgentScoped() {
  const repos = createRepos();
  repos.createMemory({
    memoryType: "impression",
    userId: "agent-scope-user",
    relationId: "impression:user:agent-scope-user:self-recall",
    title: "Current user recall",
    summary: "current user impression must be recalled with agent self impressions",
    detail: "The default agent should see the current user's impression."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "impression",
    userId: "other-user",
    relationId: "impression:user:other-user:self-recall",
    title: "Other user recall leak",
    summary: "other user impression must not be recalled",
    detail: "The default agent must not see another user's impression."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "impression",
    agentId: "default-agent",
    relationId: "impression:agent:default-agent:self-recall",
    title: "Default self recall",
    summary: "self recall target belongs to the default agent",
    detail: "The default agent should see this self impression."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "impression",
    agentId: "other-agent",
    relationId: "impression:agent:other-agent:self-recall",
    title: "Other self recall",
    summary: "self recall target belongs to a different agent",
    detail: "The default agent must not see this self impression."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "impression",
    relationId: "impression:global:self-recall",
    title: "Global self recall leak",
    summary: "self recall target should not come from unscoped global impression",
    detail: "Impressions must be user-scoped or agent-scoped."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "impression",
    userId: "agent-scope-user",
    agentId: "other-agent",
    relationId: "impression:ambiguous:self-recall",
    title: "Ambiguous self recall leak",
    summary: "self recall target should not come from an impression with both user and agent scope",
    detail: "Impressions must target exactly one scope."
  }, "creator", "creator");

  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "agent-scope-user",
    userRole: "creator",
    conversationId: "conv-agent-self-scope",
    message: "search files self recall target",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  const memoryToolMessage = fake.lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.memory");
  const memoryPayload = JSON.parse(memoryToolMessage?.content ?? "{}") as { crossWorkspaceImpressionMemory: Array<{ title: string }> };
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Current user recall"), true);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Other user recall leak"), false);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Default self recall"), true);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Other self recall"), false);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Global self recall leak"), false);
  assert.equal(memoryPayload.crossWorkspaceImpressionMemory.some((memory) => memory.title === "Ambiguous self recall leak"), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Default self recall")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Other self recall")), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Global self recall leak")), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Ambiguous self recall leak")), false);
}

async function testWorkspaceExitReturnsToMain() {
  const repos = createRepos();
  repos.ensureConversation("conv-workspace-exit", "default-agent", "workspace-exit-user");
  repos.addMessage("conv-workspace-exit", "user", "old unrelated file task");
  repos.addMessage("conv-workspace-exit", "assistant", "old unrelated file answer");
  repos.addMessage("conv-workspace-exit", "user", "older same-workspace follow up");
  const staleMessageIds = new Set(repos.listMessagesDetailed("conv-workspace-exit", 20).map((message) => message.id));
  const staleToolCall = repos.saveToolCall({
    conversationId: "conv-workspace-exit",
    userId: "workspace-exit-user",
    workspaceId: "dev",
    workspaceSessionId: "old-file-session",
    taskId: "old-file-task",
    toolName: "searchFiles",
    argumentsJson: JSON.stringify({ query: "old evidence" }),
    resultJson: JSON.stringify({ ok: true, results: ["old-result"] }),
    status: "completed"
  });
  const recalledSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:workspace-exit-usage",
    title: "Evidence inspection skill",
    summary: "When a file task asks to inspect evidence, search available files before returning a result.",
    detail: "Reusable file workspace guidance for inspecting evidence before reporting back to main.",
    metadataJson: JSON.stringify({
      desensitized: true,
      confidence: 0.76,
      usageCount: 1,
      successCount: 1,
      failureCount: 0,
      qualityGate: {
        reusable: true,
        userPrivateDetailRemoved: true,
        workspaceScoped: true,
        evidenceCount: 0
      },
      procedure: ["Search available evidence.", "Return structured observations to main."],
      appliesWhen: ["A file workspace task asks to inspect evidence."],
      avoidWhen: ["The task depends on private project identifiers."]
    })
  }, "creator", "creator");
  const fake = new MainToFileExitToMainLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "workspace-exit-user",
    userRole: "creator",
    conversationId: "conv-workspace-exit",
    message: "inspect file evidence then answer",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(fake.calls, 3);
  const childLocalMessage = fake.inputs[1]?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const childLocalPayload = JSON.parse(childLocalMessage?.content ?? "{}") as { crossWorkspaceHandoffContext?: Array<{ direction: string; items: Array<{ kind: string; content: string }> }> };
  assert.equal(childLocalPayload.crossWorkspaceHandoffContext?.some((packet) => packet.direction === "parent_to_child"), true);
  const childHandoffJson = JSON.stringify(childLocalPayload.crossWorkspaceHandoffContext);
  assert.equal(childHandoffJson.includes("inspect file evidence then answer"), true);
  assert.equal(childHandoffJson.includes("\"kind\":\"tool_call\""), false);
  assert.equal(childHandoffJson.includes("enterWorkspace"), false);
  assert.equal(childHandoffJson.includes("父工作空间工具结果"), false);
  assert.equal(childHandoffJson.includes("总体要求与工作空间入口任务"), true);
  assert.equal(childHandoffJson.includes("old unrelated file task"), true);
  assert.equal(childHandoffJson.includes("older same-workspace follow up"), true);
  assert.equal(childHandoffJson.includes("old unrelated file answer"), false);
  const returnedMainLocalMessage = fake.inputs[2]?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const returnedMainPayload = JSON.parse(returnedMainLocalMessage?.content ?? "{}") as { crossWorkspaceHandoffContext?: Array<{ direction: string; items: Array<{ kind: string; title: string; content: string }> }> };
  assert.equal(returnedMainPayload.crossWorkspaceHandoffContext?.some((packet) => packet.direction === "child_to_parent"), true);
  assert.equal(JSON.stringify(returnedMainPayload.crossWorkspaceHandoffContext).includes("File workspace inspected available evidence"), true);
  assert.equal(JSON.stringify(returnedMainPayload.crossWorkspaceHandoffContext).includes("子工作空间 AI 回复摘要"), true);
  assert.equal(JSON.stringify(returnedMainPayload.crossWorkspaceHandoffContext).includes("确认可以把搜索结论和后续建议交回 main"), true);
  assert.equal(JSON.stringify(returnedMainPayload.crossWorkspaceHandoffContext).includes("\"kind\":\"tool_call\""), false);
  assert.equal(JSON.stringify(returnedMainPayload.crossWorkspaceHandoffContext).includes("enterWorkspace"), false);
  assert.equal(output.assistantMessage, "main integrated file result");
  assert.equal(output.activeWorkspaceId, "main");
  assert.equal(output.workspaceTrace.length, 2);
  assert.equal(output.memoryWrites.filter((memory) => memory.memoryType === "event" && memory.workspaceId === "dev").length, 2);
  const autoSkill = output.memoryWrites.find((memory) => memory.memoryType === "skill" && memory.workspaceId === "dev");
  assert.equal(Boolean(autoSkill), false);
  const fileSession = output.workspaceTrace.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.result.summary, "File workspace inspected available evidence.");
  assert.equal(fileSession?.result.observations.includes("File workspace had searchFiles available."), true);

  const trace = repos.getTrace("conv-workspace-exit", "creator", "creator");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.toolCalls.some((call) => call.toolName === "exitWorkspace" && call.status === "completed"), true);
  const exitToolCall = trace.toolCalls.find((call) => call.toolName === "exitWorkspace");
  assert.equal(exitToolCall?.workspaceSessionId, fileSession?.id);
  assert.equal(exitToolCall?.taskId, fileSession?.taskId);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.beforeWorkspaceExit" && log.workspaceId === "dev"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExit" && log.workspaceId === "dev"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterToolCall" && log.resourceId === exitToolCall?.id && log.metadataJson.includes(fileSession!.taskId)), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExitEventExtraction" && log.workspaceId === "dev"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterEventExtracted" && log.workspaceId === "dev"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterSkillExtracted" && log.workspaceId === "dev"), false);
  assert.equal(trace.auditLogs.some((log) => log.action === "workspace_returned_to_main"), true);
  const exitEvents = repos.listMemories({ memoryType: "event", userId: "workspace-exit-user", workspaceId: "dev" });
  assert.equal(exitEvents.length, 2);
  assert.equal(exitEvents.every((memory) => metadataOf(memory).source === "afterWorkspaceExit"), true);
  assert.equal(exitEvents.some((memory) => metadataOf(memory).eventKind === "process"), true);
  assert.equal(exitEvents.some((memory) => metadataOf(memory).eventKind === "result"), true);
  assert.equal(exitEvents.every((memory) => metadataSourceIds(memory, "workspace_sessions").includes(fileSession!.id)), true);
  assert.equal(exitEvents.every((memory) => metadataSourceIds(memory, "tool_calls").includes(exitToolCall!.id)), true);
  assert.equal(exitEvents.every((memory) => !metadataSourceIds(memory, "tool_calls").includes(staleToolCall.id)), true);
  assert.equal(exitEvents.every((memory) => metadataSourceIds(memory, "messages").every((id: string) => !staleMessageIds.has(id))), true);
  const processEvent = exitEvents.find((memory) => metadataOf(memory).eventKind === "process");
  assert.equal(Boolean(processEvent), true);
  assert.equal(processEvent!.detail.length <= 900, true);
  assert.equal(processEvent!.detail.includes("argumentsJson"), false);
  assert.equal(processEvent!.detail.includes("resultJson"), false);
  assert.equal(processEvent!.detail.includes("召回的事件记忆"), false);
  assert.equal(processEvent!.detail.includes("关键过程信号"), true);
  const persistedFileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(Boolean(persistedFileSession?.completedAt), true);
  assert.equal(persistedFileSession?.summary, "File workspace inspected available evidence.");
  const finalCall = trace.llmCalls[0];
  assert.equal(finalCall.toolsJson.includes("enterWorkspace"), true);
  assert.equal(finalCall.toolsJson.includes("searchFiles"), false);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "history" && segment.content.includes("File workspace inspected available evidence.")), true);
  const skillUsageMetadata = metadataOf(repos.getMemory(recalledSkill.id));
  assert.equal(skillUsageMetadata.usageCount, 2);
  assert.equal(skillUsageMetadata.successCount, 2);
  assert.equal(skillUsageMetadata.failureCount, 0);
  assert.equal(skillUsageMetadata.lastOutcome, "completed");
  assert.equal(skillUsageMetadata.lastWorkspaceSessionId, fileSession?.id);
  assert.equal(trace.auditLogs.some((log) => log.action === "skill_usage_recorded" && log.resourceId === recalledSkill.id), true);
}

async function testInterruptedChildWorkspaceResumesBeforeMain() {
  const repos = createRepos();
  const conversationId = "conv-resume-child-workspace";
  const userId = "resume-child-user";
  const baseRun = {
    agentId: "default-agent",
    userId,
    userRole: "creator" as const,
    conversationId,
    message: "把当前任务写入文件",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  };
  repos.ensureConversation(conversationId, "default-agent", userId);
  repos.addMessage(conversationId, "user", "把当前任务写入文件");
  const workspaceRuntime = new WorkspaceRuntime(repos);
  const mainSession = workspaceRuntime.run({
    run: baseRun,
    workspaceId: "main",
    objective: "选择合适的工作空间"
  });
  const interruptedSession = workspaceRuntime.run({
    run: baseRun,
    workspaceId: "dev",
    objective: "写入文件但中途停止"
  });
  interruptedSession.status = "failed";
  interruptedSession.summary = "dev 工作空间在写入文件前被中断。";
  interruptedSession.result = {
    ...interruptedSession.result,
    status: "failed",
    summary: "dev 工作空间在写入文件前被中断。",
    errors: ["用户手动停止或运行失败，尚未返回 main。"]
  };
  interruptedSession.errors = ["用户手动停止或运行失败，尚未返回 main。"];
  interruptedSession.completedAt = new Date().toISOString();
  repos.updateWorkspaceSessionLocalContext(interruptedSession);

  const fake = new ResumeChildWorkspaceLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    ...baseRun,
    message: "继续修复刚才的写入任务"
  });

  assert.equal(fake.calls, 2);
  assert.equal(output.assistantMessage, "已经接着刚才的 dev 工作空间完成了。");
  assert.equal(output.activeWorkspaceId, "main");
  assert.equal(output.workspaceTrace.some((session) => session.id === mainSession.id), true);
  assert.equal(output.workspaceTrace.some((session) => session.id === interruptedSession.id), true);
  const trace = repos.getTrace(conversationId, "creator", "creator");
  assert.equal(trace.auditLogs.some((log) => log.action === "workspace_session_resumed" && log.resourceId === interruptedSession.id), true);
  const persistedChild = trace.sessions.find((session) => session.id === interruptedSession.id);
  assert.equal(persistedChild?.status, "completed");
  assert.equal(persistedChild?.summary, "恢复后的 dev 工作空间已经完成写入任务。");
  assert.equal(persistedChild?.task.relevantUserRequest, "继续修复刚才的写入任务");
  const firstRunWorkspaceSegment = trace.contextSegments
    .filter((segment) => segment.segmentType === "workspace")
    .find((segment) => segment.content.includes("\"id\":\"dev\"") || segment.content.includes("\"id\": \"dev\""));
  assert.equal(Boolean(firstRunWorkspaceSegment), true);
  const firstRunToolsSegment = trace.contextSegments.find((segment) => segment.llmCallId === firstRunWorkspaceSegment?.llmCallId && segment.segmentType === "tools");
  assert.equal(firstRunToolsSegment?.content.includes("writeFile"), true);
  assert.equal(firstRunToolsSegment?.content.includes("enterWorkspace"), false);
}

async function testWorkspaceExitHookRunsOncePerSuccessfulExitToolCall() {
  const repos = createRepos();
  const recalledSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:single-exit-hook",
    title: "Single exit hook skill",
    summary: "When exiting a file workspace, record skill usage only once for the completed workspace session.",
    detail: "Reusable file workspace guidance used to detect duplicate exit hook execution.",
    metadataJson: JSON.stringify({
      desensitized: true,
      confidence: 0.77,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      qualityGate: {
        reusable: true,
        userPrivateDetailRemoved: true,
        workspaceScoped: true,
        evidenceCount: 0
      },
      procedure: ["Return a structured WorkspaceResult once."],
      appliesWhen: ["A child workspace completes and exits to main."],
      avoidWhen: ["The workspace session has not committed a valid result."]
    })
  }, "creator", "creator");
  const fake = new MainToFileExitWithExtraToolLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "single-exit-hook-user",
    userRole: "creator",
    conversationId: "conv-single-exit-hook",
    message: "inspect file evidence and return once",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(fake.calls, 3);
  assert.equal(output.assistantMessage, "main integrated batched file result");
  const trace = repos.getTrace("conv-single-exit-hook", "creator", "creator");
  const fileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.status, "completed");
  assert.equal(trace.toolCalls.some((call) => call.toolName === "searchFiles" && call.status === "failed"), true);
  const postExitSearch = trace.toolCalls.find((call) => call.toolName === "searchFiles");
  assert.equal(postExitSearch?.resultJson.includes("already exited"), true);
  assert.equal(fileSession?.localContext.recentToolCalls.some((call) => call.toolName === "searchFiles"), false);
  assert.equal(trace.auditLogs.filter((log) => log.action === "hook.afterWorkspaceExit" && log.workspaceId === "dev").length, 1);
  assert.equal(trace.auditLogs.filter((log) => log.action === "hook.afterWorkspaceExitEventExtraction" && log.workspaceId === "dev").length, 2);
  assert.equal(trace.auditLogs.filter((log) => log.action === "skill_usage_recorded" && log.resourceId === recalledSkill.id).length, 1);
  const skillUsageMetadata = metadataOf(repos.getMemory(recalledSkill.id));
  assert.equal(skillUsageMetadata.usageCount, 1);
  assert.equal(skillUsageMetadata.successCount, 1);
}

async function testDuplicateWorkspaceExitCannotOverwriteCommittedSession() {
  const repos = createRepos();
  const fake = new MainToFileDoubleExitLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "duplicate-exit-user",
    userRole: "creator",
    conversationId: "conv-duplicate-exit",
    message: "inspect file evidence and return duplicate exits",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(fake.calls, 3);
  assert.equal(output.assistantMessage, "main integrated first file result");
  const trace = repos.getTrace("conv-duplicate-exit", "creator", "creator");
  const fileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.status, "completed");
  assert.equal(fileSession?.result.summary, "First valid file result.");
  assert.equal(fileSession?.result.errors.length, 0);
  const exitCalls = trace.toolCalls.filter((call) => call.toolName === "exitWorkspace");
  assert.equal(exitCalls.length, 2);
  assert.equal(exitCalls.filter((call) => call.status === "completed").length, 1);
  assert.equal(exitCalls.filter((call) => call.status === "failed").length, 1);
  assert.equal(exitCalls.some((call) => call.resultJson.includes("already exited")), true);
  assert.equal(fileSession?.localContext.recentToolCalls.filter((call) => call.toolName === "exitWorkspace").length, 1);
  assert.equal(trace.auditLogs.filter((log) => log.action === "hook.afterWorkspaceExit" && log.workspaceId === "dev").length, 1);
}

async function testMalformedWorkspaceExitDoesNotCommitSession() {
  const repos = createRepos();
  const fake = new MainToFileMalformedExitLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "workspace-bad-exit-user",
    userRole: "creator",
    conversationId: "conv-workspace-bad-exit",
    message: "inspect file evidence then return malformed result",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(fake.calls > 5, true);
  assert.equal(output.activeWorkspaceId, "dev");
  assert.equal(output.assistantMessage.length > 0, true);
  const trace = repos.getTrace("conv-workspace-bad-exit", "creator", "creator");
  const exitCalls = trace.toolCalls.filter((call) => call.toolName === "exitWorkspace");
  assert.equal(exitCalls.length, 2);
  assert.equal(exitCalls.every((call) => call.status === "failed"), true);
  assert.equal(exitCalls.some((call) => call.resultJson.includes("WorkspaceResult.status")), true);
  assert.equal(exitCalls.some((call) => call.resultJson.includes("WorkspaceResult.artifacts")), true);
  const fileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.completedAt, undefined);
  assert.equal(fileSession?.status, "running");
  assert.equal(fileSession?.result.status, "running");
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.beforeWorkspaceExit"), false);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExit"), false);
  assert.equal(trace.auditLogs.some((log) => log.action === "workspace_exit_required"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "workspace_exit_missing"), true);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "workspace-bad-exit-user", workspaceId: "dev" }).length, 0);
}

async function testWorkspaceSessionLocalToolCallsAreSessionScoped() {
  const repos = createRepos();
  const fake = new TwoFileSessionsLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "session-scope-user",
    userRole: "creator",
    conversationId: "conv-session-scope",
    message: "enter file twice",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(fake.calls, 5);
  assert.equal(output.workspaceTrace.filter((session) => session.workspaceId === "dev").length, 2);
  const firstFileSession = output.workspaceTrace.filter((session) => session.workspaceId === "dev")[0];
  const secondFileSession = output.workspaceTrace.filter((session) => session.workspaceId === "dev")[1];
  assert.equal(firstFileSession.localContext.recentToolCalls.some((call) => call.toolName === "exitWorkspace"), true);
  assert.equal(secondFileSession.localContext.recentToolCalls.some((call) => call.toolName === "exitWorkspace"), true);

  const secondFileInput = fake.inputs[3];
  const localConversationToolMessage = secondFileInput.messages.find((message) => message.role === "tool" && message.name === "runtime_context.local_conversation");
  const localConversationPayload = JSON.parse(localConversationToolMessage?.content ?? "{}") as {
    messages: Array<{ content: string }>;
    completedWorkspaceResults: Array<{ workspaceId: string }>;
    recentToolEvidence: unknown[];
  };
  assert.equal(localConversationPayload.messages.some((message) => message.content.includes("exitWorkspace")), true);
  assert.equal(localConversationPayload.messages.some((message) => message.content.includes("enterWorkspace")), false);
  assert.equal(localConversationPayload.completedWorkspaceResults.every((result) => result.workspaceId === "dev"), true);
  assert.equal(localConversationPayload.recentToolEvidence.length, 0);

  const trace = repos.getTrace("conv-session-scope", "creator", "creator");
  const exitCalls = trace.toolCalls.filter((call) => call.toolName === "exitWorkspace");
  assert.equal(exitCalls.some((call) => call.workspaceSessionId === firstFileSession.id && call.taskId === firstFileSession.taskId), true);
  assert.equal(exitCalls.some((call) => call.workspaceSessionId === secondFileSession.id && call.taskId === secondFileSession.taskId), true);
  const persistedSecond = trace.sessions.find((session) => session.id === secondFileSession.id);
  assert.equal(persistedSecond?.localContext.recentToolCalls.some((call) => call.toolName === "exitWorkspace"), true);
}

async function testWorkspaceMemoryPolicyControlsRecall() {
  const repos = createRepos();
  repos.createMemory({
    memoryType: "impression",
    userId: "policy-user",
    relationId: "impression:policy-user:recall",
    title: "Policy impression",
    summary: "policy recall impression stays visible",
    detail: "Impression memories are available across workspaces for the current user."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "event",
    userId: "policy-user",
    workspaceId: "dev",
    relationId: "event:policy-user:file:policy:1",
    title: "Policy event one",
    summary: "policy recall event one",
    detail: "First event memory for memory policy recall.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-memory-policy-capped", eventKind: "result", outcome: "completed" })
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "event",
    userId: "policy-user",
    workspaceId: "dev",
    relationId: "event:policy-user:file:policy:2",
    title: "Policy event two",
    summary: "policy recall event two",
    detail: "Second event memory for memory policy recall.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-memory-policy-capped", eventKind: "process" })
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:policy:1",
    title: "Policy skill one",
    summary: "policy recall skill one",
    detail: "First skill memory for memory policy recall."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    relationId: "skill:file:policy:2",
    title: "Policy skill two",
    summary: "policy recall skill two",
    detail: "Second skill memory for memory policy recall."
  }, "creator", "creator");

  updateWorkspaceMemoryPolicy(repos, "dev", {
    eventRecallEnabled: true,
    skillRecallEnabled: true,
    maxEventMemories: 1,
    maxSkillMemories: 1
  });

  const cappedFake = new MainToFileLLMClient();
  const cappedRuntime = new AgentRuntime(repos, cappedFake);
  await cappedRuntime.run({
    agentId: "default-agent",
    userId: "policy-user",
    userRole: "creator",
    conversationId: "conv-memory-policy-capped",
    message: "search files policy recall",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const cappedFileInput = cappedFake.inputs.find((input) => input.tools.some((tool) => tool.name === "searchFiles"));
  const cappedMemoryMessage = cappedFileInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.memory");
  const cappedMemoryPayload = JSON.parse(cappedMemoryMessage?.content ?? "{}") as { crossWorkspaceImpressionMemory: unknown[]; currentWorkspaceResultEvents: unknown[]; currentWorkspaceRelevantProcessEvents: unknown[]; currentWorkspaceSkillMemory: unknown[] };
  assert.equal(cappedMemoryPayload.crossWorkspaceImpressionMemory.length, 1);
  assert.equal(cappedMemoryPayload.currentWorkspaceResultEvents.length, 1);
  assert.equal(cappedMemoryPayload.currentWorkspaceRelevantProcessEvents.length, 1);
  assert.equal(cappedMemoryPayload.currentWorkspaceSkillMemory.length, 1);
  assert.equal((cappedMemoryMessage?.content ?? "").includes("metadataJson"), false);

  updateWorkspaceMemoryPolicy(repos, "dev", {
    eventRecallEnabled: false,
    skillRecallEnabled: false
  });

  const disabledFake = new MainToFileLLMClient();
  const disabledRuntime = new AgentRuntime(repos, disabledFake);
  const disabledOutput = await disabledRuntime.run({
    agentId: "default-agent",
    userId: "policy-user",
    userRole: "creator",
    conversationId: "conv-memory-policy-disabled",
    message: "search files policy recall",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const disabledFileInput = disabledFake.inputs.find((input) => input.tools.some((tool) => tool.name === "searchFiles"));
  const disabledMemoryMessage = disabledFileInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.memory");
  const disabledMemoryPayload = JSON.parse(disabledMemoryMessage?.content ?? "{}") as { crossWorkspaceImpressionMemory: unknown[]; currentWorkspaceResultEvents: unknown[]; currentWorkspaceRelevantProcessEvents: unknown[]; currentWorkspaceSkillMemory: unknown[] };
  assert.equal(disabledMemoryPayload.crossWorkspaceImpressionMemory.length, 1);
  assert.equal(disabledMemoryPayload.currentWorkspaceResultEvents.length, 0);
  assert.equal(disabledMemoryPayload.currentWorkspaceRelevantProcessEvents.length, 0);
  assert.equal(disabledMemoryPayload.currentWorkspaceSkillMemory.length, 0);
  assert.equal(disabledOutput.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Policy event")), false);
  assert.equal(disabledOutput.contextSegments.some((segment) => segment.segmentType === "memory" && segment.content.includes("Policy skill")), false);

  for (let index = 0; index < 55; index += 1) {
    repos.createMemory({
      memoryType: "event",
      userId: "policy-user",
      workspaceId: "dev",
      relationId: `event:policy-user:file:policy:bulk:${index}`,
      title: `Policy bulk event ${index}`,
      summary: `search files policy recall bulk event ${index}`,
      detail: "Bulk event memory used to prove layered result-event recall is bounded without raw transcript injection.",
      metadataJson: JSON.stringify({ source: "test", conversationId: "conv-memory-policy-raised-limit", eventKind: "result", outcome: "completed" })
    }, "creator", "creator");
    repos.createMemory({
      memoryType: "skill",
      workspaceId: "dev",
      relationId: `skill:file:policy:bulk:${index}`,
      title: `Policy bulk skill ${index}`,
      summary: `search files policy recall bulk skill ${index}`,
      detail: "Bulk skill memory used to prove workspace policy can raise recall above the repository default.",
      metadataJson: JSON.stringify({
        desensitized: true,
        confidence: 0.75,
        qualityGate: {
          reusable: true,
          userPrivateDetailRemoved: true,
          workspaceScoped: true,
          evidenceCount: 0
        },
        procedure: ["Use the workspace memory policy as the SQL recall limit before prompt assembly."],
        appliesWhen: ["A workspace raises max recalled memory above the runtime default."],
        avoidWhen: ["The workspace disables recall for that memory type."]
      })
    }, "creator", "creator");
  }
  updateWorkspaceMemoryPolicy(repos, "dev", {
    eventRecallEnabled: true,
    skillRecallEnabled: true,
    maxEventMemories: 9,
    maxSkillMemories: 9
  });

  const raisedLimitFake = new MainToFileLLMClient();
  const raisedLimitRuntime = new AgentRuntime(repos, raisedLimitFake);
  const raisedLimitOutput = await raisedLimitRuntime.run({
    agentId: "default-agent",
    userId: "policy-user",
    userRole: "creator",
    conversationId: "conv-memory-policy-raised-limit",
    message: "search files policy recall",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const raisedLimitFileSession = raisedLimitOutput.workspaceTrace.find((session) => session.workspaceId === "dev");
  assert.equal(raisedLimitFileSession?.localContext.recalledEventMemories.filter((memory) => metadataOf(memory).eventKind === "result").length, 10);
  const raisedProcessEvents = raisedLimitFileSession?.localContext.recalledEventMemories.filter((memory) => metadataOf(memory).eventKind === "process") ?? [];
  assert.equal(raisedProcessEvents.length >= 1, true);
  assert.equal(raisedProcessEvents.length <= 8, true);
  assert.equal(raisedLimitFileSession?.localContext.recalledSkillMemories.length, 9);
}

async function testWorkspaceMemoryPolicyControlsWrites() {
  const repos = createRepos();
  updateWorkspaceMemoryPolicy(repos, "dev", {
    eventWriteEnabled: false,
    skillWriteEnabled: false
  });

  const visibleFileTools = new AgentRuntime(repos, new MainToFileLLMClient());
  await visibleFileTools.run({
    agentId: "default-agent",
    userId: "write-policy-user",
    userRole: "creator",
    conversationId: "conv-memory-write-policy-tool-list",
    message: "search files write policy event",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const toolListTrace = repos.getTrace("conv-memory-write-policy-tool-list", "creator", "creator");
  assert.equal(toolListTrace.llmCalls.some((call) => call.toolsJson.includes("\"writeSkillMemory\"")), true);
  assert.equal(toolListTrace.llmCalls.some((call) => call.toolsJson.includes("\"readSkill\"")), true);
  assert.equal(toolListTrace.llmCalls.some((call) => call.toolsJson.includes("\"writeEventMemory\"")), false);
  assert.equal(toolListTrace.llmCalls.some((call) => call.toolsJson.includes("\"updateMemory\"")), false);
  assert.equal(toolListTrace.llmCalls.some((call) => call.toolsJson.includes("\"deleteMemory\"")), false);

  const skillWriter = new MainToWorkspaceToolRequestLLMClient("dev", "writeSkillMemory", {
    title: "Blocked file skill",
    summary: "Skill writes should be disabled",
    detail: "The runtime should reject this skill memory because file workspace disabled skill writes."
  });
  const skillRuntime = new AgentRuntime(repos, skillWriter);
  await skillRuntime.run({
    agentId: "default-agent",
    userId: "write-policy-user",
    userRole: "creator",
    conversationId: "conv-memory-write-policy-skill",
    message: "search files write policy skill",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(skillWriter.lastToolResult.includes("Skill memory writes are disabled for workspace: dev"), true);
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "dev" }).length, 0);
  const skillTrace = repos.getTrace("conv-memory-write-policy-skill", "creator", "creator");
  assert.equal(skillTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "failed"), true);
  assert.equal(skillTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.resultJson.includes("Skill memory writes are disabled")), true);

  updateWorkspaceMemoryPolicy(repos, "dev", {
    eventWriteEnabled: true,
    skillWriteEnabled: false
  });
  const autoSkillFake = new MainToFileExitToMainLLMClient();
  const autoSkillRuntime = new AgentRuntime(repos, autoSkillFake);
  const autoSkillOutput = await autoSkillRuntime.run({
    agentId: "default-agent",
    userId: "write-policy-user",
    userRole: "creator",
    conversationId: "conv-memory-write-policy-auto-skill",
    message: "inspect file evidence with skill writes disabled",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(autoSkillOutput.memoryWrites.some((memory) => memory.memoryType === "skill" && memory.workspaceId === "dev"), false);
  const autoSkillTrace = repos.getTrace("conv-memory-write-policy-auto-skill", "creator", "creator");
  assert.equal(autoSkillTrace.auditLogs.some((log) => log.action === "hook.afterSkillExtracted"), false);
}

async function testEventMemoryIsHookGenerated() {
  const repos = createRepos();
  const runtime = new AgentRuntime(repos, new FakeLLMClient());
  for (let index = 0; index < 10; index += 1) {
    await runtime.run({
      agentId: "default-agent",
      userId: "event-contract-user",
      userRole: "creator",
      conversationId: "conv-event-hook-contract",
      message: `event hook window message ${index}`,
      llm: {
        baseUrl: "https://api.302ai.com",
        model: "gpt-5-mini",
        apiKey: "test-key"
      }
    });
  }
  const events = repos.listMemories({ memoryType: "event", userId: "event-contract-user", workspaceId: "main" });
  assert.equal(events.length >= 2, true);
  assert.equal(events.every((memory) => metadataOf(memory).source === "afterConversationWindow"), true);
  assert.equal(events.every((memory) => metadataOf(memory).conversationId === "conv-event-hook-contract"), true);
  assert.equal(events.every((memory) => typeof metadataOf(memory).taskId === "string" && metadataOf(memory).taskId.startsWith("conversation-window:")), true);
  assert.equal(events.every((memory) => Array.isArray(metadataOf(memory).sourceRefs)), true);
  assert.equal(events.every((memory) => JSON.stringify(metadataOf(memory)).includes("\"table\":\"messages\"")), true);
  for (const key of RAW_MEMORY_METADATA_PAYLOAD_KEYS) {
    assert.equal(events.every((memory) => !Object.prototype.hasOwnProperty.call(metadataOf(memory), key)), true);
  }
  const processEvents = events.filter((memory) => metadataOf(memory).eventKind === "process");
  assert.equal(processEvents.length > 0, true);
  assert.equal(processEvents.every((memory) => memory.detail.length <= 900), true);
  assert.equal(processEvents.every((memory) => !memory.detail.includes("窗口消息：")), true);
  assert.equal(processEvents.every((memory) => !memory.detail.includes("argumentsJson")), true);
  assert.equal(processEvents.every((memory) => memory.detail.includes("本窗口用户意图")), true);
  const trace = repos.getTrace("conv-event-hook-contract", "creator", "creator");
  assert.equal(trace.toolCalls.some((call) => call.toolName.includes("EventMemory")), false);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterConversationWindow"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterEventExtracted"), true);

  const hiddenToolAttempt = new SingleToolRequestLLMClient("writeEventMemory", {
    title: "Tool event",
    summary: "Should not be accepted as a callable tool.",
    detail: "Event memory must be generated by hooks."
  });
  const hiddenRuntime = new AgentRuntime(repos, hiddenToolAttempt);
  await hiddenRuntime.run({
    agentId: "default-agent",
    userId: "event-contract-user",
    userRole: "creator",
    conversationId: "conv-event-tool-hidden",
    message: "try event memory tool",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(hiddenToolAttempt.lastToolResult.includes("Unknown tool"), true);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "event-contract-user", workspaceId: "main" }).some((memory) => memory.title === "Tool event"), false);

  const memoryService = new MemoryService(repos);
  for (const key of RAW_MEMORY_METADATA_PAYLOAD_KEYS) {
    assert.throws(() => memoryService.createMemoryRecord({
      actorId: "creator",
      actorRole: "creator",
      memory: {
        memoryType: "event",
        userId: "event-contract-user",
        workspaceId: "main",
        title: `Raw payload event ${key}`,
        summary: "Should be rejected.",
        detail: "Memory metadata should reference raw tables instead of copying raw data.",
        metadataJson: JSON.stringify({
          source: "manualMemoryApi",
          conversationId: "conv-event-hook-contract",
          taskId: `task-manual-raw-payload-${key}`,
          eventKind: "manual",
          [key]: [{ id: "raw-source-payload" }]
        })
      }
    }), /raw source payloads/);
  }
  assert.throws(() => memoryService.updateMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memoryId: events[0]!.id,
    patch: {
      metadataJson: JSON.stringify({
        source: "manualMemoryApi",
        conversationId: "conv-event-hook-contract",
        taskId: "task-update-raw-payload",
        eventKind: "manual",
        nested: {
          responseJson: { raw: true }
        }
      })
    }
  }), /raw source payloads/);
}

async function testSkillMemoryToolQualityGate() {
  const repos = createRepos();
  const event = repos.createMemory({
    memoryType: "event",
    userId: "skill-quality-user",
    workspaceId: "dev",
    title: "Generalized file search event",
    summary: "A file workspace task succeeded after searching call sites first.",
    detail: "The task used file search before editing.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-skill-quality-valid", eventKind: "manual" })
  }, "creator", "creator");

  const validSkillWriter = new MainToWorkspaceToolRequestLLMClient("dev", "writeSkillMemory", {
    title: "Search before editing",
    summary: "Search related call sites before changing code.",
    detail: "For code changes, inspect related call sites and tests before modifying files.",
    desensitized: true,
    procedure: ["Search for related symbols.", "Inspect nearby tests.", "Edit only after the affected surface is understood."],
    appliesWhen: ["A file workspace task changes existing code."],
    avoidWhen: ["The task is a one-off user-private file detail."],
    evidenceEventIds: [event.id],
    confidence: 0.82
  });
  const validRuntime = new AgentRuntime(repos, validSkillWriter);
  const validOutput = await validRuntime.run({
    agentId: "default-agent",
    userId: "skill-quality-user",
    userRole: "creator",
    conversationId: "conv-skill-quality-valid",
    message: "memory write reusable skill",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const writtenSkill = validOutput.memoryWrites.find((memory) => memory.memoryType === "skill");
  assert.equal(Boolean(writtenSkill), true);
  const metadata = metadataOf(writtenSkill!);
  assert.equal(metadata.desensitized, true);
  assert.equal(metadata.qualityGate.userPrivateDetailRemoved, true);
  assert.equal(metadata.evidenceEventIds[0], event.id);
  assert.equal(Array.isArray(metadata.procedure), true);
  const validFileSession = validOutput.workspaceTrace.find((session) => session.workspaceId === "dev");
  assert.equal(metadata.activeWorkspaceId, "dev");
  assert.equal(metadata.workspaceSessionId, validFileSession?.id);
  assert.equal(metadata.taskId, validFileSession?.taskId);
  const validTrace = repos.getTrace("conv-skill-quality-valid", "creator", "creator");
  assert.equal(validTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "completed"), true);

  const forgedTraceSkillWriter = new MainToWorkspaceToolRequestLLMClient("dev", "writeSkillMemory", {
    title: "Forged trace skill",
    summary: "The model must not choose runtime trace ids for shared skill evidence.",
    detail: "Runtime should reject code-bound trace fields in tool arguments.",
    desensitized: true,
    procedure: ["Reject model-supplied active workspace, session, or task trace identifiers."],
    appliesWhen: ["A model attempts to provide runtime trace ids while writing a skill."],
    avoidWhen: ["Trace ids are supplied by runtime code-bound state."],
    evidenceEventIds: [event.id],
    activeWorkspaceId: "main",
    workspaceSessionId: "forged-session",
    taskId: "forged-task",
    confidence: 0.82
  });
  const forgedTraceRuntime = new AgentRuntime(repos, forgedTraceSkillWriter);
  await forgedTraceRuntime.run({
    agentId: "default-agent",
    userId: "skill-quality-user",
    userRole: "creator",
    conversationId: "conv-skill-quality-forged-trace",
    message: "memory write forged trace skill",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(forgedTraceSkillWriter.lastToolResult.includes("activeWorkspaceId"), true);
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "dev" }).some((memory) => memory.title === "Forged trace skill"), false);
  const forgedTrace = repos.getTrace("conv-skill-quality-forged-trace", "creator", "creator");
  assert.equal(forgedTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "failed" && call.resultJson.includes("Runtime memory scope is code-bound")), true);

  const privateSkillWriter = new MainToWorkspaceToolRequestLLMClient("dev", "writeSkillMemory", {
    title: "Private path skill",
    summary: "Use G:\\Jomy\\Documents\\PrivateProject before edits.",
    detail: "This leaks a concrete private local path into shared skill memory.",
    desensitized: true,
    procedure: ["Reuse the private path."],
    appliesWhen: ["A task mentions this exact project."],
    avoidWhen: ["Other users are present."],
    confidence: 0.9
  });
  const privateRuntime = new AgentRuntime(repos, privateSkillWriter);
  await privateRuntime.run({
    agentId: "default-agent",
    userId: "skill-quality-user",
    userRole: "creator",
    conversationId: "conv-skill-quality-private",
    message: "memory write private skill",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(privateSkillWriter.lastToolResult.includes("private user/project details"), true);
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "dev" }).some((memory) => memory.title === "Private path skill"), false);
  const privateTrace = repos.getTrace("conv-skill-quality-private", "creator", "creator");
  assert.equal(privateTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "failed"), true);
  assert.equal(privateTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.resultJson.includes("private user/project details")), true);
}

async function testRuntimeStreaming() {
  const repos = createRepos();
  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const events = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "user",
    userRole: "creator",
    conversationId: "conv-stream",
    message: "remember this memory",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    events.push(event);
  }
  assert.equal(events[0].type, "start");
  assert.equal(events.some((event) => event.type === "delta"), true);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") assert.equal(done.output.assistantMessage, "fake stream");
  const trace = repos.getTrace("conv-stream", "creator", "creator");
  assert.equal(trace.llmCalls[0].status, "completed");
  assert.equal(trace.llmCalls[0].responseJson.includes("returnedTextLength"), true);
}

async function testMemoryLifecycleHooks() {
  const repos = createRepos();
  repos.ensureConversation("conv-memory-window", "default-agent", "user-memory");
  const db = (repos as unknown as { db: Database.Database }).db;
  db.prepare(`
    INSERT INTO tool_calls
      (id, conversationId, workspaceId, workspaceSessionId, taskId, toolName, argumentsJson, resultJson, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tool-old-window-evidence",
    "conv-memory-window",
    "main",
    "wss-old-window-evidence",
    "task-old-window-evidence",
    "oldTool",
    "{}",
    "{}",
    "completed",
    "2000-01-01T00:00:00.000Z"
  );
  db.prepare(`
    INSERT INTO workspace_sessions
      (id, conversationId, userId, workspaceId, taskId, status, objective, summary, taskJson, resultJson, localContextJson, observationsJson, errorsJson, startedAt, completedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "wss-old-window-evidence",
    "conv-memory-window",
    "user-memory",
    "main",
    "task-old-window-evidence",
    "completed",
    "old task outside the event window",
    "old session outside the event window",
    "{}",
    "{}",
    "{}",
    "[]",
    "[]",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:01.000Z"
  );
  const runtime = new AgentRuntime(repos, new FakeLLMClient());
  let lastOutput;
  for (let index = 1; index <= 10; index += 1) {
    lastOutput = await runtime.run({
      agentId: "default-agent",
      userId: "user-memory",
      userRole: "user",
      conversationId: "conv-memory-window",
      message: `plain turn ${index}`,
      llm: {
        baseUrl: "https://api.302ai.com",
        model: "gpt-5-mini",
        apiKey: "test-key"
      }
    });
  }
  assert.equal(lastOutput?.memoryWrites.some((memory) => memory.memoryType === "event"), true);
  const events = repos.listMemories({ memoryType: "event", userId: "user-memory", workspaceId: "main" });
  assert.equal(events.some((memory) => memory.relationId === "event:user-memory:agent:default-agent:main:conv-memory-window:window:1:result"), true);
  assert.equal(events.some((memory) => metadataOf(memory).eventKind === "process"), true);
  assert.equal(events.some((memory) => metadataOf(memory).eventKind === "result"), true);
  const resultEvent = events.find((memory) => memory.relationId === "event:user-memory:agent:default-agent:main:conv-memory-window:window:1:result");
  assert.equal(metadataSourceIds(resultEvent!, "messages").length, 20);
  assert.equal(metadataSourceIds(resultEvent!, "tool_calls").includes("tool-old-window-evidence"), false);
  assert.equal(metadataSourceIds(resultEvent!, "workspace_sessions").includes("wss-old-window-evidence"), false);
  assert.equal(JSON.stringify(metadataOf(resultEvent!)).includes("task-old-window-evidence"), false);
  assert.equal(typeof metadataOf(resultEvent!).windowStartAt, "string");
  assert.equal(typeof metadataOf(resultEvent!).windowEndAt, "string");
  const windowTrace = repos.getTrace("conv-memory-window", "creator", "creator");
  assert.equal(windowTrace.auditLogs.some((log) => log.action === "hook.afterConversationWindow"), true);
  assert.equal(windowTrace.auditLogs.some((log) => log.action === "hook.afterEventExtracted"), true);
  const memoryCreateLogs = windowTrace.auditLogs.filter((log) => log.action === "create" && log.resourceKind === "memory");
  assert.equal(memoryCreateLogs.some((log) => log.actorId === "user-memory" && log.actorRole === "user" && log.workspaceId === "main"), true);
  assert.equal(memoryCreateLogs.some((log) => log.actorRole === "creator"), false);

  const impressionOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "creator",
    conversationId: "conv-memory-direct",
    message: "remember this as a short-term task fact, not a long-term impression",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(impressionOutput.memoryWrites.some((memory) => memory.memoryType === "impression" && memory.userId === "user-memory"), false);
  assert.equal(repos.listMemories({ memoryType: "impression", userId: "user-memory" }).length, 0);

  const hookImpressionOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "user",
    conversationId: "conv-memory-hook-impression",
    message: "我叫 Jomy，以后请用中文简洁回答。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const hookImpression = hookImpressionOutput.memoryWrites.find((memory) => memory.memoryType === "impression" && memory.userId === "user-memory");
  assert.equal(Boolean(hookImpression), true);
  assert.equal(Boolean(hookImpression!.workspaceId), false);
  assert.equal(hookImpression!.summary.includes("Jomy"), true);
  assert.equal(metadataOf(hookImpression!).source, "afterAgentTurnUserImpressionCandidate");
  assert.equal(metadataOf(hookImpression!).impressionKind, "userImpression");
  assert.equal(metadataSourceIds(hookImpression!, "messages").length > 0, true);
  const hookTrace = repos.getTrace("conv-memory-hook-impression", "creator", "creator");
  assert.equal(hookTrace.auditLogs.some((log) => log.action === "hook.afterUserImpressionExtracted"), true);

  const duplicateHookOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "user",
    conversationId: "conv-memory-hook-impression-repeat",
    message: "我叫 Jomy，以后请用中文简洁回答。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(duplicateHookOutput.memoryWrites.some((memory) => memory.memoryType === "impression" && memory.userId === "user-memory"), false);

  const skillOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "creator",
    conversationId: "conv-memory-skill",
    message: "write skill memory: in Node projects inspect package.json and lockfile before choosing commands",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(skillOutput.memoryWrites.some((memory) => memory.memoryType === "skill" && memory.workspaceId === "main" && !memory.userId), true);
  const skillMemory = skillOutput.memoryWrites.find((memory) => memory.memoryType === "skill");
  assert.equal(metadataOf(skillMemory!).qualityGate.workspaceScoped, true);
  assert.equal(Array.isArray(metadataOf(skillMemory!).procedure), true);
  assert.equal(skillMemory!.summary.includes("lockfile"), true);
  assert.equal(metadataOf(skillMemory!).procedure.some((step: string) => step.includes("lockfile")), true);
  assert.equal(metadataOf(skillMemory!).appliesWhen.some((item: string) => item.includes("main workspace")), true);
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "dev" }).some((memory) => memory.summary.includes("lockfile")), false);
  const skillTrace = repos.getTrace("conv-memory-skill", "creator", "creator");
  assert.equal(skillTrace.auditLogs.some((log) => log.action === "hook.afterSkillExtracted"), true);

  const chineseSkillOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "creator",
    conversationId: "conv-memory-skill-cn",
    message: "请总结一下经验：在 Node 项目里选择命令前先检查 package.json 和 lockfile",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const chineseSkill = chineseSkillOutput.memoryWrites.find((memory) => memory.memoryType === "skill");
  assert.equal(Boolean(chineseSkill), true);
  assert.equal(chineseSkill!.summary.includes("package.json"), true);
  assert.equal(chineseSkill!.summary.includes("lockfile"), true);
  assert.equal(chineseSkill!.summary.includes("总结一下经验"), false);
  assert.equal(metadataOf(chineseSkill!).source, "activeSkillTrigger");
  assert.equal(metadataOf(chineseSkill!).procedure.some((step: string) => step.includes("lockfile")), true);
}

async function testConversationWindowEventExtractionUsesAbsoluteWindows() {
  const repos = createRepos();
  repos.ensureConversation("conv-long-memory-window", "default-agent", "long-window-user");
  for (let index = 1; index <= 520; index += 1) {
    repos.addMessage(
      "conv-long-memory-window",
      index % 2 === 0 ? "assistant" : "user",
      index % 2 === 0 ? `long-window assistant ${index}` : `long-window user ${index}`
    );
  }

  const service = new MemoryService(repos);
  const writes = service.afterAgentTurn({
    run: {
      agentId: "default-agent",
      userId: "long-window-user",
      userRole: "user",
      conversationId: "conv-long-memory-window",
      message: "long window final trigger"
    },
    activeWorkspaceId: "main",
    assistantMessage: "long-window assistant 520"
  });

  assert.equal(writes.some((memory) => memory.relationId === "event:long-window-user:agent:default-agent:main:conv-long-memory-window:window:26:result"), true);
  const resultEvent = repos.getMemoryByRelation(
    "event",
    "event:long-window-user:agent:default-agent:main:conv-long-memory-window:window:26:result",
    { userId: "long-window-user", agentId: "default-agent", workspaceId: "main" }
  );
  assert.equal(Boolean(resultEvent), true);
  assert.equal(resultEvent!.summary.includes("long-window assistant 520"), true);
  assert.equal(metadataSourceIds(resultEvent!, "messages").length, 20);
  assert.equal(Object.prototype.hasOwnProperty.call(metadataOf(resultEvent!), "messageCount"), false);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "long-window-user", workspaceId: "main" }).filter((memory) => metadataOf(memory).eventKind === "result").length, 26);
}

async function testStreamingConversationWindowMemoryIncludesAssistantMessage() {
  const repos = createRepos();
  const runtime = new AgentRuntime(repos, new StreamingContentOnlyLLMClient());
  let lastDone: Extract<Awaited<ReturnType<typeof runtime.runStream> extends AsyncGenerator<infer T> ? T : never>, { type: "done" }> | undefined;
  for (let index = 1; index <= 10; index += 1) {
    for await (const event of runtime.runStream({
      agentId: "default-agent",
      userId: "stream-memory-user",
      userRole: "creator",
      conversationId: "conv-stream-memory-window",
      message: `streaming plain turn ${index}`,
      llm: {
        baseUrl: "https://api.302ai.com",
        model: "gpt-5-mini",
        apiKey: "test-key"
      }
    })) {
      if (event.type === "done") lastDone = event;
    }
  }

  assert.equal(lastDone?.output.memoryWrites.some((memory) => memory.memoryType === "event"), true);
  const events = repos.listMemories({ memoryType: "event", userId: "stream-memory-user", workspaceId: "main" });
  const resultEvent = events.find((memory) => memory.relationId === "event:stream-memory-user:agent:default-agent:main:conv-stream-memory-window:window:1:result");
  assert.equal(Boolean(resultEvent), true);
  assert.equal(metadataSourceIds(resultEvent!, "messages").length, 20);
  assert.equal(resultEvent!.summary.includes("streamed assistant"), true);
  const trace = repos.getTrace("conv-stream-memory-window", "creator", "creator");
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterConversationWindow"), true);
}

async function testSkillEvidenceFromWorkspaceEvents() {
  const repos = createRepos();
  for (let index = 1; index <= 10; index += 1) {
    const runtime = new AgentRuntime(repos, new MainToCliRunCommandExitLLMClient(`node -e "console.log('skill evidence ${index}')" `));
    await runtime.run({
      agentId: "default-agent",
      userId: "skill-evidence-user",
      userRole: "creator",
      conversationId: "conv-skill-evidence",
      message: `command test turn ${index}`,
      llm: {
        baseUrl: "https://api.302ai.com",
        model: "gpt-5-mini",
        apiKey: "test-key"
      }
    });
  }

  const runtime = new AgentRuntime(repos, new MainToCliRunCommandExitLLMClient("node -e \"console.log('skill evidence trigger')\""));
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "skill-evidence-user",
    userRole: "creator",
    conversationId: "conv-skill-evidence",
    message: "write skill memory: in Node projects inspect package.json and lockfile before choosing commands",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const eventIds = new Set(repos.listMemories({ memoryType: "event", userId: "skill-evidence-user", workspaceId: "dev" }).map((memory) => memory.id));
  const skill = repos.listMemories({ memoryType: "skill", workspaceId: "dev" }).find((memory) => metadataOf(memory).source === "eventSkillCandidate")
    ?? output.memoryWrites.find((memory) => {
      if (memory.memoryType !== "skill") return false;
      const metadata = metadataOf(memory);
      return Array.isArray(metadata.evidenceEventIds) && metadata.evidenceEventIds.every((id: string) => eventIds.has(id));
    });
  assert.equal(Boolean(skill), true);
  const metadata = metadataOf(skill!);
  assert.equal(metadata.qualityGate.evidenceCount > 0, true);
  assert.equal(metadata.evidenceEventIds.length > 0, true);
  assert.equal(metadata.evidenceEventIds.every((id: string) => eventIds.has(id)), true);
}

async function testEventHookSkillExtractionIsDesensitizedAndDeduplicated() {
  const repos = createRepos();
  const firstRuntime = new AgentRuntime(repos, new MainToCliRunCommandExitLLMClient("node -e \"console.log('private Jomy task payload')\""));
  const firstOutput = await firstRuntime.run({
    agentId: "default-agent",
    userId: "hook-skill-user",
    userRole: "creator",
    conversationId: "conv-hook-skill-dedupe-one",
    message: "run a reusable command workflow",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const firstSkill = firstOutput.memoryWrites.find((memory) => memory.memoryType === "skill" && memory.workspaceId === "dev");
  assert.equal(Boolean(firstSkill), true);
  assert.equal(metadataOf(firstSkill!).source, "eventSkillCandidate");
  assert.equal(metadataOf(firstSkill!).evidenceEventIds.length, 2);
  assert.equal(firstSkill!.detail.includes("private Jomy task payload"), false);
  assert.equal(firstSkill!.detail.includes("node -e"), false);
  assert.equal(firstSkill!.detail.includes("结果事件："), false);
  assert.equal(firstSkill!.detail.includes("过程事件："), false);
  assert.equal(firstSkill!.detail.includes("源事件正文"), true);

  const secondRuntime = new AgentRuntime(repos, new MainToCliRunCommandExitLLMClient("node -e \"console.log('another private payload')\""));
  await secondRuntime.run({
    agentId: "default-agent",
    userId: "hook-skill-user",
    userRole: "creator",
    conversationId: "conv-hook-skill-dedupe-two",
    message: "run another similar reusable command workflow",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const skills = repos.listMemories({ memoryType: "skill", workspaceId: "dev" });
  assert.equal(skills.length, 1);
}

async function testMemoryToolCallLoop() {
  const repos = createRepos();
  const fake = new ToolCallingLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "tool-user",
    userRole: "creator",
    conversationId: "conv-tool-memory",
    message: "remember my concise Chinese answer preference",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(output.assistantMessage, "memory saved");
  const writtenImpression = output.memoryWrites.find((memory) => memory.memoryType === "impression" && memory.userId === "tool-user");
  assert.equal(Boolean(writtenImpression), true);
  const mainSession = output.workspaceTrace.find((session) => session.workspaceId === "main");
  const impressionMetadata = metadataOf(writtenImpression!);
  assert.equal(impressionMetadata.activeWorkspaceId, "main");
  assert.equal(impressionMetadata.workspaceSessionId, mainSession?.id);
  assert.equal(impressionMetadata.taskId, mainSession?.taskId);
  const trace = repos.getTrace("conv-tool-memory", "creator", "creator");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "create" && log.resourceId === writtenImpression?.id && log.workspaceId === "main"), true);
  assert.equal(trace.memoryWrites.some((memory) => memory.id === writtenImpression?.id), true);
}

async function testImpressionMemoryToolScopeIsCodeBound() {
  const repos = createRepos();
  const userImpression = new SingleToolRequestLLMClient("writeUserImpression", {
    userId: "other-user",
    title: "Scoped user preference",
    summary: "The model tried to choose the user scope.",
    detail: "Runtime must reject explicit userId on user impression writes."
  });
  const userRuntime = new AgentRuntime(repos, userImpression);
  await userRuntime.run({
    agentId: "default-agent",
    userId: "impression-scope-user",
    userRole: "creator",
    conversationId: "conv-user-impression-scope",
    message: "remember this preference",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(userImpression.lastToolResult.includes("Runtime memory scope is code-bound"), true);
  assert.equal(repos.listMemories({ memoryType: "impression" }).some((memory) => memory.title === "Scoped user preference"), false);
  const userTrace = repos.getTrace("conv-user-impression-scope", "creator", "creator");
  assert.equal(userTrace.toolCalls.some((call) => call.toolName === "writeUserImpression" && call.status === "failed"), true);

  const agentSelf = new SingleToolRequestLLMClient("writeAgentSelfImpression", {
    agentId: "other-agent",
    title: "Scoped self impression",
    summary: "The model tried to choose the agent scope.",
    detail: "Runtime must reject explicit agentId on self impression writes."
  });
  const agentRuntime = new AgentRuntime(repos, agentSelf);
  await agentRuntime.run({
    agentId: "default-agent",
    userId: "impression-scope-user",
    userRole: "creator",
    conversationId: "conv-agent-impression-scope",
    message: "update self impression",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(agentSelf.lastToolResult.includes("Runtime memory scope is code-bound"), true);
  assert.equal(repos.listMemories({ memoryType: "impression" }).some((memory) => memory.title === "Scoped self impression"), false);
  const agentTrace = repos.getTrace("conv-agent-impression-scope", "creator", "creator");
  assert.equal(agentTrace.toolCalls.some((call) => call.toolName === "writeAgentSelfImpression" && call.status === "failed"), true);
}

async function testQuestionLikeImpressionWritesAreRejected() {
  const repos = createRepos();
  const badToolWrite = new SingleToolRequestLLMClient("writeUserImpression", {
    title: "用户身份背景",
    summary: "用户的稳定身份/背景是：谁吗",
    detail: "模型不应把用户提问中的疑问词写成长期身份记忆。"
  });
  const runtime = new AgentRuntime(repos, badToolWrite);
  await runtime.run({
    agentId: "default-agent",
    userId: "question-memory-user",
    userRole: "creator",
    conversationId: "conv-question-memory-tool",
    message: "你知道我是谁吗",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(badToolWrite.lastToolResult.includes("not a question or placeholder"), true);
  assert.equal(repos.listMemories({ memoryType: "impression", userId: "question-memory-user" }).length, 0);

  const hookRuntime = new AgentRuntime(repos, {
    async complete(): Promise<ChatCompletionOutput> {
      return {
        message: {
          role: "assistant",
          content: "我还不知道你是谁，需要你提供或授权我查询后才能确认。"
        },
        raw: { noStableIdentity: true }
      };
    },
    async *stream(): AsyncGenerator<string> {
      yield "我还不知道你是谁，需要你提供或授权我查询后才能确认。";
    }
  });
  await hookRuntime.run({
    agentId: "default-agent",
    userId: "question-memory-user",
    userRole: "creator",
    conversationId: "conv-question-memory-hook",
    message: "我是谁吗",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(repos.listMemories({ memoryType: "impression", userId: "question-memory-user" }).length, 0);
}

async function testMultiStepToolLoop() {
  const repos = createRepos();
  const fake = new MultiStepToolLoopLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "tool-loop-user",
    userRole: "creator",
    conversationId: "conv-tool-loop-multi",
    message: "remember multiple loop preferences",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(output.assistantMessage, "multi-step final");
  assert.equal(fake.calls, 3);
  assert.equal(output.memoryWrites.filter((memory) => memory.memoryType === "impression").length, 2);
  assert.equal(output.finalMessages.filter((message) => message.role === "tool" && message.name === "writeUserImpression").length, 2);
  const trace = repos.getTrace("conv-tool-loop-multi", "creator", "creator");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("toolLoopRound")), true);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "tool_result").length, 2);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "final_messages").length, 3);
  assertFollowUpContextStacksIncludeBaseSegments(trace);
}

async function testToolLoopStopsAtLimit() {
  const repos = createRepos();
  const fake = new NeverEndingToolLoopLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "tool-loop-limit-user",
    userRole: "creator",
    conversationId: "conv-tool-loop-limit",
    message: "remember loop forever",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(output.assistantMessage.length > 0, true);
  assert.equal(fake.calls > 5, true);
  const trace = repos.getTrace("conv-tool-loop-limit", "creator", "creator");
  assert.equal(trace.toolCalls.length > 4, true);
  assert.equal(trace.llmCalls.length, trace.toolCalls.length + 1);
  assert.equal(trace.auditLogs.some((log) => log.action === "tool_loop_stopped"), true);
}

async function testStreamingMemoryToolCallLoop() {
  const repos = createRepos();
  const fake = new StreamingToolCallingLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const events = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "stream-tool-user",
    userRole: "creator",
    conversationId: "conv-stream-tool-memory",
    message: "remember my streaming preference",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    events.push(event);
  }
  assert.equal(events.some((event) => event.type === "delta"), true);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.output.assistantMessage, "stream final");
    assert.equal(done.output.memoryWrites.some((memory) => memory.memoryType === "impression" && memory.userId === "stream-tool-user"), true);
  }
  const trace = repos.getTrace("conv-stream-tool-memory", "creator", "creator");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].toolName, "writeUserImpression");
}

async function testStreamingToolRoundTextIsNotLeaked() {
  const repos = createRepos();
  const fake = new StreamingToolTextLeakLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const deltas: string[] = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "stream-leak-user",
    userRole: "creator",
    conversationId: "conv-stream-leak",
    message: "please remember this without leaking internal text",
    llm: {
      baseUrl: "api.302.ai",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    if (event.type === "delta") deltas.push(event.text);
  }
  const streamedText = deltas.join("");
  assert.equal(streamedText.includes("internal workspace routing text"), false);
  assert.equal(streamedText, "final user answer");
  const trace = repos.getTrace("conv-stream-leak", "creator", "creator");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("internal workspace routing text")), true);
  assert.equal(trace.llmCalls.every((call) => call.providerBaseUrl === "https://api.302ai.com"), true);
  assert.equal(trace.llmCalls.every((call) => call.normalizedEndpoint === "https://api.302ai.com/v1/chat/completions"), true);
}

async function testStreamingChildWorkspaceEventsAreVisible() {
  const repos = createRepos();
  const fake = new StreamingWorkspaceVisibilityLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const events = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "stream-workspace-user",
    userRole: "creator",
    conversationId: "conv-stream-workspace-visible",
    message: "inspect files with visible child workspace messages",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    events.push(event);
  }

  const workspaceEvents = events.filter((event) => event.type === "workspace");
  assert.equal(workspaceEvents.some((event) => event.eventKind === "entered" && event.workspaceId === "dev"), true);
  assert.equal(workspaceEvents.some((event) => event.eventKind === "assistant" && event.text.includes("file workspace explains")), true);
  assert.equal(workspaceEvents.some((event) => event.eventKind === "tool_call" && event.toolNames?.includes("exitWorkspace")), true);
  assert.equal(workspaceEvents.some((event) => event.eventKind === "tool_result" && event.toolNames?.includes("exitWorkspace")), true);
  assert.equal(workspaceEvents.some((event) => event.eventKind === "exit" && event.status === "completed"), true);
  const finalText = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
  assert.equal(finalText, "main final answer");
  assert.equal(finalText.includes("file workspace explains"), false);
  const trace = repos.getTrace("conv-stream-workspace-visible", "creator", "creator");
  const toolCallEvent = workspaceEvents.find((event) => event.eventKind === "tool_call" && event.toolNames?.includes("exitWorkspace"));
  const toolResultEvent = workspaceEvents.find((event) => event.eventKind === "tool_result" && event.toolNames?.includes("exitWorkspace"));
  assert.equal(Boolean(toolCallEvent?.llmCallId), true);
  assert.equal(Boolean(toolResultEvent?.llmCallId), true);
  assert.notEqual(toolResultEvent?.llmCallId, toolCallEvent?.llmCallId);
  assert.equal(trace.contextSegments.some((segment) => segment.llmCallId === toolResultEvent?.llmCallId && segment.segmentType === "tool_result"), true);
  assert.equal(trace.contextSegments.some((segment) => segment.llmCallId === toolResultEvent?.llmCallId && segment.segmentType === "final_messages"), true);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.output.workspaceTrace.some((session) => session.workspaceId === "dev"), true);
  }
}

async function testStreamingMultiStepToolLoop() {
  const repos = createRepos();
  const fake = new StreamingMultiStepToolLoopLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const events = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "stream-loop-user",
    userRole: "creator",
    conversationId: "conv-stream-tool-loop-multi",
    message: "remember multiple streaming loop preferences",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    events.push(event);
  }

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.output.assistantMessage, "stream multi final");
    assert.equal(done.output.memoryWrites.filter((memory) => memory.memoryType === "impression").length, 2);
    assert.equal(done.output.finalMessages.filter((message) => message.role === "tool" && message.name === "writeUserImpression").length, 2);
  }
  assert.equal(fake.calls, 3);
  const trace = repos.getTrace("conv-stream-tool-loop-multi", "creator", "creator");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("toolLoopRound")), true);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "tool_result").length, 2);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "final_messages").length, 3);
  assertFollowUpContextStacksIncludeBaseSegments(trace);
}

async function testStreamingToolLoopStopsAtLimit() {
  const repos = createRepos();
  const fake = new StreamingNeverEndingToolLoopLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const events = [];
  for await (const event of runtime.runStream({
    agentId: "default-agent",
    userId: "stream-loop-limit-user",
    userRole: "creator",
    conversationId: "conv-stream-tool-loop-limit",
    message: "remember streaming loop forever",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  })) {
    events.push(event);
  }

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.output.assistantMessage.includes("\u8fde\u7eed\u64cd\u4f5c\u8f6e\u6b21"), false);
    assert.equal(done.output.assistantMessage.includes("可交付结果"), true);
  }
  assert.equal(fake.calls > 5, true);
  const trace = repos.getTrace("conv-stream-tool-loop-limit", "creator", "creator");
  assert.equal(trace.toolCalls.length > 4, true);
  assert.equal(trace.llmCalls.length, trace.toolCalls.length + 1);
  assert.equal(trace.auditLogs.some((log) => log.action === "tool_loop_stopped"), true);
}

async function testWorkspaceEntryApprovalGate() {
  const repos = createRepos();
  updateWorkspaceGate(repos, "dev", { requiresApproval: 1, riskLevel: "high" });
  const enterArgs = { workspaceId: "dev", objective: "run tests in terminal" };
  const firstFake = new SingleToolRequestLLMClient("enterWorkspace", enterArgs);
  const firstRuntime = new AgentRuntime(repos, firstFake);
  const firstOutput = await firstRuntime.run({
    agentId: "default-agent",
    userId: "workspace-approval-user",
    userRole: "user",
    conversationId: "conv-workspace-entry-approval",
    message: "Please enter the CLI workspace and run the test.",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(firstOutput.activeWorkspaceId, "main");
  assert.equal(firstFake.lastToolResult.includes("requiresApproval"), true);
  assert.equal(firstFake.lastToolResult.includes("approvalRequestId"), true);
  const blockedTrace = repos.getTrace("conv-workspace-entry-approval", "creator", "creator");
  assert.equal(blockedTrace.sessions.some((session) => session.workspaceId === "dev"), false);
  assert.equal(blockedTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "blocked"), true);
  assert.equal(blockedTrace.approvalRequests.length, 1);
  assert.equal(blockedTrace.approvalRequests[0].workspaceId, "dev");
  assert.equal(blockedTrace.approvalRequests[0].toolName, "enterWorkspace");
  assert.equal(blockedTrace.auditLogs.some((log) => log.action === "workspace_enter_rejected" && log.workspaceId === "dev"), true);

  assert.throws(() => repos.resolveApprovalRequest(blockedTrace.approvalRequests[0].id, {
    status: "approved",
    resolvedBy: "workspace-approval-user",
    resolverRole: "user",
    resolutionReason: "ordinary users cannot approve workspace entry"
  }), /creator role/);

  repos.resolveApprovalRequest(blockedTrace.approvalRequests[0].id, {
    status: "approved",
    resolvedBy: "creator",
    resolverRole: "creator",
    resolutionReason: "allow cli entry for this test"
  });
  const retryFake = new SingleToolRequestLLMClient("enterWorkspace", enterArgs);
  const retryRuntime = new AgentRuntime(repos, retryFake);
  const retryOutput = await retryRuntime.run({
    agentId: "default-agent",
    userId: "workspace-approval-user",
    userRole: "user",
    conversationId: "conv-workspace-entry-approval",
    message: "run the approved cli check",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(retryOutput.activeWorkspaceId, "dev");
  assert.equal(retryFake.lastToolResult.includes("workspaceResult"), true);
  const approvedTrace = repos.getTrace("conv-workspace-entry-approval", "creator", "creator");
  assert.equal(approvedTrace.sessions.some((session) => session.workspaceId === "dev"), true);
  assert.equal(approvedTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(approvedTrace.approvalRequests.some((request) => request.workspaceId === "dev" && request.status === "approved"), true);
}

async function testToolPolicyGates() {
  const repos = createRepos();
  const hallucinated = new SingleToolRequestLLMClient("runCommand", { command: "npm test" });
  const runtime = new AgentRuntime(repos, hallucinated);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "tool-policy-user",
    userRole: "creator",
    conversationId: "conv-tool-policy-wrong-workspace",
    message: "hello",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(output.assistantMessage, "tool handled");
  assert.equal(hallucinated.lastToolResult.includes("active workspace"), true);
  const wrongWorkspaceTrace = repos.getTrace("conv-tool-policy-wrong-workspace", "creator", "creator");
  assert.equal(wrongWorkspaceTrace.toolCalls.length, 1);
  assert.equal(wrongWorkspaceTrace.toolCalls[0].toolName, "runCommand");
  assert.equal(wrongWorkspaceTrace.toolCalls[0].status, "blocked");
  const pendingToolAudit = wrongWorkspaceTrace.auditLogs.find((log) => log.action === "hook.beforeToolCall" && log.resourceId === wrongWorkspaceTrace.toolCalls[0].id);
  assert.ok(pendingToolAudit);
  const pendingToolAuditMetadata = JSON.parse(pendingToolAudit.metadataJson) as { toolName?: string; status?: string; toolCallId?: string };
  assert.equal(pendingToolAuditMetadata.toolName, "runCommand");
  assert.equal(pendingToolAuditMetadata.status, "pending");
  assert.equal(pendingToolAuditMetadata.toolCallId, wrongWorkspaceTrace.toolCalls[0].id);
  const blockedToolAudit = wrongWorkspaceTrace.auditLogs.find((log) => log.action === "hook.afterToolCall" && log.resourceId === wrongWorkspaceTrace.toolCalls[0].id);
  assert.ok(blockedToolAudit);
  const blockedToolAuditMetadata = JSON.parse(blockedToolAudit.metadataJson) as { toolName?: string; status?: string; taskId?: string };
  assert.equal(blockedToolAuditMetadata.toolName, "runCommand");
  assert.equal(blockedToolAuditMetadata.status, "blocked");
  assert.equal(typeof blockedToolAuditMetadata.taskId, "string");

  const highRisk = new MainToCliToolRequestLLMClient("runCommand", { command: "npm test" });
  updateWorkspaceGate(repos, "dev", { requiresApproval: 0, riskLevel: "medium" });
  const highRiskRuntime = new AgentRuntime(repos, highRisk);
  await highRiskRuntime.run({
    agentId: "default-agent",
    userId: "tool-policy-user",
    userRole: "user",
    conversationId: "conv-tool-policy-high-risk",
    message: "璇峰湪缁堢杩愯 npm test",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(highRisk.lastToolResult.includes("requiresApproval"), true);
  assert.equal(highRisk.lastToolResult.includes("approvalRequestId"), true);
  const highRiskTrace = repos.getTrace("conv-tool-policy-high-risk", "creator", "creator");
  assert.equal(highRiskTrace.toolCalls.length, 2);
  assert.equal(highRiskTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(highRiskTrace.toolCalls.some((call) => call.toolName === "runCommand" && call.status === "blocked"), true);
  assert.equal(highRiskTrace.approvalRequests.length, 1);
  assert.equal(highRiskTrace.approvalRequests[0].status, "pending");
  assert.equal(highRiskTrace.approvalRequests[0].toolName, "runCommand");
  const resolvedApproval = repos.resolveApprovalRequest(highRiskTrace.approvalRequests[0].id, {
    status: "approved",
    resolvedBy: "creator",
    resolverRole: "creator",
    resolutionReason: "test approval"
  });
  assert.equal(resolvedApproval.status, "approved");
  assert.equal(resolvedApproval.resolvedBy, "creator");
}

async function testRuntimeMemoryToolsAreUniversalAndPolicyGated() {
  const repos = createRepos();
  const agentSelf = new SingleToolRequestLLMClient("writeAgentSelfImpression", {
    title: "Self change",
    summary: "Ordinary user tried to change agent self impression",
    detail: "This should be rejected by memory policy."
  });
  const runtime = new AgentRuntime(repos, agentSelf);
  await runtime.run({
    agentId: "default-agent",
    userId: "ordinary-user",
    userRole: "user",
    conversationId: "conv-agent-self-policy",
    message: "update the agent self impression",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(agentSelf.lastToolResult.includes("requiresApproval"), true);
  assert.equal(repos.listMemories({ memoryType: "impression" }).some((memory) => memory.agentId === "default-agent"), false);
  const trace = repos.getTrace("conv-agent-self-policy", "creator", "creator");
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].toolName, "writeAgentSelfImpression");
  assert.equal(trace.toolCalls[0].status, "blocked");
}

async function testDirectMemoryApiUsesPolicyLayer() {
  const repos = createRepos();
  const service = new MemoryService(repos);
  const metadataJson = JSON.stringify({
    desensitized: true,
    confidence: 0.82,
    qualityGate: {
      reusable: true,
      userPrivateDetailRemoved: true,
      workspaceScoped: true,
      evidenceCount: 1
    },
    procedure: ["Inspect the relevant files.", "Keep the final change scoped to the evidence."],
    appliesWhen: ["A file workspace task needs focused inspection."],
    avoidWhen: ["The method depends on user-specific identifiers or sensitive project details."]
  });

  assert.throws(() => service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Private direct skill",
      summary: "Use G:\\Jomy\\Documents\\PrivateProject before editing.",
      detail: "This direct API write should be rejected.",
      metadataJson
    }
  }), /private user\/project details/);

  const skill = service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Direct API skill",
      summary: "Inspect relevant files before focused edits.",
      detail: "Use evidence from file inspection to keep edits narrow.",
      metadataJson
    }
  });
  assert.equal(skill.memoryType, "skill");

  assert.throws(() => service.updateMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memoryId: skill.id,
    patch: {
      summary: "Use api_key from the project notes before editing."
    }
  }), /private user\/project details/);
  assert.equal(repos.getMemory(skill.id).summary, "Inspect relevant files before focused edits.");

  assert.throws(() => service.deleteMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: skill.id
  }), /Shared skill memory management requires creator role/);
  assert.equal(repos.getMemory(skill.id).id, skill.id);

  repos.ensureConversation("conv-direct-skill-evidence", "default-agent", "ordinary-api-user");
  repos.ensureConversation("conv-other-direct-event", "default-agent", "other-api-user");
  repos.ensureConversation("conv-victim-memory-metadata", "default-agent", "victim-api-user");
  const ownEvent = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Own direct event",
      summary: "The current user inspected files.",
      detail: "This record should be visible to the same user.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", taskId: "task-direct-own-event", eventKind: "manual" })
    }
  });
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "main",
      title: "Forged trace event",
      summary: "This event tries to attach to another user's conversation trace.",
      detail: "The write should be rejected before audit pollution.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-victim-memory-metadata", taskId: "task-forged-trace-event", eventKind: "manual" })
    }
  }), /different user|writing actor/);
  const victimTrace = repos.getTrace("conv-victim-memory-metadata", "victim-api-user", "user");
  assert.equal(victimTrace.auditLogs.some((log) => log.action.includes("memory") && log.actorId === "ordinary-api-user"), false);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    conversationId: "conv-victim-memory-metadata",
    memory: {
      memoryType: "impression",
      userId: "ordinary-api-user",
      title: "Forged API operation trace",
      summary: "This direct API create tries to attach operation audit to another user's trace.",
      detail: "The operation conversationId should be rejected before any memory or audit row is written."
    }
  }), /conversationId belongs to a different user/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "other-api-user",
      workspaceId: "dev",
      title: "Cross user direct event",
      summary: "Ordinary users must not write events for another user.",
      detail: "This direct API write should be rejected by runtime policy.",
      metadataJson: JSON.stringify({ source: "directApiTest", eventKind: "manual" })
    }
  }), /current user/);
  const otherEvent = service.createMemoryRecord({
    actorId: "other-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "other-api-user",
      workspaceId: "dev",
      title: "Other direct event",
      summary: "Another user inspected files.",
      detail: "This record must not be visible to ordinary-api-user.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-other-direct-event", taskId: "task-other-direct-event", eventKind: "manual" })
    }
  });
  assert.throws(() => service.updateMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: otherEvent.id,
    patch: {
      summary: "Ordinary user should not edit another user's event."
    }
  }), /current user/);
  const creatorUpdatedOtherEvent = service.updateMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memoryId: otherEvent.id,
    patch: {
      summary: "Creator maintained another user's event for debugging."
    }
  });
  assert.equal(creatorUpdatedOtherEvent.summary, "Creator maintained another user's event for debugging.");
  const ownImpression = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "ordinary-api-user",
      title: "Own impression",
      summary: "Prefers scoped memory listings.",
      detail: "This record should be visible to the current user.",
      metadataJson: JSON.stringify({ source: "directApiTest", impressionKind: "userImpression" })
    }
  });
  const ownImpressionUpdate = service.updateMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: ownImpression.id,
    conversationId: "conv-direct-skill-evidence",
    patch: {
      summary: "Prefers scoped memory listings and trace-safe edits."
    }
  });
  assert.equal(ownImpressionUpdate.summary, "Prefers scoped memory listings and trace-safe edits.");
  const ownMemoryApiTrace = repos.getTrace("conv-direct-skill-evidence", "ordinary-api-user", "user");
  assert.equal(ownMemoryApiTrace.auditLogs.some((log) => log.action === "memory_api_update" && log.actorId === "ordinary-api-user"), true);
  assert.throws(() => service.updateMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: ownImpression.id,
    conversationId: "conv-victim-memory-metadata",
    patch: {
      summary: "This update should not attach to another user's trace."
    }
  }), /conversationId belongs to a different user/);
  assert.equal(repos.getMemory(ownImpression.id).summary, "Prefers scoped memory listings and trace-safe edits.");
  assert.throws(() => service.deleteMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: ownImpression.id,
    conversationId: "conv-victim-memory-metadata",
    deleteReason: "forged trace delete"
  }), /conversationId belongs to a different user/);
  const victimTraceAfterApiOps = repos.getTrace("conv-victim-memory-metadata", "victim-api-user", "user");
  assert.equal(victimTraceAfterApiOps.auditLogs.some((log) => log.action.includes("memory_api") && log.actorId === "ordinary-api-user"), false);
  const otherImpression = service.createMemoryRecord({
    actorId: "other-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "other-api-user",
      title: "Other impression",
      summary: "Another user prefers isolated memory management.",
      detail: "This record should be maintainable by creator only.",
      metadataJson: JSON.stringify({ source: "directApiTest", impressionKind: "userImpression" })
    }
  });
  assert.throws(() => service.updateMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: ownImpression.id,
    patch: {
      userId: "other-api-user"
    }
  }), /current user/);
  assert.throws(() => service.updateMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: ownImpression.id,
    patch: {
      workspaceId: "dev"
    }
  }), /cross-workspace/);
  assert.equal(repos.getMemory(ownImpression.id).userId, "ordinary-api-user");
  assert.equal(repos.getMemory(ownImpression.id).workspaceId, null);
  assert.throws(() => service.deleteMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memoryId: otherImpression.id
  }), /current user/);
  service.deleteMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memoryId: otherImpression.id,
    deleteReason: "creator debug cleanup"
  });
  assert.equal(repos.getMemoryIncludingDeleted(otherImpression.id).deletedBy, "creator");
  const ownCliEvent = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "main",
      title: "Own CLI event",
      summary: "The current user ran a CLI check.",
      detail: "This event belongs to a different workspace than the file skill.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", taskId: "task-direct-cli-event", eventKind: "manual" })
    }
  });
  const evidenceSkillMetadata = (eventIds: string[], conversationId = "conv-direct-skill-evidence") => JSON.stringify({
    desensitized: true,
    confidence: 0.82,
    evidenceEventIds: eventIds,
    conversationId,
    qualityGate: {
      reusable: true,
      userPrivateDetailRemoved: true,
      workspaceScoped: true,
      evidenceCount: eventIds.length
    },
    procedure: ["Inspect same-workspace evidence.", "Keep the reusable method detached from private details."],
    appliesWhen: ["A file workspace task has event evidence from the current user."],
    avoidWhen: ["The evidence belongs to another user, workspace, or conversation."]
  });
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Evidence-backed direct skill",
      summary: "Use same-workspace event evidence before sharing a file workflow.",
      detail: "This reusable method is backed by current-user file workspace evidence.",
      metadataJson: evidenceSkillMetadata([ownEvent.id], "conv-direct-skill-evidence")
    }
  }), /creator role/);
  const evidenceBackedSkill = service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Evidence-backed direct skill",
      summary: "Use same-workspace event evidence before sharing a file workflow.",
      detail: "This reusable method is backed by current-user file workspace evidence.",
      metadataJson: evidenceSkillMetadata([ownEvent.id], "conv-direct-skill-evidence")
    }
  });
  assert.equal(evidenceBackedSkill.memoryType, "skill");
  assert.throws(() => service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Cross workspace evidence skill",
      summary: "Use CLI evidence for a file workspace skill.",
      detail: "This should be rejected because evidence must belong to the same workspace.",
      metadataJson: evidenceSkillMetadata([ownCliEvent.id])
    }
  }), /same workspace/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Non event evidence skill",
      summary: "Use an impression record as skill evidence.",
      detail: "This should be rejected because evidence ids must point to event memory.",
      metadataJson: evidenceSkillMetadata([ownImpression.id])
    }
  }), /event memory/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Missing evidence skill",
      summary: "Use a missing memory id as skill evidence.",
      detail: "This should be rejected because the evidence record does not exist.",
      metadataJson: evidenceSkillMetadata(["mem_missing"])
    }
  }), /not found/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "skill",
      workspaceId: "dev",
      title: "Cross conversation evidence skill",
      summary: "Use an event from a different conversation as skill evidence.",
      detail: "This should be rejected because conversation evidence must match when declared.",
      metadataJson: evidenceSkillMetadata([ownEvent.id], "conv-other")
    }
  }), /same conversation/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Event without conversation",
      summary: "Event memory must include conversation evidence.",
      detail: "This should be rejected because event metadata needs a conversation id.",
      metadataJson: JSON.stringify({ source: "directApiTest", eventKind: "manual" })
    }
  }), /metadata\.conversationId/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Event without task id",
      summary: "Event memory must include task evidence.",
      detail: "This should be rejected because event metadata needs a task id.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", eventKind: "manual" })
    }
  }), /metadata\.taskId/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Event with bad kind",
      summary: "Event memory must include a recognized kind.",
      detail: "This should be rejected because eventKind is not part of the event contract.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", taskId: "task-direct-bad-kind", eventKind: "note" })
    }
  }), /metadata\.eventKind/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Event with invalid metadata",
      summary: "Memory metadata must remain parseable.",
      detail: "This should be rejected because metadataJson is invalid.",
      metadataJson: "{not-json"
    }
  }), /metadataJson must be valid JSON/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "other-api-user",
      title: "Cross user impression",
      summary: "Ordinary users must not write impressions for another user.",
      detail: "This should be rejected even without an impressionKind marker."
    }
  }), /current user/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      title: "Unscoped impression",
      summary: "Impressions must not be global.",
      detail: "This should be rejected because it has no userId or agentId."
    }
  }), /creator role/);
  const agentScopedUserImpression = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "ordinary-api-user",
      agentId: "default-agent",
      title: "Agent scoped user impression",
      summary: "User impressions are isolated under the current agent.",
      detail: "This should be accepted because user memories now require an agent scope."
    }
  });
  assert.equal(agentScopedUserImpression.agentId, "default-agent");
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      agentId: "default-agent",
      title: "Unauthorized agent self impression",
      summary: "Ordinary users must not write agent self impressions.",
      detail: "This should be rejected even without an impressionKind marker."
    }
  }), /creator role/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "ordinary-api-user",
      workspaceId: "dev",
      title: "Workspace scoped impression",
      summary: "Impressions are cross-workspace.",
      detail: "This should be rejected because impression memory must not set workspaceId."
    }
  }), /cross-workspace/);
  const agentSelf = service.createMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memory: {
      memoryType: "impression",
      agentId: "default-agent",
      title: "Agent self direct impression",
      summary: "Creator-controlled agent self identity.",
      detail: "This record should not be listed to ordinary users through direct API.",
      metadataJson: JSON.stringify({ source: "directApiTest", impressionKind: "agentSelf" })
    }
  });

  const ordinaryList = service.listMemoryRecords({
    actorId: "ordinary-api-user",
    actorRole: "user",
    filters: { agentId: "default-agent" }
  });
  assert.equal(ordinaryList.some((memory) => memory.id === ownEvent.id), true);
  assert.equal(ordinaryList.some((memory) => memory.id === ownImpression.id), true);
  assert.equal(ordinaryList.some((memory) => memory.id === skill.id), true);
  assert.equal(ordinaryList.some((memory) => memory.id === otherEvent.id), false);
  assert.equal(ordinaryList.some((memory) => memory.id === agentSelf.id), false);

  const creatorList = service.listMemoryRecords({
    actorId: "creator",
    actorRole: "creator"
  });
  assert.equal(creatorList.some((memory) => memory.id === otherEvent.id), true);
  assert.equal(creatorList.some((memory) => memory.id === agentSelf.id), true);

  service.deleteMemoryRecord({
    actorId: "creator",
    actorRole: "creator",
    memoryId: evidenceBackedSkill.id,
    deleteReason: "retire shared skill fixture"
  });
  assert.equal(repos.getMemoryIncludingDeleted(evidenceBackedSkill.id).deletedBy, "creator");
  assert.equal(repos.getMemoryIncludingDeleted(evidenceBackedSkill.id).deleteReason, "retire shared skill fixture");
  assert.equal(service.listMemoryRecords({
    actorId: "creator",
    actorRole: "creator",
    filters: { memoryType: "skill", workspaceId: "dev" }
  }).some((memory) => memory.id === evidenceBackedSkill.id), false);
  assert.equal(repos.recallMemories({
    userId: "ordinary-api-user",
    agentId: "default-agent",
    workspaceId: "dev",
    query: "Evidence-backed direct skill"
  }).some((memory) => memory.id === evidenceBackedSkill.id), false);
  const deletedSkillRead = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "ordinary-api-user",
      userRole: "user",
      conversationId: "conv-direct-skill-evidence",
      message: "read deleted skill"
    },
    activeWorkspaceId: "dev",
    toolName: "readSkill",
    argumentsJson: JSON.stringify({ skillId: evidenceBackedSkill.id })
  });
  assert.equal(deletedSkillRead.ok, false);
  assert.equal(JSON.stringify(deletedSkillRead.result).includes("not found"), true);
}

async function testSearchMemoryToolUsesPolicyLayer() {
  const repos = createRepos();
  const service = new MemoryService(repos);
  const ownEvent = repos.createMemory({
    memoryType: "event",
    userId: "search-user",
    workspaceId: "dev",
    title: "Search own event",
    summary: "Policy search alpha event",
    detail: "Visible to the owning user."
  }, "creator", "creator");
  const dottedOwnEvent = repos.createMemory({
    memoryType: "event",
    userId: "search-user",
    workspaceId: "dev",
    title: "Search dotted provider event",
    summary: "Policy search 302.AI event",
    detail: "Dotted provider names must be safe in searchMemory."
  }, "creator", "creator");
  const ownImpression = repos.createMemory({
    memoryType: "impression",
    userId: "search-user",
    title: "Search own impression",
    summary: "Policy search alpha impression",
    detail: "The user has a stable identity detail that should only be loaded through readMemory.",
    metadataJson: JSON.stringify({ impressionKind: "userImpression" })
  }, "creator", "creator");
  const otherEvent = repos.createMemory({
    memoryType: "event",
    userId: "other-search-user",
    workspaceId: "dev",
    title: "Search other event",
    summary: "Policy search alpha event",
    detail: "Hidden from non-creator search."
  }, "creator", "creator");
  const sharedSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "dev",
    title: "Search shared skill",
    summary: "Policy search alpha skill",
    detail: "Shared workspace skill visible to users.",
    metadataJson: JSON.stringify({
      desensitized: true,
      confidence: 0.9,
      procedure: ["Use file search before editing."],
      appliesWhen: ["File workspace needs existing code evidence."],
      avoidWhen: ["The task belongs to CLI execution."]
    })
  }, "creator", "creator");
  const siblingSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "main",
    title: "Hidden sibling skill",
    summary: "Policy search alpha cli skill",
    detail: "This CLI skill must not be readable from file workspace.",
    metadataJson: JSON.stringify({
      desensitized: true,
      confidence: 0.9,
      procedure: ["Run commands after confirming risk."],
      appliesWhen: ["CLI workspace needs command execution."],
      avoidWhen: ["The task belongs to file search."]
    })
  }, "creator", "creator");
  const agentSelf = repos.createMemory({
    memoryType: "impression",
    agentId: "default-agent",
    title: "Search agent self",
    summary: "Policy search alpha self",
    detail: "Creator-only inspection record.",
    metadataJson: JSON.stringify({ impressionKind: "agentSelf" })
  }, "creator", "creator");

  const userResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "search memory"
    },
    activeWorkspaceId: "dev",
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha" })
  });
  assert.equal(userResult.ok, true);
  const userMemories = (userResult.result as { memories: MemoryRow[] }).memories;
  assert.equal(userMemories.some((memory) => memory.id === ownEvent.id), true);
  assert.equal(userMemories.some((memory) => memory.id === ownImpression.id), true);
  assert.equal(userMemories.some((memory) => memory.id === sharedSkill.id), true);
  assert.equal(userMemories.some((memory) => memory.id === otherEvent.id), false);
  assert.equal(userMemories.some((memory) => memory.id === agentSelf.id), false);
  assert.equal(JSON.stringify(userMemories).includes("stable identity detail"), false);
  assert.equal(JSON.stringify(userMemories).includes("Visible to the owning user."), false);
  const ownEventProjection = userMemories.find((memory) => memory.id === ownEvent.id) as unknown as Record<string, unknown>;
  const ownImpressionProjection = userMemories.find((memory) => memory.id === ownImpression.id) as unknown as Record<string, unknown>;
  const sharedSkillProjection = userMemories.find((memory) => memory.id === sharedSkill.id) as unknown as Record<string, unknown>;
  for (const projection of [ownEventProjection, ownImpressionProjection, sharedSkillProjection]) {
    assert.equal(projection.disclosure, "summary_only");
    assert.equal(projection.detailAvailable, true);
    assert.equal(projection.detailInjected, false);
    assert.equal(Boolean(projection.detail), false);
    assert.equal(Boolean(projection.detailSnippet), false);
  }
  assert.equal(ownEventProjection.readTool, "readMemory");
  assert.equal(ownImpressionProjection.readTool, "readMemory");
  assert.equal(sharedSkillProjection.readTool, "readSkill");
  assert.equal(String(ownEventProjection.readInstruction ?? "").includes("readMemory"), true);
  assert.equal(JSON.stringify(userMemories).includes("readMemory"), true);
  const dottedUserResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user-dotted",
      message: "search dotted memory"
    },
    activeWorkspaceId: "dev",
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "302.AI", reason: "用户提到带点号的 provider 名称，需要安全检索记忆。" })
  });
  assert.equal(dottedUserResult.ok, true);
  assert.equal(((dottedUserResult.result as { memories: MemoryRow[] }).memories).some((memory) => memory.id === dottedOwnEvent.id), true);

  const readMemoryResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "read memory"
    },
    activeWorkspaceId: "dev",
    toolName: "readMemory",
    argumentsJson: JSON.stringify({ memoryId: ownImpression.id })
  });
  assert.equal(readMemoryResult.ok, true);
  assert.equal((readMemoryResult.result as { memory: { detail: string; memoryType: string } }).memory.memoryType, "impression");
  assert.equal((readMemoryResult.result as { memory: { detail: string } }).memory.detail.includes("stable identity detail"), true);

  const readSkillResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "read skill"
    },
    activeWorkspaceId: "dev",
    toolName: "readSkill",
    argumentsJson: JSON.stringify({ skillId: sharedSkill.id })
  });
  assert.equal(readSkillResult.ok, true);
  assert.equal((readSkillResult.result as { skill: { detail: string; procedure: string[] } }).skill.detail.includes("Shared workspace skill"), true);
  assert.equal((readSkillResult.result as { skill: { detail: string; procedure: string[] } }).skill.procedure[0], "Use file search before editing.");

  const siblingRead = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "read sibling skill"
    },
    activeWorkspaceId: "dev",
    toolName: "readSkill",
    argumentsJson: JSON.stringify({ skillId: siblingSkill.id })
  });
  assert.equal(siblingRead.ok, false);
  assert.equal(JSON.stringify(siblingRead.result).includes("active workspace"), true);

  const scopedRead = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "read skill with bad scope"
    },
    activeWorkspaceId: "dev",
    toolName: "readSkill",
    argumentsJson: JSON.stringify({ skillId: sharedSkill.id, workspaceId: "dev" })
  });
  assert.equal(scopedRead.ok, false);
  assert.equal(JSON.stringify(scopedRead.result).includes("code-bound"), true);

  const siblingMemoryRead = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user",
      message: "read sibling memory"
    },
    activeWorkspaceId: "dev",
    toolName: "readMemory",
    argumentsJson: JSON.stringify({ memoryId: siblingSkill.id })
  });
  assert.equal(siblingMemoryRead.ok, false);
  assert.equal(JSON.stringify(siblingMemoryRead.result).includes("active workspace"), true);

  const userTargetingOther = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user-target",
      message: "search memory"
    },
    activeWorkspaceId: "dev",
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", memoryType: "event", userId: "other-search-user" })
  });
  assert.equal(userTargetingOther.ok, false);
  assert.equal(JSON.stringify(userTargetingOther.result).includes("code-bound"), true);

  const creatorResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "creator",
      userRole: "creator",
      conversationId: "conv-search-memory-creator",
      message: "search memory"
    },
    activeWorkspaceId: "dev",
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha" })
  });
  assert.equal(creatorResult.ok, true);
  const creatorMemories = (creatorResult.result as { memories: MemoryRow[] }).memories;
  assert.equal(creatorMemories.some((memory) => memory.id === ownEvent.id), false);
  assert.equal(creatorMemories.some((memory) => memory.id === otherEvent.id), false);
  assert.equal(creatorMemories.some((memory) => memory.id === sharedSkill.id), true);

  const creatorSelfResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "creator",
      userRole: "creator",
      conversationId: "conv-search-memory-creator-self",
      message: "search memory"
    },
    activeWorkspaceId: "dev",
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", memoryType: "impression" })
  });
  assert.equal((creatorSelfResult.result as { memories: MemoryRow[] }).memories.some((memory) => memory.id === agentSelf.id), false);
  const directCreatorList = service.listMemoryRecords({
    actorId: "creator",
    actorRole: "creator",
    filters: { query: "alpha" }
  });
  assert.equal(directCreatorList.some((memory) => memory.id === otherEvent.id), true);
  assert.equal(directCreatorList.some((memory) => memory.id === agentSelf.id), true);
}

async function testToolBindingsAndMcpReadiness() {
  const repos = createRepos();
  const searchFiles = repos.listTools().find((tool) => tool.name === "searchFiles");
  const readFile = repos.listTools().find((tool) => tool.name === "readFile");
  const writeFile = repos.listTools().find((tool) => tool.name === "writeFile");
  const runCommand = repos.listTools().find((tool) => tool.name === "runCommand");
  const exitWorkspace = repos.listTools().find((tool) => tool.name === "exitWorkspace");
  const writeUserImpression = repos.listTools().find((tool) => tool.name === "writeUserImpression");
  const writeSkillMemory = repos.listTools().find((tool) => tool.name === "writeSkillMemory");
  const searchMemory = repos.listTools().find((tool) => tool.name === "searchMemory");
  const readMemory = repos.listTools().find((tool) => tool.name === "readMemory");
  const readSkill = repos.listTools().find((tool) => tool.name === "readSkill");
  assert.equal(searchFiles?.bindingType, "runtime");
  assert.equal(searchFiles?.mcpServerId, null);
  assert.equal(readFile?.bindingType, "runtime");
  assert.equal(writeFile?.bindingType, "runtime");
  assert.equal(runCommand?.bindingType, "runtime");
  assert.equal(runCommand?.mcpToolName, null);
  assert.equal(exitWorkspace?.bindingType, "runtime");
  assert.equal(writeUserImpression?.bindingType, "runtime");
  assert.equal(writeSkillMemory?.bindingType, "runtime");
  assert.equal(searchMemory?.bindingType, "runtime");
  assert.equal(searchMemory?.description.includes("低频补查记忆"), true);
  assert.equal(searchMemory?.description.includes("自动召回不足"), true);
  assert.equal(readMemory?.bindingType, "runtime");
  assert.equal(readMemory?.description.includes("完整详情"), true);
  assert.equal(readMemory?.description.includes("详细说说"), true);
  assert.equal(readSkill?.bindingType, "runtime");
  assert.equal(repos.listTools().some((tool) => tool.name === "writeEventMemory"), false);
  assert.equal(repos.listTools().some((tool) => tool.name === "updateMemory"), false);
  assert.equal(repos.listTools().some((tool) => tool.name === "deleteMemory"), false);
  assert.equal(repos.listWorkspaces().some((workspace) => workspace.id === "memory"), false);
  assert.equal(repos.listToolsForWorkspace("main").some((tool) => tool.name === "writeEventMemory"), false);
  assert.equal(repos.listToolsForWorkspace("dev").some((tool) => tool.name === "updateMemory"), false);
  assert.equal(repos.listToolsForWorkspace("dev").some((tool) => tool.name === "deleteMemory"), false);
  const exitWorkspaceSchema = JSON.parse(exitWorkspace?.parametersJson ?? "{}") as { required?: string[] };
  for (const field of ["status", "summary", "artifacts", "observations", "errors", "suggestedNextSteps"]) {
    assert.equal(exitWorkspaceSchema.required?.includes(field), true);
  }
  const searchFilesSchema = JSON.parse(searchFiles?.parametersJson ?? "{}") as { required?: string[] };
  assert.equal(searchFilesSchema.required?.includes("reason"), true);
  const searchMemorySchema = JSON.parse(searchMemory?.parametersJson ?? "{}") as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(searchMemorySchema.required?.includes("reason"), true);
  assert.equal(Boolean(searchMemorySchema.properties?.memoryType), true);
  assert.equal(Boolean(searchMemorySchema.properties?.userId), false);
  assert.equal(Boolean(searchMemorySchema.properties?.agentId), false);
  assert.equal(Boolean(searchMemorySchema.properties?.workspaceId), false);
  const readMemorySchema = JSON.parse(readMemory?.parametersJson ?? "{}") as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(readMemorySchema.required?.includes("reason"), true);
  assert.equal(readMemorySchema.required?.includes("memoryId"), true);
  assert.equal(Boolean(readMemorySchema.properties?.workspaceId), false);
  assert.equal(Boolean(readMemorySchema.properties?.userId), false);
  assert.equal(Boolean(readMemorySchema.properties?.memoryType), false);
  const readSkillSchema = JSON.parse(readSkill?.parametersJson ?? "{}") as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(readSkillSchema.required?.includes("skillId"), true);
  assert.equal(Boolean(readSkillSchema.properties?.workspaceId), false);
  assert.equal(Boolean(readSkillSchema.properties?.userId), false);
  const writeSkillMemorySchema = JSON.parse(writeSkillMemory?.parametersJson ?? "{}") as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(Boolean(writeSkillMemorySchema.properties?.workspaceId), false);
  assert.equal(writeSkillMemorySchema.required?.includes("workspaceId"), false);
  const runCommandSchema = JSON.parse(runCommand?.parametersJson ?? "{}") as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(runCommandSchema.required?.includes("reason"), true);
  assert.equal(Boolean(runCommandSchema.properties?.cwd), true);
  assert.equal(Boolean(runCommandSchema.properties?.timeoutMs), true);
  const readFileSchema = JSON.parse(readFile?.parametersJson ?? "{}") as { required?: string[] };
  const writeFileSchema = JSON.parse(writeFile?.parametersJson ?? "{}") as { required?: string[] };
  assert.equal(readFileSchema.required?.includes("reason"), true);
  assert.equal(writeFileSchema.required?.includes("reason"), true);

  const builtinFileTool = new MainToWorkspaceToolRequestLLMClient("dev", "searchFiles", { reason: "验证 runtime 文件是否存在", query: "runtime" });
  const runtime = new AgentRuntime(repos, builtinFileTool);
  await runtime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-file-runtime",
    message: "search files for runtime",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(builtinFileTool.lastToolResult.includes("\"count\""), true);
  const fileTrace = repos.getTrace("conv-tool-binding-file-runtime", "creator", "creator");
  assert.equal(fileTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(fileTrace.toolCalls.some((call) => call.toolName === "searchFiles" && call.status === "completed"), true);
  const fileSession = fileTrace.sessions.find((session) => session.workspaceId === "dev");
  assert.equal(fileSession?.localContext.recentToolCalls.some((call) => call.toolName === "searchFiles" && call.status === "completed"), true);
  assert.equal(fileSession?.result.observations.some((item) => item.includes("Tool searchFiles finished with status completed")), true);

  const fileToolConversationId = "conv-tool-binding-file-workspace";
  const scratchDir = conversationWorkspaceRoot(fileToolConversationId);
  const oldProjectScratchDir = path.resolve("zleap-tool-scratch");
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(oldProjectScratchDir, { recursive: true, force: true });
  const builtinWriteFileTool = new MainToWorkspaceToolRequestLLMClient("dev", "writeFile", {
    reason: "创建一个可被 readFile 验证的测试文件",
    path: "zleap-tool-scratch/read-write-test.txt",
    content: "zleap file tool ok",
    createDirs: true
  });
  const writeFileRuntime = new AgentRuntime(repos, builtinWriteFileTool);
  await writeFileRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: fileToolConversationId,
    message: "write a test file",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(builtinWriteFileTool.lastToolResult.includes("\"created\":true"), true);
  assert.equal(await pathExists(path.join(scratchDir, "zleap-tool-scratch", "read-write-test.txt")), true);
  assert.equal(await pathExists(path.join(oldProjectScratchDir, "read-write-test.txt")), false);
  assert.equal(scratchDir.startsWith(defaultFileWorkspaceBaseRoot()), true);
  assert.equal(defaultFileWorkspaceBaseRoot().endsWith(path.join("Documents", "Zleap", "conversations")), true);
  assert.equal(builtinWriteFileTool.lastToolResult.includes(".codex"), false);

  const builtinReadFileTool = new MainToWorkspaceToolRequestLLMClient("dev", "readFile", {
    reason: "读取刚写入的测试文件确认专用文件工具可用",
    path: "zleap-tool-scratch/read-write-test.txt"
  });
  const readFileRuntime = new AgentRuntime(repos, builtinReadFileTool);
  await readFileRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: fileToolConversationId,
    message: "read the test file",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(builtinReadFileTool.lastToolResult.includes("zleap file tool ok"), true);
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(oldProjectScratchDir, { recursive: true, force: true });

  const builtinCliTool = new MainToWorkspaceToolRequestLLMClient("dev", "runCommand", { reason: "验证命令工具只承担终端执行任务", command: "node -e \"console.log('zleap-cli-ok')\"" });
  const cliRuntime = new AgentRuntime(repos, builtinCliTool);
  await cliRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-cli-runtime",
    message: "run a harmless command",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(builtinCliTool.lastToolResult.includes("zleap-cli-ok"), true);
  const cliTrace = repos.getTrace("conv-tool-binding-cli-runtime", "creator", "creator");
  assert.equal(cliTrace.toolCalls.some((call) => call.toolName === "runCommand" && call.status === "completed"), true);

  const echoServerPath = path.resolve("src/tests/fixtures/mcp-echo-server.mjs");
  const echoServer = repos.upsertMcpServer({
    id: "mcp-file-echo",
    workspaceId: "dev",
    name: "Test Echo MCP",
    transport: "stdio",
    command: process.execPath,
    argsJson: JSON.stringify([echoServerPath]),
    envJson: "{}",
    headersJson: "{}",
    timeoutMs: 10000,
    actorId: "creator",
    actorRole: "creator"
  });
  assert.equal(echoServer.transport, "stdio");
  assert.equal(JSON.parse(mcpServerToBindingJson(echoServer)).command, process.execPath);
  assert.throws(() => repos.upsertMcpServer({
    workspaceId: "dev",
    name: "User server",
    transport: "stdio",
    command: process.execPath,
    argsJson: "[]",
    envJson: "{}",
    headersJson: "{}",
    actorId: "tool-binding-user",
    actorRole: "user"
  }), /creator role/);
  const discoveredEchoTools = await new McpToolExecutor().discoverTools(mcpServerToBindingJson(echoServer));
  assert.equal(discoveredEchoTools.some((tool) => tool.name === "echo"), true);
  const importedEchoTools = repos.importMcpServerTools({
    workspaceId: "dev",
    serverId: echoServer.id,
    tools: discoveredEchoTools,
    actorId: "creator",
    actorRole: "creator"
  });
  const importedEcho = importedEchoTools.find((tool) => tool.name === "echo");
  assert.equal(importedEcho?.bindingType, "mcp");
  assert.equal(importedEcho?.mcpServerId, echoServer.id);
  assert.equal(importedEcho?.mcpToolName, "echo");
  const echoClient = new MainToWorkspaceToolRequestLLMClient("dev", "echo", { text: "hello" });
  const echoRuntime = new AgentRuntime(repos, echoClient);
  await echoRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-mcp-echo",
    message: "echo hello through mcp",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(echoClient.lastToolResult.includes("echo:hello"), true);
  const echoTrace = repos.getTrace("conv-tool-binding-mcp-echo", "creator", "creator");
  assert.equal(echoTrace.toolCalls.some((call) => call.toolName === "echo" && call.status === "completed"), true);

  const placeholderTool = repos.upsertWorkspaceTool({
    id: "tool-placeholder-probe",
    workspaceId: "dev",
    name: "placeholderProbe",
    description: "Registered but intentionally unbound test tool.",
    parametersJson: JSON.stringify({
      type: "object",
      properties: {
        reason: { type: "string" }
      },
      required: ["reason"]
    }),
    riskLevel: "low",
    bindingType: "placeholder",
    bindingJson: "{}",
    actorId: "creator",
    actorRole: "creator"
  });
  assert.equal(placeholderTool.bindingType, "placeholder");
  const placeholderClient = new MainToWorkspaceToolRequestLLMClient("dev", "placeholderProbe", { reason: "验证 placeholder 不会静默执行" });
  const placeholderRuntime = new AgentRuntime(repos, placeholderClient);
  await placeholderRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-placeholder",
    message: "call a placeholder tool",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(placeholderClient.lastToolResult.includes("not bound to a runtime or MCP executor"), true);
  const placeholderTrace = repos.getTrace("conv-tool-binding-placeholder", "creator", "creator");
  assert.equal(placeholderTrace.toolCalls.some((call) => call.toolName === "placeholderProbe" && call.status === "failed"), true);

  const enterWorkspace = new SingleToolRequestLLMClient("enterWorkspace", { workspaceId: "dev", objective: "search runtime files" });
  const enterRuntime = new AgentRuntime(repos, enterWorkspace);
  await enterRuntime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-runtime",
    message: "hello",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(enterWorkspace.lastToolResult.includes("workspaceResult"), true);
  const runtimeTrace = repos.getTrace("conv-tool-binding-runtime", "creator", "creator");
  assert.equal(runtimeTrace.toolCalls[0].status, "completed");
  assert.equal(runtimeTrace.sessions.some((session) => session.workspaceId === "dev"), true);
  const runtimeMainSession = runtimeTrace.sessions.find((session) => session.workspaceId === "main");
  assert.equal(runtimeMainSession?.localContext.recentToolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
}

async function testSeedRefreshesExistingToolSchemas() {
  const db = new Database(":memory:");
  migrate(db);
  seedDefaults(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tool_definitions (id, name, description, parametersJson, bindingType, bindingJson, riskLevel, createdAt, updatedAt)
    VALUES
      ('tool-write-event-memory', 'writeEventMemory', 'legacy event tool', '{}', 'runtime', '{}', 'medium', ?, ?),
      ('tool-update-memory', 'updateMemory', 'legacy update tool', '{}', 'runtime', '{}', 'medium', ?, ?),
      ('tool-delete-memory', 'deleteMemory', 'legacy delete tool', '{}', 'runtime', '{}', 'medium', ?, ?)
  `).run(now, now, now, now, now, now);
  db.prepare("INSERT INTO workspace_tools (workspaceId, toolId, createdAt) VALUES ('main', 'tool-update-memory', ?)").run(now);
  seedDefaults(db);
  const repos = new Repositories(db);
  assert.equal(repos.listTools().some((tool) => tool.name === "writeEventMemory"), false);
  assert.equal(repos.listTools().some((tool) => tool.name === "updateMemory"), false);
  assert.equal(repos.listTools().some((tool) => tool.name === "deleteMemory"), false);
  assert.equal(repos.listToolsForWorkspace("main").some((tool) => tool.name === "updateMemory"), false);
}

async function testLlmFailureLog() {
  const repos = createRepos();
  const runtime = new AgentRuntime(repos, new FailingLLMClient());
  await assert.rejects(() => runtime.run({
    agentId: "default-agent",
    userId: "user",
    userRole: "creator",
    conversationId: "conv-fail",
    message: "hello",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  }), /provider timeout/);
  const trace = repos.getTrace("conv-fail", "creator", "creator");
  assert.equal(trace.llmCalls.length, 1);
  assert.equal(trace.llmCalls[0].status, "failed");
  assert.equal(trace.llmCalls[0].errorText, "provider timeout");
  assert.equal(repos.listMessagesDetailed("conv-fail").length, 0);
  assert.equal(trace.auditLogs.some((log) => log.action === "failed_run_message_removed"), true);
}

async function testRuntimeConfigControlsRuntimeLimits() {
  const repos = createRepos();
  assert.equal(repos.listRuntimeConfigs("creator").some((item) => item.key === "memory.resultEventRecallLimit"), true);
  assert.throws(() => repos.listRuntimeConfigs("user"), /creator role/);
  repos.updateRuntimeConfig({ key: "memory.impressionRecallLimit", value: 11, actorId: "creator", actorRole: "creator" });
  repos.updateRuntimeConfig({ key: "memory.resultEventRecallLimit", value: 4, actorId: "creator", actorRole: "creator" });
  repos.updateRuntimeConfig({ key: "memory.processEventRecallLimit", value: 2, actorId: "creator", actorRole: "creator" });
  repos.updateRuntimeConfig({ key: "llm.maxProviderAttempts", value: 3, actorId: "creator", actorRole: "creator" });
  assert.equal(repos.getRuntimeConfigValues()["memory.resultEventRecallLimit"], 4);

  const fake = new FakeLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  await runtime.run({
    agentId: "default-agent",
    userId: "config-user",
    userRole: "creator",
    conversationId: "conv-runtime-config",
    message: "测试运行配置",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(fake.lastInput?.maxProviderAttempts, 3);
  const recallLog = repos
    .listAuditLogs({ conversationId: "conv-runtime-config", limit: 20 })
    .find((log) => log.action === "memory_recall_requested");
  const metadata = JSON.parse(recallLog?.metadataJson ?? "{}") as { recallInput?: Record<string, unknown> };
  assert.equal(metadata.recallInput?.impressionLimit, 11);
  assert.equal(metadata.recallInput?.resultEventLimit, 4);
  assert.equal(metadata.recallInput?.processEventLimit, 2);
}

async function testStreamingFollowUpFailureMarksLlmCallFailed() {
  const repos = createRepos();
  const runtime = new AgentRuntime(repos, new StreamingToolThenFailureLLMClient());
  await assert.rejects(async () => {
    for await (const _event of runtime.runStream({
      agentId: "default-agent",
      userId: "stream-failure-user",
      userRole: "user",
      conversationId: "conv-stream-followup-fail",
      message: "remember this, then continue",
      llm: {
        baseUrl: "https://api.302ai.com",
        model: "gpt-5-mini",
        apiKey: "test-key"
      }
    })) {
      // Drain the stream until the fake provider throws on the follow-up call.
    }
  }, /provider stream idle timeout/);

  const trace = repos.getTrace("conv-stream-followup-fail", "stream-failure-user", "user");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.some((call) => call.status === "failed" && call.errorText === "provider stream idle timeout"), true);
  assert.equal(trace.llmCalls.some((call) => call.status === "completed"), true);
  assert.equal(repos.listMessagesDetailed("conv-stream-followup-fail").length, 0);
  assert.equal(trace.auditLogs.some((log) => log.action === "failed_run_message_removed"), true);
}

async function testPendingLlmCallsInterruptedOnStartup() {
  const repos = createRepos();
  repos.ensureConversation("conv-pending", "default-agent", "user");
  repos.saveLlmCall({
    id: "llm-pending-test",
    conversationId: "conv-pending",
    userId: "user",
    providerBaseUrl: "https://api.302ai.com",
    normalizedEndpoint: "https://api.302ai.com/v1/chat/completions",
    model: "gpt-5-mini",
    messagesJson: "[]",
    toolsJson: "[]",
    status: "pending",
    responseJson: "{}",
    createdAt: new Date().toISOString()
  }, []);
  repos.markPendingLlmCallsInterrupted("interrupted");
  const trace = repos.getTrace("conv-pending", "creator", "creator");
  assert.equal(trace.llmCalls[0].status, "failed");
  assert.equal(trace.llmCalls[0].errorText, "interrupted");
}

async function testConversationDeletionLifecycle() {
  const repos = createRepos();
  repos.ensureConversation("conv-delete", "default-agent", "delete-user");
  repos.addMessage("conv-delete", "user", "delete this conversation");
  repos.saveLlmCall({
    id: "llm-delete-test",
    conversationId: "conv-delete",
    userId: "delete-user",
    providerBaseUrl: "https://api.302ai.com",
    normalizedEndpoint: "https://api.302ai.com/v1/chat/completions",
    model: "gpt-5-mini",
    messagesJson: "[]",
    toolsJson: "[]",
    status: "completed",
    responseJson: "{}",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  }, [{
    id: "ctx-delete-test",
    llmCallId: "llm-delete-test",
    conversationId: "conv-delete",
    segmentType: "final_messages",
    title: "Final Messages",
    content: "[]",
    tokenEstimate: 1,
    sortOrder: 1
  }]);
  repos.saveToolCall({
    conversationId: "conv-delete",
    userId: "delete-user",
    workspaceId: "main",
    toolName: "enterWorkspace",
    argumentsJson: "{}",
    resultJson: "{}",
    status: "completed"
  });
  repos.createApprovalRequest({
    userId: "delete-user",
    conversationId: "conv-delete",
    workspaceId: "dev",
    toolName: "runCommand",
    argumentsJson: "{}",
    reason: "test approval cleanup"
  });

  repos.deleteConversation("conv-delete", "delete-user", "user", "user cleared conversation");
  assert.throws(() => repos.getTrace("conv-delete", "delete-user", "user"), /creator role/);
  assert.throws(() => repos.getTrace("conv-delete", "intruder", "user"), /creator role/);
  const trace = repos.getTrace("conv-delete", "creator", "creator");
  assert.equal(trace.llmCalls.length, 0);
  assert.equal(trace.contextSegments.length, 0);
  assert.equal(trace.toolCalls.length, 0);
  assert.equal(trace.approvalRequests.length, 0);
  assert.equal(repos.listMessagesDetailed("conv-delete").length, 0);
  assert.equal(trace.auditLogs.some((log) => log.action === "conversation_delete" && log.metadataJson.includes("user cleared conversation")), true);

  repos.ensureConversation("conv-other-owner", "default-agent", "owner-a");
  assert.throws(() => repos.deleteConversation("conv-other-owner", "owner-b", "user"));
  assert.throws(() => repos.ensureConversation("conv-other-owner", "default-agent", "owner-b"));
  repos.deleteConversation("conv-other-owner", "creator", "creator", "creator cleanup");
}

async function testWorkspaceDeletionLifecycle() {
  const repos = createRepos();
  assert.throws(() => (repos.upsertWorkspace as unknown as (input: { id: string }) => void)({ id: "implicit-creator-workspace" }), /creator role/);
  assert.throws(() => repos.getWorkspace("implicit-creator-workspace"), /Workspace not found/);
  assert.throws(() => repos.upsertWorkspace({
    id: "user-created-workspace",
    name: "User created workspace",
    description: "Ordinary users cannot install workspace capabilities.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "Not allowed.",
    toolInstructions: "Not allowed.",
    memoryPolicyJson: JSON.stringify({
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    }),
    riskLevel: "low",
    createdBy: "workspace-delete-user",
    manifest: {
      id: "user-created-workspace",
      name: "User created workspace",
      description: "Ordinary users cannot install workspace capabilities.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy: {
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    },
    toolIds: [],
    actorId: "workspace-delete-user",
    actorRole: "user"
  }), /creator role/);
  repos.upsertWorkspace({
    id: "temporary",
    name: "Temporary Workspace",
    description: "Temporary workspace for deletion lifecycle tests.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "Temporary instructions.",
    toolInstructions: "Temporary tool instructions.",
    memoryPolicyJson: JSON.stringify({
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    }),
    riskLevel: "low",
    createdBy: "creator",
    manifest: {
      id: "temporary",
      name: "Temporary Workspace",
      description: "Temporary workspace for deletion lifecycle tests.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy: {
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    },
    toolIds: [],
    actorId: "creator",
    actorRole: "creator"
  });
  const eventMemory = repos.createMemory({
    memoryType: "event",
    userId: "workspace-delete-user",
    workspaceId: "temporary",
    relationId: "event:workspace-delete",
    title: "Temporary event",
    summary: "Temporary event summary",
    detail: "Temporary event detail"
  }, "creator", "creator");
  const skillMemory = repos.createMemory({
    memoryType: "skill",
    workspaceId: "temporary",
    relationId: "skill:workspace-delete",
    title: "Temporary skill",
    summary: "Temporary skill summary",
    detail: "Temporary skill detail"
  }, "creator", "creator");
  const unrelatedMemory = repos.createMemory({
    memoryType: "event",
    userId: "workspace-delete-user",
    workspaceId: "dev",
    title: "File event",
    summary: "File event summary",
    detail: "File event detail"
  }, "creator", "creator");

  assert.throws(() => (repos.deleteWorkspace as unknown as (id: string) => void)("temporary"), /creator role/);
  assert.throws(() => repos.deleteWorkspace("temporary", "workspace-delete-user", "user"), /creator role/);
  assert.throws(() => repos.deleteWorkspace("main", "creator", "creator"));
  repos.deleteWorkspace("temporary", "creator", "creator", "workspace no longer needed");

  assert.throws(() => repos.getWorkspace("temporary"));
  assert.equal(repos.listMemories({ workspaceId: "temporary" }).some((memory) => memory.id === eventMemory.id || memory.id === skillMemory.id), false);
  assert.equal(repos.getMemoryIncludingDeleted(eventMemory.id).deleteReason, "workspace deleted: workspace no longer needed");
  assert.equal(repos.getMemoryIncludingDeleted(skillMemory.id).deleteReason, "workspace deleted: workspace no longer needed");
  assert.equal(repos.getMemory(unrelatedMemory.id).id, unrelatedMemory.id);
  assert.equal(repos.listAuditLogs({ limit: 200 }).some((log) => log.action === "workspace_delete" && log.resourceId === "temporary"), true);
}

async function testWorkspaceUpsertValidatesRegisteredToolsAtomically() {
  const repos = createRepos();
  const memoryPolicy = {
    eventRecallEnabled: true,
    skillRecallEnabled: true,
    eventWriteEnabled: true,
    skillWriteEnabled: true,
    maxEventMemories: 4,
    maxSkillMemories: 4
  };

  assert.throws(() => repos.upsertWorkspace({
    id: "invalid-tools",
    name: "Invalid tools",
    description: "Should not be partially created.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "Invalid tool workspace.",
    toolInstructions: "No tools should be linked.",
    memoryPolicyJson: JSON.stringify(memoryPolicy),
    riskLevel: "low",
    createdBy: "creator",
    manifest: {
      id: "invalid-tools",
      name: "Invalid tools",
      description: "Should not be partially created.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy,
    toolIds: ["tool-not-registered"],
    actorId: "creator",
    actorRole: "creator"
  }), /registered tools/);
  assert.throws(() => repos.getWorkspace("invalid-tools"), /Workspace not found/);
  assert.equal(repos.listAuditLogs({ limit: 50 }).some((log) => log.action === "workspace_upsert" && log.resourceId === "invalid-tools"), false);

  repos.upsertWorkspace({
    id: "atomic-tools",
    name: "Atomic tools",
    description: "Original valid workspace.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "Original instructions.",
    toolInstructions: "Search files only.",
    memoryPolicyJson: JSON.stringify(memoryPolicy),
    riskLevel: "low",
    createdBy: "creator",
    manifest: {
      id: "atomic-tools",
      name: "Atomic tools",
      description: "Original valid workspace.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy,
    toolIds: ["tool-search-files"],
    actorId: "creator",
    actorRole: "creator"
  });

  assert.throws(() => repos.upsertWorkspace({
    id: "atomic-tools",
    name: "Mutated by failed upsert",
    description: "This update should not persist.",
    capabilitiesJson: "[]",
    inputKindsJson: "[]",
    outputKindsJson: "[]",
    requiresApproval: 0,
    instructions: "Failed instructions.",
    toolInstructions: "Invalid tool.",
    memoryPolicyJson: JSON.stringify(memoryPolicy),
    riskLevel: "medium",
    createdBy: "creator",
    manifest: {
      id: "atomic-tools",
      name: "Mutated by failed upsert",
      description: "This update should not persist.",
      capabilities: [],
      inputKinds: [],
      outputKinds: [],
      riskLevel: "medium",
      requiresApproval: false
    },
    memoryPolicy,
    toolIds: ["tool-not-registered"],
    actorId: "creator",
    actorRole: "creator"
  }), /registered tools/);

  const persisted = repos.getWorkspace("atomic-tools");
  assert.equal(persisted.name, "Atomic tools");
  assert.equal(persisted.riskLevel, "low");
  assert.equal(persisted.tools.some((tool) => tool.id === "tool-search-files"), true);
  assert.equal(persisted.tools.some((tool) => tool.id === "tool-not-registered"), false);
}

async function testWorkspaceBoundary() {
  const repos = createRepos();
  const mainTools = repos.listToolsForWorkspace("main").map((tool) => tool.name);
  const devTools = repos.listToolsForWorkspace("dev").map((tool) => tool.name);
  const memoryTools = ["searchMemory", "readMemory", "readSkill", "writeUserImpression", "writeAgentSelfImpression", "writeSkillMemory"];
  assert.equal(repos.listWorkspaces().some((workspace) => workspace.id === "memory"), false);
  assert.equal(repos.listWorkspaces().some((workspace) => workspace.id === "file" || workspace.id === "cli"), false);
  assert.equal(["askUser", "enterWorkspace", "finishTask"].every((tool) => mainTools.includes(tool)), true);
  assert.equal(mainTools.includes("exitWorkspace"), false);
  assert.equal(memoryTools.every((tool) => mainTools.includes(tool)), true);
  assert.equal(memoryTools.every((tool) => devTools.includes(tool)), true);
  assert.equal(["writeEventMemory", "updateMemory", "deleteMemory"].some((tool) => mainTools.includes(tool) || devTools.includes(tool)), false);
  assert.equal(devTools.includes("searchFiles"), true);
  assert.equal(devTools.includes("readFile"), true);
  assert.equal(devTools.includes("writeFile"), true);
  assert.equal(devTools.includes("runCommand"), true);
}

async function testChildWorkspaceCannotUseMainOnlyToolsEvenIfBound() {
  const repos = createRepos();
  const file = repos.getWorkspace("dev");
  repos.upsertWorkspace({
    id: file.id,
    name: file.name,
    description: file.description,
    capabilitiesJson: file.capabilitiesJson,
    inputKindsJson: file.inputKindsJson,
    outputKindsJson: file.outputKindsJson,
    requiresApproval: file.requiresApproval,
    instructions: file.instructions,
    toolInstructions: file.toolInstructions,
    memoryPolicyJson: file.memoryPolicyJson,
    riskLevel: file.riskLevel,
    createdBy: file.createdBy,
    manifest: file.manifest,
    memoryPolicy: file.memoryPolicy,
    toolIds: ["tool-search-files", "tool-enter-workspace", "tool-ask-user", "tool-finish-task"],
    actorId: "creator",
    actorRole: "creator"
  });

  const fake = new ChildMainOnlyToolAttemptLLMClient();
  const runtime = new AgentRuntime(repos, fake);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "child-main-only-user",
    userRole: "creator",
    conversationId: "conv-child-main-only-tools",
    message: "enter file and then let main decide any sibling handoff",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });

  assert.equal(output.activeWorkspaceId, "main");
  assert.equal(output.assistantMessage, "main handled child boundary result");
  assert.equal(fake.childToolNames.includes("enterWorkspace"), false);
  assert.equal(fake.childToolNames.includes("askUser"), false);
  assert.equal(fake.childToolNames.includes("finishTask"), false);
  assert.equal(fake.childEnterWorkspaceResult.includes("active workspace"), true);
  const trace = repos.getTrace("conv-child-main-only-tools", "creator", "creator");
  const fileSession = trace.sessions.find((session) => session.workspaceId === "dev");
  const localToolNames = fileSession?.localContext.availableTools.map((tool) => tool.name) ?? [];
  assert.equal(localToolNames.includes("enterWorkspace"), false);
  assert.equal(localToolNames.includes("askUser"), false);
  assert.equal(localToolNames.includes("finishTask"), false);
  assert.equal(localToolNames.includes("exitWorkspace"), true);
  assert.equal(trace.sessions.filter((session) => session.workspaceId === "dev").length, 1);
  assert.equal(trace.toolCalls.some((call) => call.workspaceId === "dev" && call.toolName === "enterWorkspace" && call.status === "blocked"), true);
}

async function testMainOrchestrationTools() {
  const repos = createRepos();
  const askUser = new SingleToolRequestLLMClient("askUser", {
    question: "Which target should I use?",
    reason: "The request is missing a target.",
    choices: ["target A", "target B"]
  });
  const askRuntime = new AgentRuntime(repos, askUser);
  const askOutput = await askRuntime.run({
    agentId: "default-agent",
    userId: "main-tool-user",
    userRole: "creator",
    conversationId: "conv-main-tool-ask",
    message: "ask for missing target",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(askUser.calls, 1);
  assert.equal(askUser.lastToolResult, "");
  assert.equal(askOutput.assistantMessage, "Which target should I use?");
  const askMainSession = askOutput.workspaceTrace.find((session) => session.workspaceId === "main");
  assert.equal(askMainSession?.status, "needs_user_input");
  assert.equal(askMainSession?.result.summary, "Which target should I use?");
  assert.equal(askMainSession?.result.suggestedNextSteps.includes("target A"), true);
  assert.equal(askOutput.finalMessages.at(-1)?.content, "Which target should I use?");
  const askTrace = repos.getTrace("conv-main-tool-ask", "creator", "creator");
  assert.equal(askTrace.toolCalls.some((call) => call.toolName === "askUser" && call.status === "completed"), true);
  assert.equal(askTrace.llmCalls.length, 1);
  assert.equal(askTrace.auditLogs.some((log) => log.action === "main_workspace_result_committed" && log.metadataJson.includes("needs_user_input")), true);

  const finishTask = new SingleToolRequestLLMClient("finishTask", {
    summary: "The main workspace has enough information to answer.",
    response: "Final response text.",
    nextSteps: ["Reply to user"]
  });
  const finishRuntime = new AgentRuntime(repos, finishTask);
  const finishOutput = await finishRuntime.run({
    agentId: "default-agent",
    userId: "main-tool-user",
    userRole: "creator",
    conversationId: "conv-main-tool-finish",
    message: "finish this task",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(finishTask.calls, 1);
  assert.equal(finishTask.lastToolResult, "");
  assert.equal(finishOutput.assistantMessage, "Final response text.");
  const finishMainSession = finishOutput.workspaceTrace.find((session) => session.workspaceId === "main");
  assert.equal(finishMainSession?.status, "completed");
  assert.equal(finishMainSession?.result.summary, "The main workspace has enough information to answer.");
  assert.equal(finishMainSession?.result.suggestedNextSteps.includes("Reply to user"), true);
  assert.equal(finishOutput.finalMessages.at(-1)?.content, "Final response text.");
  const finishTrace = repos.getTrace("conv-main-tool-finish", "creator", "creator");
  assert.equal(finishTrace.toolCalls.some((call) => call.toolName === "finishTask" && call.status === "completed"), true);
  assert.equal(finishTrace.llmCalls.length, 1);
  assert.equal(finishTrace.auditLogs.some((log) => log.action === "main_workspace_result_committed" && log.metadataJson.includes("completed")), true);
}

async function testOpenAIClientRetriesAndDecodesErrors() {
  const originalFetch = globalThis.fetch;
  const client = new OpenAICompatibleClient();
  const input: ChatCompletionInput = {
    baseUrl: "https://api.302ai.com",
    apiKey: "test-key",
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      id: "tool-test-openai",
      name: "testTool",
      description: "Test OpenAI-compatible tool schema.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          reason: { type: "string" }
        },
        required: ["reason"]
      }),
      bindingType: "runtime",
      bindingJson: "{}",
      riskLevel: "low",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  };

  try {
    let completeAttempts = 0;
    let completeRequestBody: any;
    let completeAuthorization = "";
    globalThis.fetch = (async (_url: any, init?: any) => {
      completeAttempts += 1;
      completeRequestBody = JSON.parse(String(init?.body ?? "{}"));
      completeAuthorization = String(init?.headers?.Authorization ?? "");
      if (completeAttempts < 5) {
        return new Response(JSON.stringify({ error: { message: "temporary overload" } }), { status: 500 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "retried ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const completeOutput = await client.complete(input);
    assert.equal(completeAttempts, 5);
    assert.equal(completeOutput.message.content, "retried ok");
    assert.equal(completeAuthorization, "Bearer test-key");
    assert.equal(completeRequestBody.apiKey, undefined);
    assert.equal(completeRequestBody.stream, undefined);
    assert.equal(completeRequestBody.tools[0].type, "function");
    assert.equal(completeRequestBody.tools[0].function.name, "testTool");
    assert.equal(completeRequestBody.tools[0].function.parameters.required[0], "reason");

    let streamAttempts = 0;
    let streamRequestBody: any;
    globalThis.fetch = (async (_url: any, init?: any) => {
      streamAttempts += 1;
      streamRequestBody = JSON.parse(String(init?.body ?? "{}"));
      if (streamAttempts === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }) as typeof fetch;
    let streamed = "";
    for await (const event of client.streamEvents(input)) {
      if (event.type === "content") streamed += event.text;
    }
    assert.equal(streamAttempts, 2);
    assert.equal(streamed, "ok");
    assert.equal(streamRequestBody.stream, true);
    assert.equal(streamRequestBody.apiKey, undefined);
    assert.equal(streamRequestBody.tools[0].function.name, "testTool");

    globalThis.fetch = (async () => {
      const body = gzipSync(Buffer.from(JSON.stringify({ error: { message: "bad request detail" } }), "utf8"));
      return new Response(body, { status: 400, headers: { "content-encoding": "gzip" } });
    }) as typeof fetch;
    await assert.rejects(
      () => client.complete(input),
      /LLM 请求失败（400）：bad request detail/
    );

    const originalIdleTimeout = process.env.ZLEAP_LLM_STREAM_IDLE_TIMEOUT_MS;
    try {
      process.env.ZLEAP_LLM_STREAM_IDLE_TIMEOUT_MS = "10";
      globalThis.fetch = (async () => {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"stalled\"}}]}\n\n"));
          }
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }) as typeof fetch;
      await assert.rejects(async () => {
        for await (const _event of client.streamEvents(input)) {
          // The first chunk arrives, then the stream idles past the configured timeout.
        }
      }, /LLM 流式响应超时/);
    } finally {
      if (originalIdleTimeout === undefined) {
        delete process.env.ZLEAP_LLM_STREAM_IDLE_TIMEOUT_MS;
      } else {
        process.env.ZLEAP_LLM_STREAM_IDLE_TIMEOUT_MS = originalIdleTimeout;
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await testWebUiMasterPlanContracts();
  await testDatabaseAndMemory();
  await testOpenAIClientRetriesAndDecodesErrors();
  await testAgentUpdateRequiresCreatorRole();
  await testHttpActorParsingRequiresExplicitIdentity();
  await testSensitiveHttpEndpointsRequireExplicitActor();
  await testTraceAndToolLogsAreUserScoped();
  await testLlmLogsAreUserScoped();
  await testApprovalListIsUserScoped();
  await testRuntimeContextAndTools();
  await testLlmMemoryContextUsesWorkspaceSessionRecall();
  await testMemoryRecallAuditLogsZeroHits();
  await testAuditLogsStayOutOfModelContext();
  await testAttentionBudgetTrimsHistoryButKeepsJson();
  await testAgentSelfImpressionRecallIsAgentScoped();
  await testWorkspaceExitReturnsToMain();
  await testInterruptedChildWorkspaceResumesBeforeMain();
  await testWorkspaceExitHookRunsOncePerSuccessfulExitToolCall();
  await testDuplicateWorkspaceExitCannotOverwriteCommittedSession();
  await testMalformedWorkspaceExitDoesNotCommitSession();
  await testWorkspaceSessionLocalToolCallsAreSessionScoped();
  await testWorkspaceMemoryPolicyControlsRecall();
  await testWorkspaceMemoryPolicyControlsWrites();
  await testEventMemoryIsHookGenerated();
  await testSkillMemoryToolQualityGate();
  await testRuntimeStreaming();
  await testLlmFailureLog();
  await testRuntimeConfigControlsRuntimeLimits();
  await testStreamingFollowUpFailureMarksLlmCallFailed();
  await testPendingLlmCallsInterruptedOnStartup();
  await testConversationDeletionLifecycle();
  await testWorkspaceDeletionLifecycle();
  await testWorkspaceUpsertValidatesRegisteredToolsAtomically();
  await testMainOrchestrationTools();
  await testMemoryLifecycleHooks();
  await testConversationWindowEventExtractionUsesAbsoluteWindows();
  await testStreamingConversationWindowMemoryIncludesAssistantMessage();
  await testSkillEvidenceFromWorkspaceEvents();
  await testEventHookSkillExtractionIsDesensitizedAndDeduplicated();
  await testMemoryToolCallLoop();
  await testImpressionMemoryToolScopeIsCodeBound();
  await testQuestionLikeImpressionWritesAreRejected();
  await testMultiStepToolLoop();
  await testToolLoopStopsAtLimit();
  await testStreamingMemoryToolCallLoop();
  await testStreamingToolRoundTextIsNotLeaked();
  await testStreamingChildWorkspaceEventsAreVisible();
  await testStreamingMultiStepToolLoop();
  await testStreamingToolLoopStopsAtLimit();
  await testWorkspaceEntryApprovalGate();
  await testToolPolicyGates();
  await testRuntimeMemoryToolsAreUniversalAndPolicyGated();
  await testDirectMemoryApiUsesPolicyLayer();
  await testSearchMemoryToolUsesPolicyLayer();
  await testToolBindingsAndMcpReadiness();
  await testSeedRefreshesExistingToolSchemas();
  await testWorkspaceBoundary();
  await testChildWorkspaceCannotUseMainOnlyToolsEvenIfBound();
  console.log("All tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

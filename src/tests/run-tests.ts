import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/schema";
import { seedDefaults } from "../db/seed";
import { Repositories } from "../db/repositories";
import { AgentRuntime } from "../core/agent-runtime";
import { MemoryService } from "../core/memory-service";
import type { ChatCompletionInput, ChatCompletionOutput, LLMClient, LLMStreamEvent } from "../core/llm-client";
import { normalizeChatCompletionsEndpoint, normalizeProviderBaseUrl } from "../core/llm-client";
import type { MemoryRow } from "../types";

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
              arguments: JSON.stringify({ workspaceId: "file", objective: "search files for runtime" })
            }
          }]
        },
        raw: { plannedWorkspace: "file" }
      };
    }
    assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), true);
    assert.equal(input.tools.some((tool) => tool.name === "runCommand"), false);
    assert.equal(input.messages.some((message) => message.role === "tool" && message.name === "enterWorkspace"), true);
    return {
      message: {
        role: "assistant",
        content: "fake response"
      },
      raw: { ok: true }
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
              arguments: JSON.stringify({ workspaceId: "file", objective: "inspect file evidence" })
            }
          }]
        },
        raw: { plannedWorkspace: "file" }
      };
    }
    if (this.calls === 2) {
      assert.equal(input.tools.some((tool) => tool.name === "searchFiles"), true);
      assert.equal(input.tools.some((tool) => tool.name === "exitWorkspace"), true);
      return {
        message: {
          role: "assistant",
          content: null,
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
        raw: { returnedWorkspace: "file" }
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
              arguments: JSON.stringify({ workspaceId: "file", objective: "inspect file evidence" })
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
              arguments: JSON.stringify({ workspaceId: "file", objective: "first file session" })
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
              arguments: JSON.stringify({ workspaceId: "file", objective: "second file session" })
            }
          }]
        },
        raw: { step: "enter-second-file" }
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
              arguments: JSON.stringify({ workspaceId: "cli", objective: "run command or test task" })
            }
          }]
        },
        raw: { plannedWorkspace: "cli" }
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
              arguments: JSON.stringify({ workspaceId: "cli", objective: "run CLI tool" })
            }
          }]
        },
        raw: { plannedWorkspace: "cli" }
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
        content: "工具结果已处理。"
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
    return {
      message: {
        role: "assistant",
        content: "工具结果已处理。"
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
        content: "记住了。"
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
        content: "工具结果已处理。"
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

function metadataOf(memory: { metadataJson: string }): Record<string, any> {
  return JSON.parse(memory.metadataJson) as Record<string, any>;
}

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
    toolIds: workspace.tools.map((tool) => tool.id)
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
    toolIds: workspace.tools.map((tool) => tool.id)
  });
}

async function testDatabaseAndMemory() {
  const repos = createRepos();
  assert.throws(() => repos.ensureConversation("", "default-agent", "user-a"));
  assert.throws(() => repos.ensureConversation("conv-empty-user", "default-agent", ""));
  repos.ensureConversation("conv-owner", "default-agent", "user-a");
  repos.addMessage("conv-owner", "user", "owner message");
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
    workspaceId: "file",
    relationId: "rel-test",
    version: 1,
    title: "Old file search",
    summary: "Old search used npm",
    detail: "Old detail"
  }, "creator", "creator");
  const latestEvent = repos.createMemory({
    memoryType: "event",
    userId: "user-a",
    workspaceId: "file",
    relationId: "rel-test",
    version: 2,
    title: "Latest file search",
    summary: "Latest search uses ripgrep",
    detail: "Latest detail"
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    title: "Search first",
    summary: "Use ripgrep before editing",
    detail: "Skill detail"
  }, "creator", "creator");
  for (let index = 0; index < 12; index += 1) {
    repos.createMemory({
      memoryType: "skill",
      workspaceId: "file",
      title: `Noisy search skill ${index}`,
      summary: `Noisy ripgrep search skill ${index}`,
      detail: "These newer skills should not starve event recall."
    }, "creator", "creator");
  }

  const recalled = repos.recallMemories({ userId: "user-a", workspaceId: "file", query: "ripgrep search" });
  assert.equal(recalled.some((item) => item.title === "Latest file search"), true);
  assert.equal(recalled.some((item) => item.title === "Old file search"), false);
  assert.equal(recalled.some((item) => item.memoryType === "skill"), true);
  assert.equal(recalled.filter((item) => item.memoryType === "skill").length, 8);
  assert.equal(recalled.filter((item) => item.memoryType === "event").some((item) => item.id === latestEvent.id), true);

  repos.deleteMemory(latestEvent.id, "creator", "creator", "superseded event cleanup");
  const afterSoftDelete = repos.recallMemories({ userId: "user-a", workspaceId: "file", query: "ripgrep search" });
  assert.equal(afterSoftDelete.some((item) => item.id === latestEvent.id), false);
  assert.equal(afterSoftDelete.some((item) => item.id === oldEvent.id), true);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "user-a", workspaceId: "file" }).some((item) => item.id === latestEvent.id), false);
  assert.throws(() => repos.getMemory(latestEvent.id));
  const deletedLatest = repos.getMemoryIncludingDeleted(latestEvent.id);
  assert.equal(Boolean(deletedLatest.deletedAt), true);
  assert.equal(deletedLatest.deletedBy, "creator");
  assert.equal(deletedLatest.deleteReason, "superseded event cleanup");
  assert.equal(repos.getMemoryByRelation("event", "rel-test")?.id, oldEvent.id);

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

  const ownerTrace = repos.getTrace("conv-trace-owner", "trace-owner", "user");
  assert.equal(ownerTrace.toolCalls.some((call) => call.id === toolCall.id && call.userId === "trace-owner"), true);
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
    workspaceId: "cli",
    toolName: "runCommand",
    argumentsJson: JSON.stringify({ command: "npm test" }),
    reason: "owner a approval"
  });
  const ownerB = repos.createApprovalRequest({
    userId: "approval-owner-b",
    conversationId: "conv-approval-owner-b",
    workspaceId: "file",
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
    workspaceId: "file",
    relationId: "event:user:file:runtime-search",
    title: "Runtime file search event",
    summary: "Runtime search used file workspace",
    detail: "A previous file workspace task searched runtime files."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
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
  assert.equal(output.activeWorkspaceId, "file");
  assert.equal(normalizeProviderBaseUrl("https://api.302.ai"), "https://api.302ai.com");
  assert.equal(normalizeProviderBaseUrl("http://api.302.ai/v1/chat/completions/"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeProviderBaseUrl("api.302.ai"), "https://api.302ai.com");
  assert.equal(normalizeChatCompletionsEndpoint("https://api.302.ai"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeChatCompletionsEndpoint("https://api.302.ai/v1/chat/completions"), "https://api.302ai.com/v1/chat/completions");
  assert.equal(normalizeChatCompletionsEndpoint("api.302.ai"), "https://api.302ai.com/v1/chat/completions");
  const firstInput = fake.inputs[0];
  const lastInput = fake.inputs.at(-1);
  assert.equal(firstInput?.baseUrl, "https://api.302ai.com");
  assert.equal(normalizeChatCompletionsEndpoint(firstInput!.baseUrl), "https://api.302ai.com/v1/chat/completions");
  assert.equal(firstInput?.messages.at(-1)?.role, "user");
  assert.equal(firstInput?.messages.at(-1)?.content, "search files for runtime");
  const mainHistoryToolMessage = firstInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.history");
  assert.equal((mainHistoryToolMessage?.content ?? "").includes("old global user chat unrelated to file workspace"), true);
  const systemMessage = lastInput?.messages[0]?.content ?? "";
  assert.equal(systemMessage.includes("最终面向用户的回答不得暴露这些内部机制"), true);
  assert.equal(systemMessage.includes("Memory write protocol"), true);
  assert.equal(systemMessage.includes("writeUserImpression only when the user expresses a stable long-term preference"), true);
  assert.equal(systemMessage.includes("writeSkillMemory when the user explicitly asks to save reusable experience"), true);
  assert.equal(systemMessage.includes("Prefer runtime hooks for routine event memory"), true);
  assert.equal(systemMessage.includes("writeAgentSelfImpression only for creator-authorized updates"), true);
  const agent = repos.getAgent("default-agent");
  assert.equal(/workspace|context|runtime/i.test(agent.personalityPrompt), false);
  assert.equal(firstInput?.tools.some((tool) => tool.name === "enterWorkspace"), true);
  assert.equal(firstInput?.tools.some((tool) => tool.name === "searchFiles"), false);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "runCommand"), false);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "searchFiles"), true);
  assert.equal(lastInput?.tools.some((tool) => tool.name === "writeUserImpression"), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "final_messages"), true);
  const firstSystemMessage = firstInput?.messages[0]?.content ?? "";
  assert.equal(firstSystemMessage.includes("可用工作空间清单"), true);
  assert.equal(firstSystemMessage.includes("\"id\": \"file\""), true);
  assert.equal(firstSystemMessage.includes("\"id\": \"cli\""), true);
  const childWorkspaceRegistry = output.contextSegments.find((segment) => segment.segmentType === "workspace_registry");
  assert.deepEqual(JSON.parse(childWorkspaceRegistry?.content ?? "[]"), []);
  assert.equal((lastInput?.messages[0]?.content ?? "").includes("\"id\": \"cli\""), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "workspace" && segment.content.includes("Memory policy") && segment.content.includes("maxEventMemories")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "task" && segment.content.includes("\"workspaceId\": \"file\"")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "workspace_result" && segment.content.includes("\"suggestedNextSteps\"")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "workspace_local_context" && segment.content.includes("Runtime search skill")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "impression_memory" && segment.content.includes("Search style")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "event_memory" && segment.content.includes("Runtime file search event")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "skill_memory" && segment.content.includes("Runtime search skill")), true);
  const childHistorySegment = output.contextSegments.find((segment) => segment.segmentType === "history");
  assert.equal(childHistorySegment?.content, "[]");
  assert.equal(output.contextSegments.some((segment) => segment.content.includes("old global user chat unrelated to file workspace")), false);
  assert.equal(lastInput?.messages.some((message) => message.role === "tool" && message.name === "runtime_context.task"), true);
  const childHistoryToolMessage = lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.history");
  assert.deepEqual(JSON.parse(childHistoryToolMessage?.content ?? "[]"), []);
  const taskToolMessage = lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.task");
  const taskPayload = JSON.parse(taskToolMessage?.content ?? "{}") as { workspaceLocalContext: { recalledEventMemories: unknown[]; recalledSkillMemories: unknown[]; availableTools: Array<{ name: string; bindingType: string }> } };
  assert.equal(taskPayload.workspaceLocalContext.recalledEventMemories.length, 1);
  assert.equal(taskPayload.workspaceLocalContext.recalledSkillMemories.length, 1);
  assert.equal(taskPayload.workspaceLocalContext.availableTools.some((tool) => tool.name === "searchFiles" && tool.bindingType === "mcp"), true);
  const memoryToolMessage = lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.load");
  const memoryPayload = JSON.parse(memoryToolMessage?.content ?? "{}") as { impressions: unknown[]; eventMemories: unknown[]; skillMemories: unknown[] };
  assert.equal(memoryPayload.impressions.length, 1);
  assert.equal(memoryPayload.eventMemories.length, 1);
  assert.equal(memoryPayload.skillMemories.length, 1);
  assert.equal(output.workspaceTrace.length, 2);
  assert.equal(repos.getWorkspace("cli").manifest.requiresApproval, true);
  assert.equal(repos.getWorkspace("file").manifest.capabilities.length > 0, true);
  assert.equal(repos.getWorkspace("file").memoryPolicy.eventRecallEnabled, true);
  assert.equal(output.workspaceTrace[1].task.workspaceId, "file");
  assert.equal(output.workspaceTrace[1].result.workspaceId, "file");
  assert.equal(output.workspaceTrace[1].result.suggestedNextSteps.length > 0, true);
  assert.equal(output.workspaceTrace[1].localContext.recalledEventMemories.some((memory) => memory.title === "Runtime file search event"), true);
  assert.equal(output.workspaceTrace[1].localContext.recalledSkillMemories.some((memory) => memory.title === "Runtime search skill"), true);
  assert.equal(output.workspaceTrace[1].localContext.availableTools.some((tool) => tool.name === "searchFiles"), true);
  const trace = repos.getTrace("conv-test");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("\"plannedWorkspace\":\"file\"")), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("\"ok\":true")), true);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "tool_result" && segment.content.includes("enterWorkspace")), true);
  const fileSession = trace.sessions.find((session) => session.workspaceId === "file");
  assert.equal(fileSession?.task.objective, "search files for runtime");
  assert.equal(fileSession?.result.status, "running");
  assert.equal(fileSession?.completedAt, undefined);
  assert.equal(fileSession?.localContext.recalledEventMemories.some((memory) => memory.title === "Runtime file search event"), true);
  assert.equal(fileSession?.localContext.recalledSkillMemories.some((memory) => memory.title === "Runtime search skill"), true);
  assert.equal(fileSession?.result.observations.some((item) => item.includes("WorkspaceSession")), true);
  const actions = trace.auditLogs.map((log) => log.action);
  assert.equal(actions.includes("hook.beforeAgentTurn"), true);
  assert.equal(actions.includes("hook.afterAgentTurn"), true);
  assert.equal(actions.includes("hook.beforeWorkspaceEnter"), true);
  assert.equal(actions.includes("hook.afterWorkspaceExit"), false);
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

  const historyToolMessage = fake.lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.history");
  const historyContent = historyToolMessage?.content ?? "";
  const parsedHistory = JSON.parse(historyContent) as unknown[];
  assert.equal(Array.isArray(parsedHistory), true);
  assert.equal(historyContent.includes("truncated by attention budget"), true);
  assert.equal(historyContent.length < 4500, true);

  const historySegment = repos.getTrace(conversationId).contextSegments.find((segment) => segment.segmentType === "history");
  assert.equal((historySegment?.tokenEstimate ?? 0) <= 1000, true);
}

async function testAgentSelfImpressionRecallIsAgentScoped() {
  const repos = createRepos();
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

  const memoryToolMessage = fake.lastInput?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.load");
  const memoryPayload = JSON.parse(memoryToolMessage?.content ?? "{}") as { impressions: Array<{ title: string }> };
  assert.equal(memoryPayload.impressions.some((memory) => memory.title === "Default self recall"), true);
  assert.equal(memoryPayload.impressions.some((memory) => memory.title === "Other self recall"), false);
  assert.equal(memoryPayload.impressions.some((memory) => memory.title === "Global self recall leak"), false);
  assert.equal(memoryPayload.impressions.some((memory) => memory.title === "Ambiguous self recall leak"), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "impression_memory" && segment.content.includes("Default self recall")), true);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "impression_memory" && segment.content.includes("Other self recall")), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "impression_memory" && segment.content.includes("Global self recall leak")), false);
  assert.equal(output.contextSegments.some((segment) => segment.segmentType === "impression_memory" && segment.content.includes("Ambiguous self recall leak")), false);
}

async function testWorkspaceExitReturnsToMain() {
  const repos = createRepos();
  const recalledSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
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
  assert.equal(output.assistantMessage, "main integrated file result");
  assert.equal(output.activeWorkspaceId, "main");
  assert.equal(output.workspaceTrace.length, 2);
  assert.equal(output.memoryWrites.filter((memory) => memory.memoryType === "event" && memory.workspaceId === "file").length, 2);
  const autoSkill = output.memoryWrites.find((memory) => memory.memoryType === "skill" && memory.workspaceId === "file");
  assert.equal(Boolean(autoSkill), true);
  assert.equal(metadataOf(autoSkill!).source, "eventSkillCandidate");
  assert.equal(metadataOf(autoSkill!).triggerSource, "afterWorkspaceExit");
  assert.equal(metadataOf(autoSkill!).evidenceEventIds.length, 2);
  assert.equal(metadataOf(autoSkill!).procedure.some((step: string) => step.includes("搜索") || step.includes("读取")), true);
  const fileSession = output.workspaceTrace.find((session) => session.workspaceId === "file");
  assert.equal(fileSession?.result.summary, "File workspace inspected available evidence.");
  assert.equal(fileSession?.result.observations.includes("File workspace had searchFiles available."), true);

  const trace = repos.getTrace("conv-workspace-exit");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.toolCalls.some((call) => call.toolName === "exitWorkspace" && call.status === "completed"), true);
  const exitToolCall = trace.toolCalls.find((call) => call.toolName === "exitWorkspace");
  assert.equal(exitToolCall?.workspaceSessionId, fileSession?.id);
  assert.equal(exitToolCall?.taskId, fileSession?.taskId);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.beforeWorkspaceExit" && log.workspaceId === "file"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExit" && log.workspaceId === "file"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterToolCall" && log.resourceId === exitToolCall?.id && log.metadataJson.includes(fileSession!.taskId)), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExitEventExtraction" && log.workspaceId === "file"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterEventExtracted" && log.workspaceId === "file"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterSkillExtracted" && log.workspaceId === "file"), true);
  assert.equal(trace.auditLogs.some((log) => log.action === "workspace_returned_to_main"), true);
  const exitEvents = repos.listMemories({ memoryType: "event", userId: "workspace-exit-user", workspaceId: "file" });
  assert.equal(exitEvents.length, 2);
  assert.equal(exitEvents.every((memory) => metadataOf(memory).source === "afterWorkspaceExit"), true);
  assert.equal(exitEvents.some((memory) => metadataOf(memory).eventKind === "process"), true);
  assert.equal(exitEvents.some((memory) => metadataOf(memory).eventKind === "result"), true);
  assert.equal(exitEvents.every((memory) => metadataOf(memory).workspaceSessionIds.includes(fileSession!.id)), true);
  assert.equal(exitEvents.every((memory) => metadataOf(memory).toolCallIds.includes(exitToolCall!.id)), true);
  const persistedFileSession = trace.sessions.find((session) => session.workspaceId === "file");
  assert.equal(Boolean(persistedFileSession?.completedAt), true);
  assert.equal(persistedFileSession?.summary, "File workspace inspected available evidence.");
  const finalCall = trace.llmCalls[0];
  assert.equal(finalCall.toolsJson.includes("enterWorkspace"), true);
  assert.equal(finalCall.toolsJson.includes("searchFiles"), false);
  assert.equal(trace.contextSegments.some((segment) => segment.segmentType === "workspace_result" && segment.content.includes("File workspace inspected available evidence.")), true);
  const skillUsageMetadata = metadataOf(repos.getMemory(recalledSkill.id));
  assert.equal(skillUsageMetadata.usageCount, 2);
  assert.equal(skillUsageMetadata.successCount, 2);
  assert.equal(skillUsageMetadata.failureCount, 0);
  assert.equal(skillUsageMetadata.lastOutcome, "completed");
  assert.equal(skillUsageMetadata.lastWorkspaceSessionId, fileSession?.id);
  assert.equal(trace.auditLogs.some((log) => log.action === "skill_usage_recorded" && log.resourceId === recalledSkill.id), true);
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

  assert.equal(fake.calls, 3);
  assert.equal(output.activeWorkspaceId, "file");
  assert.equal(output.assistantMessage, "bad exit handled");
  const trace = repos.getTrace("conv-workspace-bad-exit");
  const exitCall = trace.toolCalls.find((call) => call.toolName === "exitWorkspace");
  assert.equal(exitCall?.status, "failed");
  assert.equal(exitCall?.resultJson.includes("WorkspaceResult.status"), true);
  const fileSession = trace.sessions.find((session) => session.workspaceId === "file");
  assert.equal(fileSession?.completedAt, undefined);
  assert.equal(fileSession?.status, "running");
  assert.equal(fileSession?.result.status, "running");
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.beforeWorkspaceExit"), false);
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterWorkspaceExit"), false);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "workspace-bad-exit-user", workspaceId: "file" }).length, 0);
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

  assert.equal(fake.calls, 4);
  assert.equal(output.workspaceTrace.filter((session) => session.workspaceId === "file").length, 2);
  const firstFileSession = output.workspaceTrace.filter((session) => session.workspaceId === "file")[0];
  const secondFileSession = output.workspaceTrace.filter((session) => session.workspaceId === "file")[1];
  assert.equal(firstFileSession.localContext.recentToolCalls.some((call) => call.toolName === "exitWorkspace"), true);
  assert.equal(secondFileSession.localContext.recentToolCalls.length, 0);

  const secondFileInput = fake.inputs[3];
  const taskToolMessage = secondFileInput.messages.find((message) => message.role === "tool" && message.name === "runtime_context.task");
  const taskPayload = JSON.parse(taskToolMessage?.content ?? "{}") as { workspaceLocalContext: { recentToolCalls: unknown[] } };
  assert.equal(taskPayload.workspaceLocalContext.recentToolCalls.length, 0);

  const trace = repos.getTrace("conv-session-scope");
  const exitCall = trace.toolCalls.find((call) => call.toolName === "exitWorkspace");
  assert.equal(exitCall?.workspaceSessionId, firstFileSession.id);
  assert.equal(exitCall?.taskId, firstFileSession.taskId);
  const persistedSecond = trace.sessions.find((session) => session.id === secondFileSession.id);
  assert.equal(persistedSecond?.localContext.recentToolCalls.length, 0);
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
    workspaceId: "file",
    relationId: "event:policy-user:file:policy:1",
    title: "Policy event one",
    summary: "policy recall event one",
    detail: "First event memory for memory policy recall."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "event",
    userId: "policy-user",
    workspaceId: "file",
    relationId: "event:policy-user:file:policy:2",
    title: "Policy event two",
    summary: "policy recall event two",
    detail: "Second event memory for memory policy recall."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    relationId: "skill:file:policy:1",
    title: "Policy skill one",
    summary: "policy recall skill one",
    detail: "First skill memory for memory policy recall."
  }, "creator", "creator");
  repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    relationId: "skill:file:policy:2",
    title: "Policy skill two",
    summary: "policy recall skill two",
    detail: "Second skill memory for memory policy recall."
  }, "creator", "creator");

  updateWorkspaceMemoryPolicy(repos, "file", {
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
  const cappedMemoryMessage = cappedFake.inputs.at(-1)?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.load");
  const cappedMemoryPayload = JSON.parse(cappedMemoryMessage?.content ?? "{}") as { impressions: unknown[]; eventMemories: unknown[]; skillMemories: unknown[] };
  assert.equal(cappedMemoryPayload.impressions.length, 1);
  assert.equal(cappedMemoryPayload.eventMemories.length, 1);
  assert.equal(cappedMemoryPayload.skillMemories.length, 1);

  updateWorkspaceMemoryPolicy(repos, "file", {
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
  const disabledMemoryMessage = disabledFake.inputs.at(-1)?.messages.find((message) => message.role === "tool" && message.name === "runtime_context.load");
  const disabledMemoryPayload = JSON.parse(disabledMemoryMessage?.content ?? "{}") as { impressions: unknown[]; eventMemories: unknown[]; skillMemories: unknown[] };
  assert.equal(disabledMemoryPayload.impressions.length, 1);
  assert.equal(disabledMemoryPayload.eventMemories.length, 0);
  assert.equal(disabledMemoryPayload.skillMemories.length, 0);
  assert.equal(disabledOutput.contextSegments.some((segment) => segment.segmentType === "event_memory" && segment.content.includes("Policy event")), false);
  assert.equal(disabledOutput.contextSegments.some((segment) => segment.segmentType === "skill_memory" && segment.content.includes("Policy skill")), false);
}

async function testWorkspaceMemoryPolicyControlsWrites() {
  const repos = createRepos();
  updateWorkspaceMemoryPolicy(repos, "file", {
    eventWriteEnabled: false,
    skillWriteEnabled: false
  });

  const eventWriter = new MainToWorkspaceToolRequestLLMClient("file", "writeEventMemory", {
    workspaceId: "file",
    title: "Blocked file event",
    summary: "Event writes should be disabled",
    detail: "The runtime should reject this event memory because file workspace disabled event writes."
  });
  const eventRuntime = new AgentRuntime(repos, eventWriter);
  await eventRuntime.run({
    agentId: "default-agent",
    userId: "write-policy-user",
    userRole: "creator",
    conversationId: "conv-memory-write-policy-event",
    message: "search files write policy event",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(eventWriter.lastToolResult.includes("Event memory writes are disabled for workspace: file"), true);
  assert.equal(repos.listMemories({ memoryType: "event", userId: "write-policy-user", workspaceId: "file" }).length, 0);
  const eventTrace = repos.getTrace("conv-memory-write-policy-event");
  assert.equal(eventTrace.toolCalls.some((call) => call.toolName === "writeEventMemory" && call.status === "failed"), true);
  assert.equal(eventTrace.auditLogs.some((log) => log.action === "memory_write_rejected" && log.metadataJson.includes("Event memory writes are disabled")), true);

  const skillWriter = new MainToWorkspaceToolRequestLLMClient("file", "writeSkillMemory", {
    workspaceId: "file",
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
  assert.equal(skillWriter.lastToolResult.includes("Skill memory writes are disabled for workspace: file"), true);
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "file" }).length, 0);
  const skillTrace = repos.getTrace("conv-memory-write-policy-skill");
  assert.equal(skillTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "failed"), true);
  assert.equal(skillTrace.auditLogs.some((log) => log.action === "memory_write_rejected" && log.metadataJson.includes("Skill memory writes are disabled")), true);

  updateWorkspaceMemoryPolicy(repos, "file", {
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
  assert.equal(autoSkillOutput.memoryWrites.some((memory) => memory.memoryType === "skill" && memory.workspaceId === "file"), false);
  const autoSkillTrace = repos.getTrace("conv-memory-write-policy-auto-skill");
  assert.equal(autoSkillTrace.auditLogs.some((log) => log.action === "memory_write_rejected" && log.metadataJson.includes("Skill memory writes are disabled")), true);
}

async function testEventMemoryMetadataContract() {
  const repos = createRepos();
  const eventWriter = new SingleToolRequestLLMClient("writeEventMemory", {
    workspaceId: "main",
    title: "Important manual event",
    summary: "The agent preserved a noteworthy conversation event.",
    detail: "The runtime should attach conversation and active session evidence to tool-requested event memory."
  });
  const runtime = new AgentRuntime(repos, eventWriter);
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "event-contract-user",
    userRole: "creator",
    conversationId: "conv-event-contract",
    message: "write an important event memory",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const event = output.memoryWrites.find((memory) => memory.memoryType === "event" && memory.workspaceId === "main");
  assert.equal(Boolean(event), true);
  const metadata = metadataOf(event!);
  assert.equal(metadata.source, "memoryToolCall");
  assert.equal(metadata.eventKind, "agent_requested");
  assert.equal(metadata.conversationId, "conv-event-contract");
  assert.equal(metadata.activeWorkspaceId, "main");
  assert.equal(typeof metadata.taskId, "string");
  assert.equal(Array.isArray(metadata.taskIds), true);
  assert.equal(typeof metadata.workspaceSessionId, "string");
  assert.equal(Array.isArray(metadata.workspaceSessionIds), true);
  assert.equal(event!.relationId?.includes("conv-event-contract"), true);
}

async function testSkillMemoryToolQualityGate() {
  const repos = createRepos();
  const event = repos.createMemory({
    memoryType: "event",
    userId: "skill-quality-user",
    workspaceId: "file",
    title: "Generalized file search event",
    summary: "A file workspace task succeeded after searching call sites first.",
    detail: "The task used file search before editing.",
    metadataJson: JSON.stringify({ source: "test", conversationId: "conv-skill-quality-valid", eventKind: "manual" })
  }, "creator", "creator");

  const validSkillWriter = new MainToWorkspaceToolRequestLLMClient("file", "writeSkillMemory", {
    workspaceId: "file",
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
  const validTrace = repos.getTrace("conv-skill-quality-valid");
  assert.equal(validTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "completed"), true);

  const privateSkillWriter = new MainToWorkspaceToolRequestLLMClient("file", "writeSkillMemory", {
    workspaceId: "file",
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
  assert.equal(repos.listMemories({ memoryType: "skill", workspaceId: "file" }).some((memory) => memory.title === "Private path skill"), false);
  const privateTrace = repos.getTrace("conv-skill-quality-private");
  assert.equal(privateTrace.toolCalls.some((call) => call.toolName === "writeSkillMemory" && call.status === "failed"), true);
  assert.equal(privateTrace.auditLogs.some((log) => log.action === "memory_write_rejected" && log.metadataJson.includes("private user/project details")), true);
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
  const trace = repos.getTrace("conv-stream");
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
      userRole: "creator",
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
  assert.equal(events.some((memory) => memory.relationId === "event:user-memory:main:conv-memory-window:window:1:result"), true);
  assert.equal(events.some((memory) => metadataOf(memory).eventKind === "process"), true);
  assert.equal(events.some((memory) => metadataOf(memory).eventKind === "result"), true);
  const resultEvent = events.find((memory) => memory.relationId === "event:user-memory:main:conv-memory-window:window:1:result");
  assert.equal(Array.isArray(metadataOf(resultEvent!).evidenceMessageIds), true);
  assert.equal(metadataOf(resultEvent!).evidenceMessageIds.length, 20);
  assert.equal(Array.isArray(metadataOf(resultEvent!).workspaceSessionIds), true);
  assert.equal(metadataOf(resultEvent!).toolCallIds.includes("tool-old-window-evidence"), false);
  assert.equal(metadataOf(resultEvent!).workspaceSessionIds.includes("wss-old-window-evidence"), false);
  assert.equal(metadataOf(resultEvent!).taskIds.includes("task-old-window-evidence"), false);
  assert.equal(typeof metadataOf(resultEvent!).windowStartAt, "string");
  assert.equal(typeof metadataOf(resultEvent!).windowEndAt, "string");
  const windowTrace = repos.getTrace("conv-memory-window");
  assert.equal(windowTrace.auditLogs.some((log) => log.action === "hook.afterConversationWindow"), true);
  assert.equal(windowTrace.auditLogs.some((log) => log.action === "hook.afterEventExtracted"), true);

  const impressionOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "creator",
    conversationId: "conv-memory-direct",
    message: "记住：以后回答架构问题先说结论。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(impressionOutput.memoryWrites.some((memory) => memory.memoryType === "impression" && memory.userId === "user-memory"), false);
  assert.equal(repos.listMemories({ memoryType: "impression", userId: "user-memory" }).length, 0);

  const skillOutput = await runtime.run({
    agentId: "default-agent",
    userId: "user-memory",
    userRole: "creator",
    conversationId: "conv-memory-skill",
    message: "请总结经验：在 Node 项目中先检查 lockfile 再运行测试。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(skillOutput.memoryWrites.some((memory) => memory.memoryType === "skill" && memory.workspaceId === "cli" && !memory.userId), true);
  const skillMemory = skillOutput.memoryWrites.find((memory) => memory.memoryType === "skill");
  assert.equal(metadataOf(skillMemory!).qualityGate.workspaceScoped, true);
  assert.equal(Array.isArray(metadataOf(skillMemory!).procedure), true);
  assert.equal(skillMemory!.summary.includes("lockfile"), true);
  assert.equal(metadataOf(skillMemory!).procedure.some((step: string) => step.includes("lockfile")), true);
  assert.equal(metadataOf(skillMemory!).appliesWhen.some((item: string) => item.includes("cli workspace")), true);
  const skillTrace = repos.getTrace("conv-memory-skill");
  assert.equal(skillTrace.auditLogs.some((log) => log.action === "hook.afterSkillExtracted"), true);
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
  const resultEvent = events.find((memory) => memory.relationId === "event:stream-memory-user:main:conv-stream-memory-window:window:1:result");
  assert.equal(Boolean(resultEvent), true);
  assert.equal(metadataOf(resultEvent!).evidenceMessageIds.length, 20);
  assert.equal(resultEvent!.summary.includes("streamed assistant"), true);
  const trace = repos.getTrace("conv-stream-memory-window");
  assert.equal(trace.auditLogs.some((log) => log.action === "hook.afterConversationWindow"), true);
}

async function testSkillEvidenceFromWorkspaceEvents() {
  const repos = createRepos();
  for (let index = 1; index <= 10; index += 1) {
    const runtime = new AgentRuntime(repos, new MainToCliLLMClient());
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

  const runtime = new AgentRuntime(repos, new MainToCliLLMClient());
  const output = await runtime.run({
    agentId: "default-agent",
    userId: "skill-evidence-user",
    userRole: "creator",
    conversationId: "conv-skill-evidence",
    message: "请总结经验：在 Node 项目中先检查 lockfile 再运行测试。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  const skill = output.memoryWrites.find((memory) => memory.memoryType === "skill");
  assert.equal(Boolean(skill), true);
  const metadata = metadataOf(skill!);
  assert.equal(metadata.qualityGate.evidenceCount > 0, true);
  assert.equal(metadata.evidenceEventIds.length > 0, true);
  const eventIds = new Set(repos.listMemories({ memoryType: "event", userId: "skill-evidence-user", workspaceId: "cli" }).map((memory) => memory.id));
  assert.equal(metadata.evidenceEventIds.every((id: string) => eventIds.has(id)), true);
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
    message: "记住：以后用简洁中文回答。",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(output.assistantMessage, "记住了。");
  assert.equal(output.memoryWrites.some((memory) => memory.memoryType === "impression" && memory.userId === "tool-user"), true);
  const trace = repos.getTrace("conv-tool-memory");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
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
  const trace = repos.getTrace("conv-tool-loop-multi");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("toolLoopRound")), true);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "tool_result").length, 2);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "final_messages").length, 3);
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

  assert.equal(output.assistantMessage.includes("连续操作轮次"), true);
  assert.equal(fake.calls, 5);
  const trace = repos.getTrace("conv-tool-loop-limit");
  assert.equal(trace.toolCalls.length, 4);
  assert.equal(trace.llmCalls.length, 5);
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
    message: "记住：流式请求也要能写入记忆。",
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
  const trace = repos.getTrace("conv-stream-tool-memory");
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
  const trace = repos.getTrace("conv-stream-leak");
  assert.equal(trace.llmCalls.length, 2);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("internal workspace routing text")), true);
  assert.equal(trace.llmCalls.every((call) => call.providerBaseUrl === "https://api.302ai.com"), true);
  assert.equal(trace.llmCalls.every((call) => call.normalizedEndpoint === "https://api.302ai.com/v1/chat/completions"), true);
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
  const trace = repos.getTrace("conv-stream-tool-loop-multi");
  assert.equal(trace.llmCalls.length, 3);
  assert.equal(trace.llmCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls.every((call) => call.status === "completed"), true);
  assert.equal(trace.llmCalls.some((call) => call.responseJson.includes("toolLoopRound")), true);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "tool_result").length, 2);
  assert.equal(trace.contextSegments.filter((segment) => segment.segmentType === "final_messages").length, 3);
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
    assert.equal(done.output.assistantMessage.includes("\u8fde\u7eed\u64cd\u4f5c\u8f6e\u6b21"), true);
  }
  assert.equal(fake.calls, 5);
  const trace = repos.getTrace("conv-stream-tool-loop-limit");
  assert.equal(trace.toolCalls.length, 4);
  assert.equal(trace.llmCalls.length, 5);
  assert.equal(trace.auditLogs.some((log) => log.action === "tool_loop_stopped"), true);
}

async function testWorkspaceEntryApprovalGate() {
  const repos = createRepos();
  const enterArgs = { workspaceId: "cli", objective: "run tests in terminal" };
  const firstFake = new SingleToolRequestLLMClient("enterWorkspace", enterArgs);
  const firstRuntime = new AgentRuntime(repos, firstFake);
  const firstOutput = await firstRuntime.run({
    agentId: "default-agent",
    userId: "workspace-approval-user",
    userRole: "user",
    conversationId: "conv-workspace-entry-approval",
    message: "请进入命令行工作空间运行测试",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(firstOutput.activeWorkspaceId, "main");
  assert.equal(firstFake.lastToolResult.includes("requiresApproval"), true);
  assert.equal(firstFake.lastToolResult.includes("approvalRequestId"), true);
  const blockedTrace = repos.getTrace("conv-workspace-entry-approval");
  assert.equal(blockedTrace.sessions.some((session) => session.workspaceId === "cli"), false);
  assert.equal(blockedTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "blocked"), true);
  assert.equal(blockedTrace.approvalRequests.length, 1);
  assert.equal(blockedTrace.approvalRequests[0].workspaceId, "cli");
  assert.equal(blockedTrace.approvalRequests[0].toolName, "enterWorkspace");
  assert.equal(blockedTrace.auditLogs.some((log) => log.action === "workspace_enter_rejected" && log.workspaceId === "cli"), true);

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
    message: "现在继续进入命令行工作空间",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(retryOutput.activeWorkspaceId, "cli");
  assert.equal(retryFake.lastToolResult.includes("workspaceResult"), true);
  const approvedTrace = repos.getTrace("conv-workspace-entry-approval");
  assert.equal(approvedTrace.sessions.some((session) => session.workspaceId === "cli"), true);
  assert.equal(approvedTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(approvedTrace.auditLogs.some((log) => log.action === "approval_reused" && log.workspaceId === "cli"), true);
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
  assert.equal(output.assistantMessage, "工具结果已处理。");
  assert.equal(hallucinated.lastToolResult.includes("active workspace"), true);
  const wrongWorkspaceTrace = repos.getTrace("conv-tool-policy-wrong-workspace");
  assert.equal(wrongWorkspaceTrace.toolCalls.length, 1);
  assert.equal(wrongWorkspaceTrace.toolCalls[0].toolName, "runCommand");
  assert.equal(wrongWorkspaceTrace.toolCalls[0].status, "blocked");
  assert.equal(wrongWorkspaceTrace.auditLogs.some((log) => log.action === "hook.beforeToolCall"), true);
  assert.equal(wrongWorkspaceTrace.auditLogs.some((log) => log.action === "hook.afterToolCall"), true);

  const highRisk = new MainToCliToolRequestLLMClient("runCommand", { command: "npm test" });
  updateWorkspaceGate(repos, "cli", { requiresApproval: 0, riskLevel: "medium" });
  const highRiskRuntime = new AgentRuntime(repos, highRisk);
  await highRiskRuntime.run({
    agentId: "default-agent",
    userId: "tool-policy-user",
    userRole: "user",
    conversationId: "conv-tool-policy-high-risk",
    message: "请在终端运行 npm test",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(highRisk.lastToolResult.includes("requiresApproval"), true);
  assert.equal(highRisk.lastToolResult.includes("approvalRequestId"), true);
  const highRiskTrace = repos.getTrace("conv-tool-policy-high-risk");
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
    message: "普通聊天，但模型尝试修改自我认知",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(agentSelf.lastToolResult.includes("requiresApproval"), true);
  assert.equal(repos.listMemories({ memoryType: "impression" }).some((memory) => memory.agentId === "default-agent"), false);
  const trace = repos.getTrace("conv-agent-self-policy");
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].toolName, "writeAgentSelfImpression");
  assert.equal(trace.toolCalls[0].status, "blocked");
}

async function testWorkspaceMemoryManagementTools() {
  const repos = createRepos();
  const memory = repos.createMemory({
    memoryType: "impression",
    userId: "memory-manager",
    title: "Original preference",
    summary: "Original summary",
    detail: "Original detail",
    metadataJson: JSON.stringify({ impressionKind: "userImpression" })
  }, "memory-manager", "user");

  const updateTool = new SingleToolRequestLLMClient("updateMemory", {
    id: memory.id,
    summary: "Updated through workspace memory tool"
  });
  const updateRuntime = new AgentRuntime(repos, updateTool);
  await updateRuntime.run({
    agentId: "default-agent",
    userId: "memory-manager",
    userRole: "user",
    conversationId: "conv-memory-tool-update",
    message: "memory update record",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(repos.getMemory(memory.id).summary, "Updated through workspace memory tool");
  const updateTrace = repos.getTrace("conv-memory-tool-update");
  assert.equal(updateTrace.toolCalls.some((call) => call.toolName === "enterWorkspace"), false);
  assert.equal(updateTrace.toolCalls.some((call) => call.toolName === "updateMemory" && call.status === "completed"), true);
  assert.equal(updateTrace.auditLogs.some((log) => log.action === "memory_tool_update"), true);

  const deleteTool = new MainToWorkspaceToolRequestLLMClient("file", "deleteMemory", { id: memory.id, deleteReason: "user asked to remove stale preference" });
  const deleteRuntime = new AgentRuntime(repos, deleteTool);
  await deleteRuntime.run({
    agentId: "default-agent",
    userId: "memory-manager",
    userRole: "user",
    conversationId: "conv-memory-tool-delete",
    message: "memory delete record",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.throws(() => repos.getMemory(memory.id));
  const deletedMemory = repos.getMemoryIncludingDeleted(memory.id);
  assert.equal(deletedMemory.deleteReason, "user asked to remove stale preference");
  assert.equal(deletedMemory.deletedBy, "memory-manager");
  const deleteTrace = repos.getTrace("conv-memory-tool-delete");
  assert.equal(deleteTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(deleteTrace.toolCalls.some((call) => call.toolName === "deleteMemory" && call.status === "completed"), true);
  assert.equal(deleteTrace.auditLogs.some((log) => log.action === "memory_tool_delete"), true);
}

async function testMemoryManagementToolsAreWorkspaceLocalAndPolicyGated() {
  const repos = createRepos();
  const eventMemory = repos.createMemory({
    memoryType: "event",
    userId: "scoped-memory-user",
    workspaceId: "file",
    title: "Scoped event",
    summary: "Scoped event summary",
    detail: "Scoped event detail",
    metadataJson: JSON.stringify({ eventKind: "manual", conversationId: "conv-memory-tool-wrong-workspace" })
  }, "creator", "creator");
  const workspaceLocalUpdate = new MainToWorkspaceToolRequestLLMClient("file", "updateMemory", {
    id: eventMemory.id,
    summary: "Updated from file workspace memory tool"
  });
  const runtime = new AgentRuntime(repos, workspaceLocalUpdate);
  await runtime.run({
    agentId: "default-agent",
    userId: "scoped-memory-user",
    userRole: "user",
    conversationId: "conv-memory-tool-wrong-workspace",
    message: "search files and update record",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(repos.getMemory(eventMemory.id).summary, "Updated from file workspace memory tool");
  const wrongTrace = repos.getTrace("conv-memory-tool-wrong-workspace");
  assert.equal(wrongTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(wrongTrace.toolCalls.some((call) => call.toolName === "updateMemory" && call.status === "completed"), true);

  const cliEventMemory = repos.createMemory({
    memoryType: "event",
    userId: "scoped-memory-user",
    workspaceId: "cli",
    title: "CLI scoped event",
    summary: "CLI scoped event summary",
    detail: "CLI scoped event detail",
    metadataJson: JSON.stringify({ eventKind: "manual", conversationId: "conv-memory-tool-cross-workspace" })
  }, "creator", "creator");
  const crossWorkspaceUpdate = new MainToWorkspaceToolRequestLLMClient("file", "updateMemory", {
    id: cliEventMemory.id,
    summary: "Should not update from file workspace"
  });
  const crossWorkspaceRuntime = new AgentRuntime(repos, crossWorkspaceUpdate);
  await crossWorkspaceRuntime.run({
    agentId: "default-agent",
    userId: "scoped-memory-user",
    userRole: "user",
    conversationId: "conv-memory-tool-cross-workspace",
    message: "enter file and update cli memory",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(crossWorkspaceUpdate.lastToolResult.includes("active workspace (file)"), true);
  assert.equal(repos.getMemory(cliEventMemory.id).summary, "CLI scoped event summary");
  const crossUpdateTrace = repos.getTrace("conv-memory-tool-cross-workspace");
  assert.equal(crossUpdateTrace.toolCalls.some((call) => call.toolName === "updateMemory" && call.status === "failed"), true);
  assert.equal(crossUpdateTrace.auditLogs.some((log) => log.action === "memory_management_rejected" && log.metadataJson.includes("active workspace")), true);

  const crossWorkspaceSearch = new MainToWorkspaceToolRequestLLMClient("file", "searchMemory", {
    query: "CLI scoped",
    workspaceId: "cli"
  });
  const crossSearchRuntime = new AgentRuntime(repos, crossWorkspaceSearch);
  await crossSearchRuntime.run({
    agentId: "default-agent",
    userId: "scoped-memory-user",
    userRole: "user",
    conversationId: "conv-memory-tool-cross-search",
    message: "enter file and search cli memory",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(crossWorkspaceSearch.lastToolResult.includes("active workspace (file)"), true);
  const crossSearchTrace = repos.getTrace("conv-memory-tool-cross-search");
  assert.equal(crossSearchTrace.toolCalls.some((call) => call.toolName === "searchMemory" && call.status === "failed"), true);

  const skill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    title: "Shared skill",
    summary: "Shared skill summary",
    detail: "Shared skill detail",
    metadataJson: JSON.stringify({ desensitized: true })
  }, "creator", "creator");
  const deleteSkill = new MainToWorkspaceToolRequestLLMClient("file", "deleteMemory", { id: skill.id });
  const deleteRuntime = new AgentRuntime(repos, deleteSkill);
  await deleteRuntime.run({
    agentId: "default-agent",
    userId: "scoped-memory-user",
    userRole: "user",
    conversationId: "conv-memory-tool-skill-policy",
    message: "memory delete shared skill",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(deleteSkill.lastToolResult.includes("Shared skill memory management requires creator role"), true);
  assert.equal(repos.getMemory(skill.id).summary, "Shared skill summary");
  const skillTrace = repos.getTrace("conv-memory-tool-skill-policy");
  assert.equal(skillTrace.toolCalls.some((call) => call.toolName === "deleteMemory" && call.status === "failed"), true);
  assert.equal(skillTrace.auditLogs.some((log) => log.action === "memory_management_rejected"), true);
}

async function testSkillMemoryUpdateQualityGate() {
  const repos = createRepos();
  const skill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    title: "General file workflow",
    summary: "Search relevant files before making focused edits.",
    detail: "Use search evidence to limit the file edit scope.",
    metadataJson: JSON.stringify({
      desensitized: true,
      confidence: 0.8,
      qualityGate: {
        reusable: true,
        userPrivateDetailRemoved: true,
        workspaceScoped: true,
        evidenceCount: 1
      },
      procedure: ["Search relevant files.", "Edit the smallest necessary file set."],
      appliesWhen: ["A file workspace task needs code or document inspection."],
      avoidWhen: ["The task requires user-specific identifiers or sensitive project details."]
    })
  }, "creator", "creator");

  const invalidUpdate = new MainToWorkspaceToolRequestLLMClient("file", "updateMemory", {
    id: skill.id,
    summary: "Use G:\\Jomy\\Documents\\PrivateProject before editing files."
  });
  const invalidRuntime = new AgentRuntime(repos, invalidUpdate);
  await invalidRuntime.run({
    agentId: "default-agent",
    userId: "creator",
    userRole: "creator",
    conversationId: "conv-skill-update-quality-invalid",
    message: "memory update shared skill with private path",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(invalidUpdate.lastToolResult.includes("private user/project details"), true);
  assert.equal(repos.getMemory(skill.id).summary, "Search relevant files before making focused edits.");
  const invalidTrace = repos.getTrace("conv-skill-update-quality-invalid");
  assert.equal(invalidTrace.toolCalls.some((call) => call.toolName === "updateMemory" && call.status === "failed"), true);
  assert.equal(invalidTrace.auditLogs.some((log) => log.action === "memory_management_rejected" && log.metadataJson.includes("private user/project details")), true);

  const validUpdate = new MainToWorkspaceToolRequestLLMClient("file", "updateMemory", {
    id: skill.id,
    summary: "Search relevant files and keep edits scoped to the evidence."
  });
  const validRuntime = new AgentRuntime(repos, validUpdate);
  await validRuntime.run({
    agentId: "default-agent",
    userId: "creator",
    userRole: "creator",
    conversationId: "conv-skill-update-quality-valid",
    message: "memory update shared skill safely",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(repos.getMemory(skill.id).summary, "Search relevant files and keep edits scoped to the evidence.");
  const validTrace = repos.getTrace("conv-skill-update-quality-valid");
  assert.equal(validTrace.toolCalls.some((call) => call.toolName === "updateMemory" && call.status === "completed"), true);
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
      workspaceId: "file",
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
      workspaceId: "file",
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

  const ownEvent = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "file",
      title: "Own direct event",
      summary: "The current user inspected files.",
      detail: "This record should be visible to the same user.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", eventKind: "manual" })
    }
  });
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "other-api-user",
      workspaceId: "file",
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
      workspaceId: "file",
      title: "Other direct event",
      summary: "Another user inspected files.",
      detail: "This record must not be visible to ordinary-api-user.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-other-direct-event", eventKind: "manual" })
    }
  });
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
  const ownCliEvent = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "cli",
      title: "Own CLI event",
      summary: "The current user ran a CLI check.",
      detail: "This event belongs to a different workspace than the file skill.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", eventKind: "manual" })
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
  const evidenceBackedSkill = service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
      title: "Evidence-backed direct skill",
      summary: "Use same-workspace event evidence before sharing a file workflow.",
      detail: "This reusable method is backed by current-user file workspace evidence.",
      metadataJson: evidenceSkillMetadata([ownEvent.id], "conv-direct-skill-evidence")
    }
  });
  assert.equal(evidenceBackedSkill.memoryType, "skill");
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
      title: "Cross user evidence skill",
      summary: "Use another user's file event as evidence.",
      detail: "This should be rejected because ordinary users cannot cite another user's event evidence.",
      metadataJson: evidenceSkillMetadata([otherEvent.id])
    }
  }), /another user/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
      title: "Cross workspace evidence skill",
      summary: "Use CLI evidence for a file workspace skill.",
      detail: "This should be rejected because evidence must belong to the same workspace.",
      metadataJson: evidenceSkillMetadata([ownCliEvent.id])
    }
  }), /same workspace/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
      title: "Non event evidence skill",
      summary: "Use an impression record as skill evidence.",
      detail: "This should be rejected because evidence ids must point to event memory.",
      metadataJson: evidenceSkillMetadata([ownImpression.id])
    }
  }), /event memory/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
      title: "Missing evidence skill",
      summary: "Use a missing memory id as skill evidence.",
      detail: "This should be rejected because the evidence record does not exist.",
      metadataJson: evidenceSkillMetadata(["mem_missing"])
    }
  }), /not found/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "skill",
      workspaceId: "file",
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
      workspaceId: "file",
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
      workspaceId: "file",
      title: "Event with bad kind",
      summary: "Event memory must include a recognized kind.",
      detail: "This should be rejected because eventKind is not part of the event contract.",
      metadataJson: JSON.stringify({ source: "directApiTest", conversationId: "conv-direct-skill-evidence", eventKind: "note" })
    }
  }), /metadata\.eventKind/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "event",
      userId: "ordinary-api-user",
      workspaceId: "file",
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
  }), /requires userId or agentId/);
  assert.throws(() => service.createMemoryRecord({
    actorId: "ordinary-api-user",
    actorRole: "user",
    memory: {
      memoryType: "impression",
      userId: "ordinary-api-user",
      agentId: "default-agent",
      title: "Ambiguous impression",
      summary: "Impressions must not target both user and agent.",
      detail: "This should be rejected because the scope is ambiguous."
    }
  }), /either a user or agent self/);
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
      workspaceId: "file",
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
    actorRole: "user"
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
}

async function testSearchMemoryToolUsesPolicyLayer() {
  const repos = createRepos();
  const service = new MemoryService(repos);
  const ownEvent = repos.createMemory({
    memoryType: "event",
    userId: "search-user",
    workspaceId: "file",
    title: "Search own event",
    summary: "Policy search alpha event",
    detail: "Visible to the owning user."
  }, "creator", "creator");
  const otherEvent = repos.createMemory({
    memoryType: "event",
    userId: "other-search-user",
    workspaceId: "file",
    title: "Search other event",
    summary: "Policy search alpha event",
    detail: "Hidden from non-creator search."
  }, "creator", "creator");
  const sharedSkill = repos.createMemory({
    memoryType: "skill",
    workspaceId: "file",
    title: "Search shared skill",
    summary: "Policy search alpha skill",
    detail: "Shared workspace skill visible to users."
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
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", workspaceId: "file" })
  });
  assert.equal(userResult.ok, true);
  const userMemories = (userResult.result as { memories: MemoryRow[] }).memories;
  assert.equal(userMemories.some((memory) => memory.id === ownEvent.id), true);
  assert.equal(userMemories.some((memory) => memory.id === sharedSkill.id), true);
  assert.equal(userMemories.some((memory) => memory.id === otherEvent.id), false);
  assert.equal(userMemories.some((memory) => memory.id === agentSelf.id), false);

  const userTargetingOther = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "search-user",
      userRole: "user",
      conversationId: "conv-search-memory-user-target",
      message: "search memory"
    },
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", memoryType: "event", userId: "other-search-user", workspaceId: "file" })
  });
  assert.equal(userTargetingOther.ok, true);
  assert.equal((userTargetingOther.result as { memories: MemoryRow[] }).memories.some((memory) => memory.id === otherEvent.id), false);

  const creatorResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "creator",
      userRole: "creator",
      conversationId: "conv-search-memory-creator",
      message: "search memory"
    },
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", userId: "other-search-user", workspaceId: "file" })
  });
  assert.equal(creatorResult.ok, true);
  const creatorMemories = (creatorResult.result as { memories: MemoryRow[] }).memories;
  assert.equal(creatorMemories.some((memory) => memory.id === otherEvent.id), true);

  const creatorSelfResult = service.executeMemoryTool({
    run: {
      agentId: "default-agent",
      userId: "creator",
      userRole: "creator",
      conversationId: "conv-search-memory-creator-self",
      message: "search memory"
    },
    toolName: "searchMemory",
    argumentsJson: JSON.stringify({ query: "alpha", memoryType: "impression", agentId: "default-agent" })
  });
  assert.equal((creatorSelfResult.result as { memories: MemoryRow[] }).memories.some((memory) => memory.id === agentSelf.id), true);
}

async function testToolBindingsAndMcpReadiness() {
  const repos = createRepos();
  const searchFiles = repos.listTools().find((tool) => tool.name === "searchFiles");
  const runCommand = repos.listTools().find((tool) => tool.name === "runCommand");
  const exitWorkspace = repos.listTools().find((tool) => tool.name === "exitWorkspace");
  const writeUserImpression = repos.listTools().find((tool) => tool.name === "writeUserImpression");
  const searchMemory = repos.listTools().find((tool) => tool.name === "searchMemory");
  const updateMemory = repos.listTools().find((tool) => tool.name === "updateMemory");
  const deleteMemory = repos.listTools().find((tool) => tool.name === "deleteMemory");
  assert.equal(searchFiles?.bindingType, "mcp");
  assert.equal(searchFiles?.mcpServerId, "local.file");
  assert.equal(runCommand?.bindingType, "mcp");
  assert.equal(runCommand?.mcpToolName, "runCommand");
  assert.equal(exitWorkspace?.bindingType, "runtime");
  assert.equal(writeUserImpression?.bindingType, "runtime");
  assert.equal(searchMemory?.bindingType, "runtime");
  assert.equal(updateMemory?.bindingType, "runtime");
  assert.equal(deleteMemory?.bindingType, "runtime");
  assert.equal(repos.listWorkspaces().some((workspace) => workspace.id === "memory"), false);
  assert.equal(repos.listToolsForWorkspace("main").some((tool) => tool.name === "updateMemory"), true);
  assert.equal(repos.listToolsForWorkspace("file").some((tool) => tool.name === "updateMemory"), true);
  assert.equal(repos.listToolsForWorkspace("cli").some((tool) => tool.name === "updateMemory"), true);
  const exitWorkspaceSchema = JSON.parse(exitWorkspace?.parametersJson ?? "{}") as { required?: string[] };
  for (const field of ["status", "summary", "artifacts", "observations", "errors", "suggestedNextSteps"]) {
    assert.equal(exitWorkspaceSchema.required?.includes(field), true);
  }
  const updateMemorySchema = JSON.parse(updateMemory?.parametersJson ?? "{}") as { properties?: Record<string, unknown> };
  assert.equal(Boolean(updateMemorySchema.properties?.memoryType), true);
  assert.equal(Boolean(updateMemorySchema.properties?.userId), true);
  assert.equal(Boolean(updateMemorySchema.properties?.workspaceId), true);
  assert.equal(Boolean(updateMemorySchema.properties?.relationId), true);
  assert.equal(Boolean(updateMemorySchema.properties?.version), true);
  const searchMemorySchema = JSON.parse(searchMemory?.parametersJson ?? "{}") as { properties?: Record<string, unknown> };
  assert.equal(Boolean(searchMemorySchema.properties?.memoryType), true);
  assert.equal(Boolean(searchMemorySchema.properties?.userId), true);
  assert.equal(Boolean(searchMemorySchema.properties?.agentId), true);
  assert.equal(Boolean(searchMemorySchema.properties?.workspaceId), true);

  const mcpTool = new MainToWorkspaceToolRequestLLMClient("file", "searchFiles", { query: "runtime" });
  const runtime = new AgentRuntime(repos, mcpTool);
  await runtime.run({
    agentId: "default-agent",
    userId: "tool-binding-user",
    userRole: "creator",
    conversationId: "conv-tool-binding-mcp",
    message: "search files for runtime",
    llm: {
      baseUrl: "https://api.302ai.com",
      model: "gpt-5-mini",
      apiKey: "test-key"
    }
  });
  assert.equal(mcpTool.lastToolResult.includes("MCP tool binding"), true);
  assert.equal(mcpTool.lastToolResult.includes("local.file"), true);
  const mcpTrace = repos.getTrace("conv-tool-binding-mcp");
  assert.equal(mcpTrace.toolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
  assert.equal(mcpTrace.toolCalls.some((call) => call.toolName === "searchFiles" && call.status === "failed"), true);
  const mcpFileSession = mcpTrace.sessions.find((session) => session.workspaceId === "file");
  assert.equal(mcpFileSession?.localContext.recentToolCalls.some((call) => call.toolName === "searchFiles" && call.status === "failed"), true);
  assert.equal(mcpFileSession?.result.observations.some((item) => item.includes("Tool searchFiles finished with status failed")), true);

  const enterWorkspace = new SingleToolRequestLLMClient("enterWorkspace", { workspaceId: "file", objective: "search runtime files" });
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
  const runtimeTrace = repos.getTrace("conv-tool-binding-runtime");
  assert.equal(runtimeTrace.toolCalls[0].status, "completed");
  assert.equal(runtimeTrace.sessions.some((session) => session.workspaceId === "file"), true);
  const runtimeMainSession = runtimeTrace.sessions.find((session) => session.workspaceId === "main");
  assert.equal(runtimeMainSession?.localContext.recentToolCalls.some((call) => call.toolName === "enterWorkspace" && call.status === "completed"), true);
}

async function testSeedRefreshesExistingToolSchemas() {
  const db = new Database(":memory:");
  migrate(db);
  seedDefaults(db);
  db.prepare("UPDATE tool_definitions SET parametersJson = ? WHERE id = 'tool-update-memory'").run(JSON.stringify({
    type: "object",
    properties: {
      id: { type: "string" },
      summary: { type: "string" }
    },
    required: ["id"],
    additionalProperties: false
  }));
  seedDefaults(db);
  const repos = new Repositories(db);
  const updateMemory = repos.listTools().find((tool) => tool.name === "updateMemory");
  const schema = JSON.parse(updateMemory?.parametersJson ?? "{}") as { properties?: Record<string, unknown> };
  assert.equal(Boolean(schema.properties?.memoryType), true);
  assert.equal(Boolean(schema.properties?.workspaceId), true);
  assert.equal(Boolean(schema.properties?.metadataJson), true);
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
  const trace = repos.getTrace("conv-fail");
  assert.equal(trace.llmCalls.length, 1);
  assert.equal(trace.llmCalls[0].status, "failed");
  assert.equal(trace.llmCalls[0].errorText, "provider timeout");
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
  const trace = repos.getTrace("conv-pending");
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
    workspaceId: "cli",
    toolName: "runCommand",
    argumentsJson: "{}",
    reason: "test approval cleanup"
  });

  repos.deleteConversation("conv-delete", "delete-user", "user", "user cleared conversation");
  const trace = repos.getTrace("conv-delete");
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
    toolIds: []
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
    workspaceId: "file",
    title: "File event",
    summary: "File event summary",
    detail: "File event detail"
  }, "creator", "creator");

  assert.throws(() => repos.deleteWorkspace("temporary", "workspace-delete-user", "user"));
  assert.throws(() => repos.deleteWorkspace("main", "creator", "creator"));
  repos.deleteWorkspace("temporary", "creator", "creator", "workspace no longer needed");

  assert.throws(() => repos.getWorkspace("temporary"));
  assert.equal(repos.listMemories({ workspaceId: "temporary" }).some((memory) => memory.id === eventMemory.id || memory.id === skillMemory.id), false);
  assert.equal(repos.getMemoryIncludingDeleted(eventMemory.id).deleteReason, "workspace deleted: workspace no longer needed");
  assert.equal(repos.getMemoryIncludingDeleted(skillMemory.id).deleteReason, "workspace deleted: workspace no longer needed");
  assert.equal(repos.getMemory(unrelatedMemory.id).id, unrelatedMemory.id);
  assert.equal(repos.listAuditLogs({ limit: 200 }).some((log) => log.action === "workspace_delete" && log.resourceId === "temporary"), true);
}

async function testWorkspaceBoundary() {
  const repos = createRepos();
  const mainTools = repos.listToolsForWorkspace("main").map((tool) => tool.name);
  const fileTools = repos.listToolsForWorkspace("file").map((tool) => tool.name);
  const cliTools = repos.listToolsForWorkspace("cli").map((tool) => tool.name);
  const memoryTools = ["searchMemory", "writeUserImpression", "writeAgentSelfImpression", "writeEventMemory", "writeSkillMemory", "updateMemory", "deleteMemory"];
  assert.equal(repos.listWorkspaces().some((workspace) => workspace.id === "memory"), false);
  assert.equal(["askUser", "enterWorkspace", "finishTask"].every((tool) => mainTools.includes(tool)), true);
  assert.equal(memoryTools.every((tool) => mainTools.includes(tool)), true);
  assert.equal(memoryTools.every((tool) => fileTools.includes(tool)), true);
  assert.equal(memoryTools.every((tool) => cliTools.includes(tool)), true);
  assert.equal(fileTools.includes("runCommand"), false);
  assert.equal(cliTools.includes("searchFiles"), false);
}

async function testMainOrchestrationTools() {
  const repos = createRepos();
  const askUser = new SingleToolRequestLLMClient("askUser", {
    question: "Which target should I use?",
    reason: "The request is missing a target.",
    choices: ["target A", "target B"]
  });
  const askRuntime = new AgentRuntime(repos, askUser);
  await askRuntime.run({
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
  assert.equal(askUser.lastToolResult.includes("needs_user_input"), true);
  assert.equal(askUser.lastToolResult.includes("Which target should I use?"), true);
  const askTrace = repos.getTrace("conv-main-tool-ask");
  assert.equal(askTrace.toolCalls.some((call) => call.toolName === "askUser" && call.status === "completed"), true);

  const finishTask = new SingleToolRequestLLMClient("finishTask", {
    summary: "The main workspace has enough information to answer.",
    response: "Final response text.",
    nextSteps: ["Reply to user"]
  });
  const finishRuntime = new AgentRuntime(repos, finishTask);
  await finishRuntime.run({
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
  assert.equal(finishTask.lastToolResult.includes("final_response_ready"), true);
  assert.equal(finishTask.lastToolResult.includes("Final response text."), true);
  const finishTrace = repos.getTrace("conv-main-tool-finish");
  assert.equal(finishTrace.toolCalls.some((call) => call.toolName === "finishTask" && call.status === "completed"), true);
}

async function main() {
  await testDatabaseAndMemory();
  await testAgentUpdateRequiresCreatorRole();
  await testTraceAndToolLogsAreUserScoped();
  await testLlmLogsAreUserScoped();
  await testApprovalListIsUserScoped();
  await testRuntimeContextAndTools();
  await testAttentionBudgetTrimsHistoryButKeepsJson();
  await testAgentSelfImpressionRecallIsAgentScoped();
  await testWorkspaceExitReturnsToMain();
  await testMalformedWorkspaceExitDoesNotCommitSession();
  await testWorkspaceSessionLocalToolCallsAreSessionScoped();
  await testWorkspaceMemoryPolicyControlsRecall();
  await testWorkspaceMemoryPolicyControlsWrites();
  await testEventMemoryMetadataContract();
  await testSkillMemoryToolQualityGate();
  await testRuntimeStreaming();
  await testLlmFailureLog();
  await testPendingLlmCallsInterruptedOnStartup();
  await testConversationDeletionLifecycle();
  await testWorkspaceDeletionLifecycle();
  await testMainOrchestrationTools();
  await testMemoryLifecycleHooks();
  await testStreamingConversationWindowMemoryIncludesAssistantMessage();
  await testSkillEvidenceFromWorkspaceEvents();
  await testMemoryToolCallLoop();
  await testMultiStepToolLoop();
  await testToolLoopStopsAtLimit();
  await testStreamingMemoryToolCallLoop();
  await testStreamingToolRoundTextIsNotLeaked();
  await testStreamingMultiStepToolLoop();
  await testStreamingToolLoopStopsAtLimit();
  await testWorkspaceEntryApprovalGate();
  await testToolPolicyGates();
  await testRuntimeMemoryToolsAreUniversalAndPolicyGated();
  await testWorkspaceMemoryManagementTools();
  await testMemoryManagementToolsAreWorkspaceLocalAndPolicyGated();
  await testSkillMemoryUpdateQualityGate();
  await testDirectMemoryApiUsesPolicyLayer();
  await testSearchMemoryToolUsesPolicyLayer();
  await testToolBindingsAndMcpReadiness();
  await testSeedRefreshesExistingToolSchemas();
  await testWorkspaceBoundary();
  console.log("All tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

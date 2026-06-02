import type { AgentRunInput, MemoryRow, ToolDefinition, WorkspaceResult, WorkspaceSession, WorkspaceStatus } from "../types";
import { Repositories } from "../db/repositories";
import { MemoryService } from "./memory-service";
import { PolicyEngine } from "./policy-engine";
import { WorkspaceRuntime } from "./workspace-runtime";
import { McpToolExecutor } from "./mcp-executor";
import { executeBash, executeEdit, executeRead, executeWrite } from "./builtin-tools";
import { SafeExtensionRegistry } from "./extension-registry";

export type ToolExecutionResult = {
  ok: boolean;
  status: "completed" | "failed" | "blocked";
  result: unknown;
  memory?: MemoryRow;
  workspaceSession?: WorkspaceSession;
  exitedWorkspaceResult?: Partial<WorkspaceResult>;
  mainWorkspaceResult?: Partial<WorkspaceResult>;
  terminalAssistantMessage?: string;
};

export class ToolRegistry {
  private readonly universalRuntimeMemoryToolNames = new Set([
    "searchMemory",
    "readMemory",
    "readSkill",
    "writeUserImpression",
    "writeAgentSelfImpression",
    "writeSkillMemory"
  ]);
  private readonly runtimeOrchestrationToolNames = new Set(["exitWorkspace"]);
  private readonly mainOnlyToolNames = new Set(["enterWorkspace", "askUser", "finishTask"]);
  private readonly runtimeMemoryToolNames = this.universalRuntimeMemoryToolNames;
  private readonly mcpToolExecutor = new McpToolExecutor();

  constructor(
    private readonly repos: Repositories,
    private readonly memoryService: MemoryService,
    private readonly workspaceRuntime: WorkspaceRuntime,
    private readonly policy: PolicyEngine,
    private readonly extensionRegistry: SafeExtensionRegistry = new SafeExtensionRegistry()
  ) {}

  getCallableTools(workspaceId: string): ToolDefinition[] {
    const activeTools = this.repos
      .listToolsForWorkspace(workspaceId)
      .filter((tool) => this.isToolVisibleInWorkspace(tool.name, workspaceId));
    const existing = new Set(activeTools.map((tool) => tool.name));
    const runtimeMemoryTools = this.repos.listTools()
      .filter((tool) => this.universalRuntimeMemoryToolNames.has(tool.name) && !existing.has(tool.name));
    const runtimeOrchestrationTools = workspaceId === "main"
      ? []
      : this.repos.listTools().filter((tool) => this.runtimeOrchestrationToolNames.has(tool.name) && !existing.has(tool.name));
    const nextExisting = new Set([
      ...existing,
      ...runtimeOrchestrationTools.map((tool) => tool.name),
      ...runtimeMemoryTools.map((tool) => tool.name)
    ]);
    const extensionTools = this.extensionRegistry
      .listTools(workspaceId)
      .filter((tool) => !nextExisting.has(tool.name));
    return [...activeTools, ...runtimeOrchestrationTools, ...runtimeMemoryTools, ...extensionTools];
  }

  async execute(input: {
    run: AgentRunInput;
    activeWorkspaceId: string;
    activeWorkspaceSession?: WorkspaceSession;
    callableTools: ToolDefinition[];
    toolName: string;
    argumentsJson: string;
  }): Promise<ToolExecutionResult> {
    const tool = input.callableTools.find((item) => item.name === input.toolName)
      ?? this.repos.listTools().find((item) => item.name === input.toolName);
    if (!tool) {
      return { ok: false, status: "blocked", result: { error: `Unknown tool: ${input.toolName}` } };
    }

    const registeredToActiveWorkspace = this.repos
      .listToolsForWorkspace(input.activeWorkspaceId)
      .some((item) => item.name === input.toolName && this.isToolVisibleInWorkspace(item.name, input.activeWorkspaceId))
      || Boolean(this.extensionRegistry.getTool(input.activeWorkspaceId, input.toolName));
    const runtimeTool = this.universalRuntimeMemoryToolNames.has(input.toolName)
      || (input.activeWorkspaceId !== "main" && this.runtimeOrchestrationToolNames.has(input.toolName));
    const decision = this.policy.canUseTool({
      role: input.run.userRole,
      tool,
      registeredToActiveWorkspace,
      runtimeTool
    });
    if (!decision.allowed) {
      const approved = decision.requiresApproval
        ? this.hasApprovedRequest({
          run: input.run,
          workspaceId: input.activeWorkspaceId,
          toolName: input.toolName,
          argumentsJson: input.argumentsJson
        })
        : false;
      if (approved) {
        this.repos.audit(input.run.userId, "system", "approval_reused", "tool", tool.id, {
          conversationId: input.run.conversationId,
          workspaceId: input.activeWorkspaceId,
          toolName: input.toolName
        });
      } else {
        const approvalRequest = decision.requiresApproval
        ? this.repos.createApprovalRequest({
          userId: input.run.userId,
          conversationId: input.run.conversationId,
          workspaceId: input.activeWorkspaceId,
          toolName: input.toolName,
          argumentsJson: input.argumentsJson,
          reason: decision.reason ?? "Tool call requires creator approval.",
          metadata: {
            toolId: tool.id,
            riskLevel: tool.riskLevel,
            bindingType: tool.bindingType,
            mcpServerId: tool.mcpServerId,
            mcpToolName: tool.mcpToolName
          }
        })
        : undefined;
        this.repos.audit(input.run.userId, input.run.userRole, "tool_call_rejected", "tool", tool.id, {
          conversationId: input.run.conversationId,
          workspaceId: input.activeWorkspaceId,
          toolName: input.toolName,
          reason: decision.reason,
          requiresApproval: decision.requiresApproval,
          approvalRequestId: approvalRequest?.id
        });
        return {
          ok: false,
          status: "blocked",
          result: {
            error: decision.reason ?? "Tool call rejected by runtime policy.",
            requiresApproval: decision.requiresApproval ?? false,
            approvalRequestId: approvalRequest?.id ?? null
          }
        };
      }
    }

    if (tool.bindingType === "runtime" || this.runtimeMemoryToolNames.has(input.toolName) || this.runtimeOrchestrationToolNames.has(input.toolName)) {
      const extensionTool = this.extensionRegistry.getTool(input.activeWorkspaceId, input.toolName);
      if (extensionTool) {
        return this.executeExtensionTool(input.run, input.activeWorkspaceId, input.toolName, input.argumentsJson, extensionTool.extensionId, extensionTool.tool);
      }
      return this.executeRuntimeTool(input.run, input.activeWorkspaceId, input.activeWorkspaceSession, input.toolName, input.argumentsJson);
    }

    if (tool.bindingType === "mcp") {
      return this.mcpToolExecutor.execute(tool, input.argumentsJson);
    }

    return {
      ok: false,
      status: "failed",
      result: {
        error: "Tool is registered for this workspace but is not bound to a runtime or MCP executor yet.",
        toolName: input.toolName,
        workspaceId: input.activeWorkspaceId,
        bindingType: tool.bindingType
      }
    };
  }

  private async executeExtensionTool(
    run: AgentRunInput,
    activeWorkspaceId: string,
    toolName: string,
    argumentsJson: string,
    extensionId: string,
    tool: { execute: (input: { args: Record<string, unknown>; run: AgentRunInput; workspaceId: string; toolName: string }) => Promise<unknown> | unknown }
  ): Promise<ToolExecutionResult> {
    try {
      const args = safeJson(argumentsJson) as Record<string, unknown>;
      const output = await tool.execute({ args, run, workspaceId: activeWorkspaceId, toolName });
      this.repos.audit(run.userId, "system", "extension_tool_executed", "tool", `extension:${extensionId}:tool:${toolName}`, {
        conversationId: run.conversationId,
        workspaceId: activeWorkspaceId,
        extensionId,
        toolName
      });
      return {
        ok: true,
        status: "completed",
        result: {
          extensionId,
          toolName,
          output
        }
      };
    } catch (error) {
      this.repos.audit(run.userId, "system", "extension_tool_failed", "tool", `extension:${extensionId}:tool:${toolName}`, {
        conversationId: run.conversationId,
        workspaceId: activeWorkspaceId,
        extensionId,
        toolName,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ok: false,
        status: "failed",
        result: {
          extensionId,
          toolName,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async executeRuntimeTool(run: AgentRunInput, activeWorkspaceId: string, activeWorkspaceSession: WorkspaceSession | undefined, toolName: string, argumentsJson: string): Promise<ToolExecutionResult> {
    const devWorkspaceRoot = this.devWorkspaceRoot();
    if (toolName === "bash") {
      if (activeWorkspaceId !== "dev") {
        return { ok: false, status: "failed", result: { error: "bash can only be called from dev workspace." } };
      }
      return executeBash(argumentsJson, { conversationId: run.conversationId, abortSignal: run.abortSignal, workspaceRoot: devWorkspaceRoot });
    }

    if (toolName === "read") {
      if (activeWorkspaceId !== "dev") {
        return { ok: false, status: "failed", result: { error: "read can only be called from dev workspace." } };
      }
      return executeRead(argumentsJson, { conversationId: run.conversationId, supportsImageContent: run.llm?.supportsImageContent, workspaceRoot: devWorkspaceRoot });
    }

    if (toolName === "write") {
      if (activeWorkspaceId !== "dev") {
        return { ok: false, status: "failed", result: { error: "write can only be called from dev workspace." } };
      }
      return executeWrite(argumentsJson, { conversationId: run.conversationId, workspaceRoot: devWorkspaceRoot });
    }

    if (toolName === "edit") {
      if (activeWorkspaceId !== "dev") {
        return { ok: false, status: "failed", result: { error: "edit can only be called from dev workspace." } };
      }
      return executeEdit(argumentsJson, { conversationId: run.conversationId, workspaceRoot: devWorkspaceRoot });
    }

    if (this.runtimeMemoryToolNames.has(toolName)) {
      const result = this.memoryService.executeMemoryTool({
        run,
        activeWorkspaceId,
        activeWorkspaceSessionId: activeWorkspaceSession?.id,
        activeTaskId: activeWorkspaceSession?.taskId,
        toolName,
        argumentsJson
      });
      return {
        ...result,
        status: result.ok ? "completed" : "failed"
      };
    }

    if (toolName === "enterWorkspace") {
      if (activeWorkspaceId !== "main") {
        return {
          ok: false,
          status: "failed",
          result: { error: "enterWorkspace can only be called from main workspace. Child workspaces must return suggestedNextSteps through exitWorkspace." }
        };
      }
      const args = safeJson(argumentsJson) as { workspaceId?: string; objective?: string };
      if (!args.workspaceId) {
        return {
          ok: false,
          status: "failed",
          result: { error: "enterWorkspace requires workspaceId." }
        };
      }
      try {
        const targetWorkspace = this.repos.getWorkspace(args.workspaceId);
        const decision = this.policy.canEnterWorkspace({
          role: run.userRole,
          workspace: targetWorkspace
        });
        if (!decision.allowed) {
          const approved = decision.requiresApproval
            ? this.hasApprovedRequest({
              run,
              workspaceId: targetWorkspace.id,
              toolName,
              argumentsJson
            })
            : false;
          if (!approved) {
            const approvalRequest = decision.requiresApproval
              ? this.repos.createApprovalRequest({
                userId: run.userId,
                conversationId: run.conversationId,
                workspaceId: targetWorkspace.id,
                toolName,
                argumentsJson,
                reason: decision.reason ?? "Workspace entry requires creator approval.",
                metadata: {
                  fromWorkspaceId: activeWorkspaceId,
                  targetWorkspaceId: targetWorkspace.id,
                  riskLevel: targetWorkspace.riskLevel,
                  requiresApproval: Boolean(targetWorkspace.requiresApproval)
                }
              })
              : undefined;
            this.repos.audit(run.userId, run.userRole, "workspace_enter_rejected", "workspace", targetWorkspace.id, {
              conversationId: run.conversationId,
              fromWorkspaceId: activeWorkspaceId,
              workspaceId: targetWorkspace.id,
              reason: decision.reason,
              requiresApproval: decision.requiresApproval,
              approvalRequestId: approvalRequest?.id
            });
            return {
              ok: false,
              status: "blocked",
              result: {
                error: decision.reason ?? "Workspace entry rejected by runtime policy.",
                workspaceId: targetWorkspace.id,
                requiresApproval: decision.requiresApproval ?? false,
                approvalRequestId: approvalRequest?.id ?? null
              }
            };
          }
          this.repos.audit(run.userId, "system", "approval_reused", "workspace", targetWorkspace.id, {
            conversationId: run.conversationId,
            fromWorkspaceId: activeWorkspaceId,
            workspaceId: targetWorkspace.id,
            toolName
          });
        }
        const session = this.workspaceRuntime.run({
          run,
          workspaceId: targetWorkspace.id,
          objective: args.objective ?? run.message
        });
        return {
          ok: true,
          status: "completed",
          workspaceSession: session,
          result: {
            workspaceId: args.workspaceId,
            enteredFromWorkspaceId: activeWorkspaceId,
            sessionId: session.id,
            task: session.task,
            workspaceResult: session.result
          }
        };
      } catch (error) {
        return {
          ok: false,
          status: "failed",
          result: {
            error: error instanceof Error ? error.message : String(error),
            toolName
          }
        };
      }
    }

    if (toolName === "exitWorkspace") {
      if (activeWorkspaceId === "main") {
        return {
          ok: false,
          status: "failed",
          result: { error: "exitWorkspace can only be called from a child workspace." }
        };
      }
      if (!activeWorkspaceSession || activeWorkspaceSession.status !== "running") {
        return {
          ok: false,
          status: "failed",
          result: { error: "exitWorkspace requires the active child workspace session to be running." }
        };
      }
      const args = safeJson(argumentsJson) as Partial<WorkspaceResult>;
      const validationError = validateWorkspaceResult(args);
      if (validationError) {
        return {
          ok: false,
          status: "failed",
          result: { error: validationError }
        };
      }
      const workspaceResult: Partial<WorkspaceResult> = {
        status: args.status,
        summary: args.summary,
        artifacts: args.artifacts,
        observations: args.observations,
        errors: args.errors,
        suggestedNextSteps: args.suggestedNextSteps
      };
      return {
        ok: true,
        status: "completed",
        exitedWorkspaceResult: workspaceResult,
        result: {
          exitedWorkspaceId: activeWorkspaceId,
          returnToWorkspaceId: "main",
          workspaceResult
        }
      };
    }

    if (toolName === "askUser") {
      if (activeWorkspaceId !== "main") {
        return {
          ok: false,
          status: "failed",
          result: { error: "askUser can only be called from main workspace. Child workspaces should return needs_user_input through exitWorkspace." }
        };
      }
      const args = safeJson(argumentsJson) as { question?: unknown; reason?: unknown; choices?: unknown };
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) {
        return {
          ok: false,
          status: "failed",
          result: { error: "askUser requires question." }
        };
      }
      const choices = Array.isArray(args.choices)
        ? args.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
        : [];
      return {
        ok: true,
        status: "completed",
        mainWorkspaceResult: {
          status: "needs_user_input",
          summary: question,
          artifacts: [],
          observations: [
            typeof args.reason === "string" && args.reason.trim()
              ? `Need user input: ${args.reason.trim()}`
              : "Need user input before continuing."
          ],
          errors: [],
          suggestedNextSteps: choices
        },
        terminalAssistantMessage: question,
        result: {
          type: "needs_user_input",
          workspaceId: activeWorkspaceId,
          question,
          reason: typeof args.reason === "string" ? args.reason : "",
          choices
        }
      };
    }

    if (toolName === "finishTask") {
      if (activeWorkspaceId !== "main") {
        return {
          ok: false,
          status: "failed",
          result: { error: "finishTask can only be called from main workspace. Child workspaces must exit to main before a user-facing final answer." }
        };
      }
      const args = safeJson(argumentsJson) as { summary?: unknown; response?: unknown; nextSteps?: unknown };
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) {
        return {
          ok: false,
          status: "failed",
          result: { error: "finishTask requires summary." }
        };
      }
      const nextSteps = Array.isArray(args.nextSteps)
        ? args.nextSteps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
        : [];
      return {
        ok: true,
        status: "completed",
        mainWorkspaceResult: {
          status: "completed",
          summary,
          artifacts: [],
          observations: [
            typeof args.response === "string" && args.response.trim()
              ? `Final response prepared: ${args.response.trim()}`
              : "Final response is ready."
          ],
          errors: [],
          suggestedNextSteps: nextSteps
        },
        terminalAssistantMessage: typeof args.response === "string" && args.response.trim() ? args.response.trim() : summary,
        result: {
          type: "final_response_ready",
          workspaceId: activeWorkspaceId,
          summary,
          response: typeof args.response === "string" ? args.response : "",
          nextSteps
        }
      };
    }

    return {
      ok: false,
      status: "failed",
      result: {
        error: "Runtime tool binding exists, but this runtime has no executor for the tool.",
        toolName
      }
    };
  }

  private isToolVisibleInWorkspace(toolName: string, workspaceId: string): boolean {
    if (this.mainOnlyToolNames.has(toolName)) return workspaceId === "main";
    if (toolName === "exitWorkspace") return workspaceId !== "main";
    return true;
  }

  private devWorkspaceRoot(): string | undefined {
    const value = this.repos.getRuntimeConfigValues()["tools.devWorkspaceRoot"];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private hasApprovedRequest(input: { run: AgentRunInput; workspaceId: string; toolName: string; argumentsJson: string }): boolean {
    return this.repos.listApprovalRequests({
      conversationId: input.run.conversationId,
      userId: input.run.userId,
      status: "approved",
      limit: 200
    }).some((request) => (
      request.workspaceId === input.workspaceId
      && request.toolName === input.toolName
      && request.argumentsJson === input.argumentsJson
    ));
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

const WORKSPACE_RESULT_STATUSES: WorkspaceStatus[] = ["completed", "failed", "blocked", "needs_user_input", "needs_approval"];

function validateWorkspaceResult(args: Partial<WorkspaceResult>): string | undefined {
  if (!args.status || !WORKSPACE_RESULT_STATUSES.includes(args.status)) {
    return "exitWorkspace requires a valid WorkspaceResult.status.";
  }
  if (!args.summary || typeof args.summary !== "string") {
    return "exitWorkspace requires a WorkspaceResult.summary.";
  }
  if (!Array.isArray(args.artifacts) || !args.artifacts.every(isArtifact)) {
    return "exitWorkspace requires WorkspaceResult.artifacts as an array of { kind, ref, description? }.";
  }
  if (!isStringArray(args.observations)) {
    return "exitWorkspace requires WorkspaceResult.observations as a string array.";
  }
  if (!isStringArray(args.errors)) {
    return "exitWorkspace requires WorkspaceResult.errors as a string array.";
  }
  if (!isStringArray(args.suggestedNextSteps)) {
    return "exitWorkspace requires WorkspaceResult.suggestedNextSteps as a string array.";
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArtifact(value: unknown): value is WorkspaceResult["artifacts"][number] {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Record<string, unknown>;
  return typeof artifact.kind === "string"
    && typeof artifact.ref === "string"
    && (artifact.description === undefined || typeof artifact.description === "string");
}

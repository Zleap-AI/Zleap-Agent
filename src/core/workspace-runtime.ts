import type { AgentRunInput, MemoryRow, WorkspaceDefinition, WorkspaceLocalContext, WorkspaceResult, WorkspaceSession, WorkspaceTask } from "../types";
import { createId, nowIso } from "./id";
import { Repositories } from "../db/repositories";

export class WorkspaceRuntime {
  private readonly universalRuntimeMemoryToolNames = new Set([
    "searchMemory",
    "writeUserImpression",
    "writeAgentSelfImpression",
    "writeEventMemory",
    "writeSkillMemory",
    "updateMemory",
    "deleteMemory"
  ]);
  private readonly mainOnlyToolNames = new Set(["enterWorkspace", "askUser", "finishTask"]);

  constructor(private readonly repos: Repositories) {}

  run(input: { run: AgentRunInput; workspaceId: string; objective: string }): WorkspaceSession {
    const workspace = this.repos.getWorkspace(input.workspaceId);
    const startedAt = nowIso();
    this.repos.audit(input.run.userId, input.run.userRole, "hook.beforeWorkspaceEnter", "workspace", workspace.id, {
      hook: "beforeWorkspaceEnter",
      conversationId: input.run.conversationId,
      workspaceId: workspace.id,
      objective: input.objective
    });
    const task = this.createTask(input.run, workspace.id, input.objective);
    const localContext = this.createLocalContext(input.run, workspace, task);
    this.repos.audit(input.run.userId, input.run.userRole, "hook.afterWorkspaceEnter", "workspace", workspace.id, {
      hook: "afterWorkspaceEnter",
      conversationId: input.run.conversationId,
      workspaceId: workspace.id,
      taskId: task.taskId,
      recalledEventCount: localContext.recalledEventMemories.length,
      recalledSkillCount: localContext.recalledSkillMemories.length,
      recentToolCallCount: localContext.recentToolCalls.length
    });
    const result = this.createResult(task, localContext);
    const session: WorkspaceSession = {
      id: createId("wss"),
      conversationId: input.run.conversationId,
      userId: input.run.userId,
      workspaceId: workspace.id,
      taskId: task.taskId,
      status: result.status,
      objective: input.objective,
      summary: result.summary,
      task,
      result,
      localContext,
      observations: result.observations,
      errors: result.errors,
      startedAt
    };
    this.repos.saveWorkspaceSession(session);
    return session;
  }

  private createTask(run: AgentRunInput, workspaceId: string, objective: string): WorkspaceTask {
    const constraints = workspaceId === "main"
      ? ["只编排 workspace，不直接使用子 workspace 底层工具。"]
      : ["只使用当前 workspace 注册的工具。", "将结果以 WorkspaceResult 结构返回给 main workspace。"];
    return {
      taskId: createId("task"),
      userId: run.userId,
      conversationId: run.conversationId,
      workspaceId,
      objective,
      constraints,
      relevantUserRequest: run.message,
      expectedOutput: workspaceId === "main"
        ? "选择合适 workspace，或直接给出最终回答。"
        : "返回结构化 WorkspaceResult，包括 summary、observations、errors 和 suggestedNextSteps。",
      parentContextSummary: workspaceId === "main"
        ? "用户消息进入主工作空间。"
        : "主工作空间根据用户请求选择该子工作空间。"
    };
  }

  private createLocalContext(run: AgentRunInput, workspace: WorkspaceDefinition, task: WorkspaceTask): WorkspaceLocalContext {
    const recalled = this.applyWorkspaceMemoryPolicy(workspace, this.repos.recallMemories({
      userId: run.userId,
      agentId: run.agentId,
      workspaceId: workspace.id,
      query: `${task.objective}\n${task.relevantUserRequest}`,
      eventLimit: workspace.memoryPolicy.eventRecallEnabled ? workspace.memoryPolicy.maxEventMemories : 0,
      skillLimit: workspace.memoryPolicy.skillRecallEnabled ? workspace.memoryPolicy.maxSkillMemories : 0
    }));
    const availableTools = this.visibleToolDefinitions(workspace);
    return {
      workspaceManifest: workspace.manifest,
      memoryPolicy: workspace.memoryPolicy,
      parentContextSummary: task.parentContextSummary,
      recalledImpressions: recalled.filter((memory) => memory.memoryType === "impression"),
      recalledEventMemories: recalled.filter((memory) => memory.memoryType === "event"),
      recalledSkillMemories: recalled.filter((memory) => memory.memoryType === "skill"),
      availableTools: availableTools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel,
        bindingType: tool.bindingType,
        mcpServerId: tool.mcpServerId,
        mcpToolName: tool.mcpToolName
      })),
      recentToolCalls: []
    };
  }

  private visibleToolDefinitions(workspace: WorkspaceDefinition) {
    const toolMap = new Map(
      workspace.tools
        .filter((tool) => this.isToolVisibleInWorkspace(tool.name, workspace.id))
        .map((tool) => [tool.name, tool])
    );
    for (const tool of this.repos.listTools()) {
      const universalMemoryTool = this.universalRuntimeMemoryToolNames.has(tool.name);
      const childExitTool = workspace.id !== "main" && tool.name === "exitWorkspace";
      if ((universalMemoryTool || childExitTool) && !toolMap.has(tool.name)) {
        toolMap.set(tool.name, tool);
      }
    }
    return Array.from(toolMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private isToolVisibleInWorkspace(toolName: string, workspaceId: string): boolean {
    if (this.mainOnlyToolNames.has(toolName)) return workspaceId === "main";
    if (toolName === "exitWorkspace") return workspaceId !== "main";
    return true;
  }

  private applyWorkspaceMemoryPolicy(workspace: WorkspaceDefinition, memories: MemoryRow[]): MemoryRow[] {
    const policy = workspace.memoryPolicy;
    const impressions = memories.filter((memory) => memory.memoryType === "impression");
    const events = policy.eventRecallEnabled
      ? memories.filter((memory) => memory.memoryType === "event").slice(0, Math.max(0, policy.maxEventMemories))
      : [];
    const skills = policy.skillRecallEnabled
      ? memories.filter((memory) => memory.memoryType === "skill").slice(0, Math.max(0, policy.maxSkillMemories))
      : [];
    return [...impressions, ...events, ...skills];
  }

  private createResult(task: WorkspaceTask, localContext: WorkspaceLocalContext): WorkspaceResult {
    const unconnectedToolCount = localContext.availableTools.filter((tool) => tool.bindingType !== "runtime").length;
    return {
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      status: "running",
      summary: task.workspaceId === "main"
        ? `${task.workspaceId} workspace is orchestrating structured task: ${task.objective}`
        : `${task.workspaceId} workspace is running structured task: ${task.objective}`,
      artifacts: [],
      observations: [
        `Workspace ${task.workspaceId} exposes ${localContext.availableTools.length} registered tool(s).`,
        `Runtime recalled ${localContext.recalledEventMemories.length} event memory item(s) and ${localContext.recalledSkillMemories.length} skill memory item(s) for this workspace.`,
        `Workspace local context includes ${localContext.recentToolCalls.length} recent tool call(s).`,
        task.workspaceId === "main"
          ? "Main workspace can integrate child WorkspaceResult objects and decide the next step."
          : "Child workspace keeps detailed evidence in its WorkspaceSession; only exitWorkspace can deliver a final WorkspaceResult back to main."
      ],
      errors: [],
      suggestedNextSteps: task.workspaceId === "main"
        ? ["根据 workspace registry 选择 active workspace。"]
        : [
          "将 workspace result 返回 main workspace，由 main 继续整合。",
          ...(unconnectedToolCount > 0 ? ["部分工具仍是 MCP/placeholder 绑定，真实执行前需要连接 executor。"] : [])
        ]
    };
  }

  selectWorkspace(message: string): string {
    const lower = message.toLowerCase();
    if (/(memory|remember|impression|skill|event|记忆|记住|回忆|经验|总结经验|偏好|以后)/i.test(lower)) return "main";
    if (/(command|terminal|shell|npm|node|test|命令|终端)/i.test(lower)) return "cli";
    if (/(file|code|search|read|write|文件|代码|搜索)/i.test(lower)) return "file";
    return "main";
  }
}

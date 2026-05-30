import type { MemoryRow, PolicyDecision, ToolDefinition, UserRole, WorkspaceDefinition } from "../types";

export class PolicyEngine {
  canEnterWorkspace(input: { role: UserRole; workspace: WorkspaceDefinition }): PolicyDecision {
    if (input.workspace.id === "main") return { allowed: true };
    if ((input.workspace.requiresApproval || input.workspace.riskLevel === "high") && input.role !== "creator") {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `Entering workspace ${input.workspace.id} requires creator approval.`
      };
    }
    return { allowed: true };
  }

  canUseTool(input: { role: UserRole; tool: ToolDefinition; registeredToActiveWorkspace?: boolean; runtimeTool?: boolean }): PolicyDecision {
    if (!input.registeredToActiveWorkspace && !input.runtimeTool) {
      return {
        allowed: false,
        reason: "Tool is not available in the active workspace."
      };
    }
    if (input.tool.riskLevel === "high" && input.role !== "creator") {
      return {
        allowed: false,
        requiresApproval: true,
        reason: "High-risk tools require creator approval."
      };
    }
    return { allowed: true };
  }

  canWriteMemory(input: { role: UserRole; userId: string; memory: Partial<MemoryRow> & Pick<MemoryRow, "memoryType"> }): PolicyDecision {
    if (input.memory.memoryType === "impression") {
      if (input.memory.workspaceId) return { allowed: false, reason: "Impression memory is cross-workspace and must not set workspaceId." };
      if (input.memory.userId && input.memory.agentId) return { allowed: false, reason: "Impression memory must target either a user or agent self, not both." };
      if (!input.memory.userId && !input.memory.agentId) return { allowed: false, reason: "Impression memory requires userId or agentId." };
      if (input.memory.agentId && input.role !== "creator") {
        return { allowed: false, reason: "Agent self impression requires creator role." };
      }
      if (input.memory.userId && input.role !== "creator" && input.memory.userId !== input.userId) {
        return { allowed: false, reason: "User impression can only be written for the current user." };
      }
    }
    if (input.memory.memoryType === "event" && (!input.memory.userId || !input.memory.workspaceId)) {
      return { allowed: false, reason: "Event memory requires userId and workspaceId." };
    }
    if (input.memory.memoryType === "event" && input.role !== "creator" && input.memory.userId !== input.userId) {
      return { allowed: false, reason: "Event memory can only be written for the current user." };
    }
    if (input.memory.memoryType === "skill" && (!input.memory.workspaceId || input.memory.userId)) {
      return { allowed: false, reason: "Skill memory must be workspace-scoped and user-shared." };
    }
    return { allowed: true };
  }
}

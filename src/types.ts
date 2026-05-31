export type UserRole = "user" | "creator";
export type ActorRole = UserRole | "system" | "agent";

export type MemoryType = "impression" | "event" | "skill";

export type WorkspaceStatus = "running" | "completed" | "failed" | "blocked" | "needs_user_input" | "needs_approval";

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
};

export type ApprovalRequest = {
  id: string;
  userId: string;
  conversationId?: string;
  workspaceId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
  metadataJson: string;
};

export type AgentConfig = {
  id: string;
  name: string;
  systemPrompt: string;
  personalityPrompt: string;
  defaultModel: string;
  defaultBaseUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunInput = {
  agentId: string;
  userId: string;
  userRole: UserRole;
  conversationId: string;
  message: string;
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
  };
};

export type AgentRunOutput = {
  conversationId: string;
  assistantMessage: string;
  activeWorkspaceId: string;
  workspaceTrace: WorkspaceSession[];
  contextSegments: ContextSegment[];
  finalMessages: LLMMessage[];
  memoryWrites: MemoryRow[];
};

export type AgentRunPrepared = Omit<AgentRunOutput, "assistantMessage"> & {
  assistantMessage?: string;
  llmCallId: string;
  callableTools: ToolDefinition[];
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature?: number;
  };
};

export type WorkspaceProcessItem = {
  toolName: string;
  summary: string;
  argumentsJson?: string;
  resultJson?: string;
  status?: string;
};

export type AgentStreamEvent =
  | { type: "start"; output: Omit<AgentRunOutput, "assistantMessage"> }
  | { type: "delta"; text: string }
  | {
      type: "workspace";
      workspaceId: string;
      eventKind: "entered" | "assistant" | "tool_call" | "tool_result" | "exit";
      title: string;
      text: string;
      llmCallId?: string;
      status?: WorkspaceStatus;
      toolNames?: string[];
      items?: WorkspaceProcessItem[];
    }
  | { type: "done"; output: AgentRunOutput }
  | { type: "error"; error: string };

export type WorkspaceMemoryPolicy = {
  eventRecallEnabled: boolean;
  skillRecallEnabled: boolean;
  eventWriteEnabled: boolean;
  skillWriteEnabled: boolean;
  maxEventMemories: number;
  maxSkillMemories: number;
};

export type WorkspaceManifest = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  inputKinds: string[];
  outputKinds: string[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
};

export type WorkspaceDefinition = {
  id: string;
  name: string;
  description: string;
  capabilitiesJson: string;
  inputKindsJson: string;
  outputKindsJson: string;
  requiresApproval: number;
  instructions: string;
  toolInstructions: string;
  memoryPolicyJson: string;
  riskLevel: "low" | "medium" | "high";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  manifest: WorkspaceManifest;
  memoryPolicy: WorkspaceMemoryPolicy;
  tools: ToolDefinition[];
};

export type McpTransport = "stdio" | "streamable-http";

export type McpServerDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  argsJson: string;
  envJson: string;
  cwd?: string;
  url?: string;
  headersJson: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

export type ToolDefinition = {
  id: string;
  name: string;
  workspaceId?: string;
  description: string;
  parametersJson: string;
  riskLevel: "low" | "medium" | "high";
  bindingType: "placeholder" | "runtime" | "mcp";
  bindingJson: string;
  mcpServerId?: string;
  mcpToolName?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceTask = {
  taskId: string;
  userId: string;
  conversationId: string;
  workspaceId: string;
  objective: string;
  constraints: string[];
  relevantUserRequest: string;
  expectedOutput: string;
  parentContextSummary: string;
};

export type WorkspaceResult = {
  taskId: string;
  workspaceId: string;
  status: WorkspaceStatus;
  summary: string;
  artifacts: Array<{
    kind: string;
    ref: string;
    description?: string;
  }>;
  observations: string[];
  errors: string[];
  suggestedNextSteps: string[];
};

export type WorkspaceLocalContext = {
  workspaceManifest: WorkspaceManifest;
  memoryPolicy: WorkspaceMemoryPolicy;
  parentContextSummary: string;
  recalledImpressions: MemoryRow[];
  recalledEventMemories: MemoryRow[];
  recalledSkillMemories: MemoryRow[];
  availableTools: Array<{
    id: string;
    name: string;
    description: string;
    riskLevel: ToolDefinition["riskLevel"];
    bindingType: ToolDefinition["bindingType"];
    mcpServerId?: string;
    mcpToolName?: string;
  }>;
  recentToolCalls: ToolCallLog[];
};

export type WorkspaceSession = {
  id: string;
  conversationId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  status: WorkspaceStatus;
  objective: string;
  summary: string;
  task: WorkspaceTask;
  result: WorkspaceResult;
  localContext: WorkspaceLocalContext;
  observations: string[];
  errors: string[];
  startedAt: string;
  completedAt?: string;
};

export type ContextSegment = {
  id: string;
  llmCallId: string;
  conversationId: string;
  segmentType:
    | "system"
    | "personality"
    | "policy"
    | "workspace"
    | "workspace_registry"
    | "task"
    | "workspace_result"
    | "workspace_local_context"
    | "tools"
    | "memory"
    | "impression_memory"
    | "event_memory"
    | "skill_memory"
    | "history"
    | "user"
    | "tool_result"
    | "final_messages";
  title: string;
  content: string;
  tokenEstimate: number;
  sortOrder: number;
};

export type LLMCallSnapshot = {
  id: string;
  conversationId: string;
  userId: string;
  providerBaseUrl: string;
  normalizedEndpoint: string;
  model: string;
  messagesJson: string;
  toolsJson: string;
  status: "pending" | "completed" | "failed";
  responseJson: string;
  errorText?: string;
  createdAt: string;
  completedAt?: string;
};

export type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type MemoryRow = {
  id: string;
  memoryType: MemoryType;
  userId?: string;
  agentId?: string;
  workspaceId?: string;
  relationId?: string;
  version: number;
  title: string;
  summary: string;
  detail: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  rawJson: string;
  createdAt: string;
};

export type ToolCallLog = {
  id: string;
  conversationId: string;
  userId: string;
  workspaceId: string;
  workspaceSessionId?: string;
  taskId?: string;
  toolName: string;
  argumentsJson: string;
  resultJson: string;
  status: "completed" | "failed" | "blocked";
  createdAt: string;
};

export type AuditLog = {
  id: string;
  actorId?: string;
  actorRole: ActorRole;
  action: string;
  resourceKind: string;
  resourceId?: string;
  workspaceId?: string;
  conversationId?: string;
  createdAt: string;
  metadataJson: string;
};

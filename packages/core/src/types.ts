export type RunStatus =
  | 'created'
  | 'session_assembling'
  | 'planning'
  | 'working'
  | 'integrating'
  | 'delivering'
  | 'idle'
  | 'completed'
  | 'aborted'
  | 'failed';

export type WorkStatus =
  | 'created'
  | 'queued'
  | 'loading'
  | 'active'
  | 'producing'
  | 'curating'
  | 'exited'
  | 'suspended'
  | 'failed'
  | 'aborted';

export type WorkStepStatus =
  | 'loading'
  | 'active'
  | 'producing'
  | 'curating'
  | 'exited'
  | 'failed'
  | 'aborted';

export type Artifact = {
  id: string;
  workspaceId: string;
  title: string;
  summary: string;
  data?: unknown;
  createdAt: Date;
};

export type WorkspaceResultStatus = 'completed' | 'failed' | 'blocked' | 'needs_user_input' | 'needs_approval';

export type WorkspaceResultArtifact = {
  kind: string;
  ref: string;
  description?: string;
};

export type WorkspaceHandoffRequest = {
  space: string;
  task: string;
  context?: string;
  reason?: string;
};

export type WorkspaceResult = {
  status: WorkspaceResultStatus;
  summary: string;
  artifacts: WorkspaceResultArtifact[];
  observations: string[];
  errors: string[];
  suggestedNextSteps: string[];
  handoffs?: WorkspaceHandoffRequest[];
};

export type ToolCall = {
  id: string;
  toolId: string;
  input: unknown;
  /** Model- or runtime-supplied rationale for why this tool call is needed. */
  reason?: string;
  startedAt: Date;
  endedAt?: Date;
  result?: unknown;
  error?: AgentError;
  hookFailures?: ToolHookFailure[];
};

export type ToolHookFailure = {
  phase: 'afterToolCall';
  message: string;
  code?: string;
  occurredAt: Date;
};

export type ToolArgumentPreparer = (input: unknown, context: ToolExecutionContext, signal: AbortSignal) => unknown | Promise<unknown>;

export type ToolHandler = (input: unknown, context: ToolExecutionContext, signal: AbortSignal) => Promise<unknown>;

export type ToolExecutionMode = 'sequential' | 'parallel';

export type ToolRecoveryAutofill = 'reason' | 'path';

export type ToolRecoveryPolicy = {
  /** Fields this specific tool allows runtime to fill deterministically. */
  autofill?: readonly ToolRecoveryAutofill[];
};

export type RuntimeCacheKind =
  | 'search_result'
  | 'webpage'
  | 'file_output'
  | 'workspace_result'
  | 'tool_result'
  | 'note';

export type ToolCacheCaptureMode = 'auto' | 'none';

export type ToolCacheCapability = {
  /** Whether runtime should save successful results from this tool into temporary workspace Cache. */
  produces?: boolean;
  /** Semantic type(s) for the captured result, used for display and ranking. */
  kinds?: readonly RuntimeCacheKind[];
  /** Internal capture mode. `auto` means runtime captures after successful execution. */
  capture?: ToolCacheCaptureMode;
  /** Optional character cap for persisted cache content. */
  maxContentChars?: number;
};

export type ToolDescriber = (context: ToolExecutionContext) => Partial<ToolDescriptor>;

export type ToolDefinition = {
  id: string;
  description?: string;
  parameters?: unknown;
  /** Build context-sensitive model-visible schema/guidance at tool mount time. */
  describe?: ToolDescriber;
  /**
   * Prompt-only usage hint injected into the workspace system prompt. It is not
   * copied into provider tool schemas. Set to false to keep a callable tool out
   * of the prompt guidance block.
   */
  promptSnippet?: string | false;
  /** Prompt-only usage rules for this tool; not copied into provider schemas. */
  promptGuidelines?: readonly string[];
  /** Normalize raw model arguments before hooks, rationale checks, and handler execution. */
  prepareArguments?: ToolArgumentPreparer;
  /** Scheduling hint for future batched execution. Defaults to sequential. */
  executionMode?: ToolExecutionMode;
  /** Require callers to provide a non-empty `reason` argument before execution. */
  requiresReason?: boolean;
  /** Internal-only recovery policy; never copied into model-visible schemas. */
  recovery?: ToolRecoveryPolicy;
  /** Runtime-owned cache capture metadata; not a model-visible argument. */
  cache?: ToolCacheCapability;
  handler: ToolHandler;
};

export type ToolDescriptor = Pick<
  ToolDefinition,
  'id' | 'description' | 'parameters' | 'promptSnippet' | 'promptGuidelines' | 'executionMode' | 'recovery' | 'cache'
>;

export type ToolExecutionContext = {
  runId: string;
  workId: string;
  stepId: string;
  workspaceId: string;
  /** Filesystem root for tools in this run. Defaults to the process cwd when omitted. */
  workspaceRoot?: string;
};

export type ToolCaller = (toolId: string, input: unknown) => Promise<unknown>;

export type SkillDefinition = {
  id: string;
  version?: number;
  procedureId?: string;
  label: string;
  description?: string;
  instructions?: string;
  toolIds: string[];
  sections?: SkillSectionIndex[];
  lifecycle?: 'long_term' | 'per_turn';
  tokenBudget?: number;
  sensitivity?: SkillSensitivityAudit;
  source?: SkillPackageSource;
  frontmatter?: SkillFrontmatter;
  body?: string;
  files?: SkillPackageFile[];
  openaiConfig?: Record<string, unknown>;
  claudeConfig?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  invocationPolicy?: SkillInvocationPolicy;
  trustStatus?: SkillTrustStatus;
  riskAudit?: SkillRiskAudit;
  schemaHash?: string;
};

export type SkillSectionIndex = {
  id: string;
  title: string;
  level: number;
};

export type SkillSourceType = 'db' | 'project' | 'user' | 'admin' | 'system' | 'imported';

export type SkillInvocationPolicy = 'implicit' | 'explicit_only' | 'disabled';

export type SkillTrustStatus = 'trusted' | 'review_required' | 'blocked';

export type SkillPackageSource = {
  type: SkillSourceType;
  sourcePath?: string;
  packageRoot?: string;
  sourceName?: string;
};

export type SkillFrontmatter = Record<string, unknown> & {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: unknown;
  metadata?: Record<string, unknown>;
};

export type SkillPackageFileKind = 'skill' | 'script' | 'reference' | 'asset' | 'config' | 'other';

export type SkillPackageFile = {
  path: string;
  kind: SkillPackageFileKind;
  size: number;
  sha256?: string;
  mime?: string;
  executable?: boolean;
};

export type SkillSensitivityFinding = {
  kind: 'secret_like' | 'private_key' | 'credential_url';
  severity: 'medium' | 'high';
  count: number;
};

export type SkillSensitivityAudit = {
  status: 'clear' | 'review';
  findings: SkillSensitivityFinding[];
};

export type SkillRiskFindingKind =
  | SkillSensitivityFinding['kind']
  | 'shell_preprocessing'
  | 'executable_script'
  | 'network_reference'
  | 'path_escape'
  | 'large_file';

export type SkillRiskFinding = {
  kind: SkillRiskFindingKind;
  severity: 'low' | 'medium' | 'high';
  count: number;
  message?: string;
};

export type SkillRiskAudit = {
  status: SkillTrustStatus;
  findings: SkillRiskFinding[];
};

export type AgentAvatar = {
  name: string;
  description?: string;
  tone?: string;
  icon?: string;
};

export type AgentModelBinding = {
  providerId?: string;
  model?: string;
  config?: Record<string, unknown>;
};

export type AgentDefinition = {
  id: string;
  label: string;
  description?: string;
  avatar?: AgentAvatar;
  instructions?: string;
  model?: AgentModelBinding;
  defaultSpaces: string[];
  defaultSkillIds?: string[];
  defaultToolIds?: string[];
  defaultMemory?: MemoryPersistencePolicy;
  metadata?: Record<string, unknown>;
};

export type AgentRunRequest = {
  agentId: string;
  goal: string;
  context?: unknown;
  session?: AgentRunSessionRequest;
  spaces?: string[];
  skillIds?: string[];
  toolIds?: string[];
  instructions?: string;
  memory?: MemoryPersistencePolicy;
};

export type SessionKind = 'main' | 'sub';

export type SessionTrigger = 'user' | 'schedule' | 'api' | 'system';

export type SessionStatus = 'active' | 'archived';

export type Session = {
  id: string;
  agentId?: string;
  kind: SessionKind;
  trigger: SessionTrigger;
  title?: string;
  parentSessionId?: string;
  runIds: string[];
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
};

export type SessionBinding = {
  id: string;
  kind: SessionKind;
  trigger: SessionTrigger;
  parentSessionId?: string;
};

export type MemoryScope = 'session' | 'agent';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  artifactId?: string;
  title: string;
  summary: string;
  data?: unknown;
  tags: string[];
  createdAt: Date;
};

export type MemoryQuery = {
  scope?: MemoryScope;
  agentId?: string;
  sessionId?: string;
  tags?: string[];
  text?: string;
  limit?: number;
};

export type MemoryPersistencePolicy = {
  scopes: MemoryScope[];
  tags?: string[];
};

export type MemoryReader = (query: MemoryQuery) => MemoryRecord[];

export type SkillManifestSearcher = (input: { query: string; limit?: number }) => Promise<SkillDefinition[]> | SkillDefinition[];

/**
 * Best-effort async write-through sink for durable runtime storage. Long-term
 * memory is intentionally excluded; it must flow through MemoryService.
 */
export type RuntimePersistence = {
  saveSession?: (session: Session) => void | Promise<void>;
  touchSession?: (sessionId: string, runId: string, updatedAt: Date) => void | Promise<void>;
};

export type RuntimePersistenceOperation = keyof RuntimePersistence;

export type RuntimePersistenceFailure = {
  operation: RuntimePersistenceOperation;
  message: string;
  code?: string;
  occurredAt: Date;
};

export type RuntimePersistenceFailureHandler = (failure: RuntimePersistenceFailure) => void;

export type CreateSessionRequest = {
  id?: string;
  agentId?: string;
  kind: SessionKind;
  trigger: SessionTrigger;
  title?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRunSessionRequest = {
  sessionId?: string;
  kind?: SessionKind;
  trigger?: SessionTrigger;
  title?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRunContext = {
  id: string;
  label: string;
  avatar?: AgentAvatar;
  instructions?: string;
  model?: AgentModelBinding;
};

/**
 * A live progress signal a workspace handler streams out while it works. The
 * runtime tags it with run/work/step/workspace ids and republishes it on the
 * event bus as a `workspace_delta` event, so surfaces (CLI/web) render text and
 * tool activity without the handler knowing about any UI.
 */
export type ProviderUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ProviderToolCallSummary = {
  id: string;
  name: string;
  argumentType: string;
  rawArgumentLength?: number;
  rawArgumentPreview?: string;
  rawArgumentTail?: string;
  argumentsParseError?: string;
};

export type RuntimeErrorCauseSummary = {
  name?: string;
  code?: string;
  message: string;
  details?: Record<string, string | number | boolean>;
  cause?: RuntimeErrorCauseSummary;
};

export type RuntimeErrorSummary = {
  code?: string;
  message: string;
  cause?: RuntimeErrorCauseSummary;
};

export type LifecycleHookFailureSummary = {
  phase: string;
  message: string;
  code?: string;
  occurredAt: Date;
};

export type ProviderLifecycleDelta = {
  kind: 'provider_lifecycle';
  phase: 'request' | 'response';
  requestId: string;
  modelId: string;
  status: 'started' | 'completed' | 'failed';
  messageCount?: number;
  toolCount?: number;
  cacheBreakpointCount?: number;
  finishReason?: string;
  textLength?: number;
  toolCallCount?: number;
  toolCalls?: ProviderToolCallSummary[];
  usage?: ProviderUsageSummary;
  error?: RuntimeErrorSummary;
  hookFailures?: LifecycleHookFailureSummary[];
};

export type TurnLifecycleDelta = {
  kind: 'turn_lifecycle';
  phase: 'start' | 'end';
  turnId: string;
  modelId: string;
  status: 'started' | 'completed' | 'continued' | 'blocked' | 'failed';
  messageCount?: number;
  toolCount?: number;
  cacheBreakpointCount?: number;
  finishReason?: string;
  textLength?: number;
  toolCallCount?: number;
  toolResultCount?: number;
  workspaceResultStatus?: WorkspaceResultStatus;
  outcome?: 'final_response' | 'tool_results' | 'workspace_result' | 'continue_nudge' | 'missing_exit' | 'tool_limit' | 'provider_error' | 'lifecycle_hook_error';
  error?: RuntimeErrorSummary;
  hookFailures?: LifecycleHookFailureSummary[];
};

export type WorkspaceDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; phase: 'start' | 'end'; detail: string; isError?: boolean; toolCallId?: string }
  | { kind: 'approval'; status: 'needs_approval' | 'approved'; approvalId: string; name: string; args: string; preview?: string; message: string }
  | ProviderLifecycleDelta
  | TurnLifecycleDelta;

export type WorkspaceEmitter = (delta: WorkspaceDelta) => void;

export type WorkContext = {
  agent?: AgentRunContext;
  session?: SessionBinding;
  goal: string;
  /** Filesystem root bound to this run/workspace. Tools must resolve paths under this root. */
  workspaceRoot?: string;
  input?: unknown;
  priorArtifacts: Artifact[];
  skills: SkillDefinition[];
  availableTools: ToolDescriptor[];
  searchSkills?: SkillManifestSearcher;
  queryMemory: MemoryReader;
  callTool: ToolCaller;
  /** Stream live text/tool progress out of the handler (no-op if unobserved). */
  emit: WorkspaceEmitter;
};

export type WorkSpaceHandler = (context: WorkContext, signal: AbortSignal) => Promise<Omit<Artifact, 'id' | 'workspaceId' | 'createdAt'>>;

export type WorkSpaceDefinition = {
  id: string;
  label: string;
  description?: string;
  handler: WorkSpaceHandler;
};

export type WorkRequest = {
  spaces: string[];
  goal: string;
  /** Filesystem root for this run. Surfaces set this from the selected project/conversation. */
  workspaceRoot?: string;
  context?: unknown;
  agent?: AgentRunContext;
  session?: SessionBinding;
  skillIds?: string[];
  skills?: SkillDefinition[];
  searchSkills?: SkillManifestSearcher;
  toolIds?: string[];
  memory?: MemoryPersistencePolicy;
};

export type RunHookContext = {
  run: Run;
  request: WorkRequest;
};

export type WorkHookContext = {
  run: Run;
  work: Work;
  request: WorkRequest;
};

export type ArtifactHookContext = {
  run: Run;
  work: Work;
  step: WorkStep;
  artifact: Artifact;
  request: WorkRequest;
};

export type SpaceHookContext = {
  run: Run;
  work: Work;
  step: WorkStep;
  request: WorkRequest;
};

export type ToolHookContext = {
  run: Run;
  work: Work;
  step: WorkStep;
  call: ToolCall;
  tool: ToolDefinition;
  execution: ToolExecutionContext;
  request: WorkRequest;
};

export type SessionHookContext = {
  run: Run;
  request: WorkRequest;
  session: SessionBinding;
  updatedAt: Date;
};

export type AgentRuntimeHook = {
  beforeRun?: (context: RunHookContext) => void | Promise<void>;
  afterRun?: (context: RunHookContext) => void | Promise<void>;
  beforeWork?: (context: WorkHookContext) => void | Promise<void>;
  afterWork?: (context: WorkHookContext) => void | Promise<void>;
  beforeSpace?: (context: SpaceHookContext) => void | Promise<void>;
  afterSpace?: (context: SpaceHookContext) => void | Promise<void>;
  beforeToolCall?: (context: ToolHookContext) => void | Promise<void>;
  afterToolCall?: (context: ToolHookContext) => void | Promise<void>;
  afterArtifact?: (context: ArtifactHookContext) => void | Promise<void>;
  afterSessionTouch?: (context: SessionHookContext) => void | Promise<void>;
};

export type TraceRecordKind =
  | 'run'
  | 'work'
  | 'step'
  | 'artifact'
  | 'tool_call'
  | 'event'
  | 'error';

export type TraceRecord = {
  id: string;
  kind: TraceRecordKind;
  runId: string;
  workId?: string;
  stepId?: string;
  toolCallId?: string;
  artifactId?: string;
  type?: AgentEvent['type'];
  status?: RunStatus | WorkStatus | WorkStepStatus;
  title?: string;
  summary?: string;
  data?: unknown;
  createdAt: Date;
};

export type TraceQuery = {
  runId?: string;
  workId?: string;
  stepId?: string;
  kind?: TraceRecordKind;
  type?: AgentEvent['type'];
  limit?: number;
};

export type WorkStep = {
  id: string;
  workId: string;
  workspaceId: string;
  status: WorkStepStatus;
  startedAt?: Date;
  endedAt?: Date;
  artifact?: Artifact;
  toolCalls: ToolCall[];
  error?: AgentError;
  hookFailures?: LifecycleHookFailureSummary[];
};

export type Work = {
  id: string;
  agentId?: string;
  session?: SessionBinding;
  goal: string;
  spaces: string[];
  skillIds: string[];
  toolIds: string[];
  status: WorkStatus;
  steps: WorkStep[];
  artifacts: Artifact[];
  startedAt: Date;
  endedAt?: Date;
  error?: AgentError;
};

export type Run = {
  id: string;
  agentId?: string;
  session?: SessionBinding;
  status: RunStatus;
  goal: string;
  works: Work[];
  artifacts: Artifact[];
  startedAt: Date;
  endedAt?: Date;
  error?: AgentError;
  metadata?: Record<string, unknown>;
};

export type AgentErrorCode =
  | 'agent_not_found'
  | 'gateway_not_found'
  | 'agent_not_configured'
  | 'schedule_not_found'
  | 'workspace_not_found'
  | 'skill_not_found'
  | 'tool_not_found'
  | 'tool_not_allowed'
  | 'tool_reason_required'
  | 'empty_work_spaces'
  | 'work_aborted'
  | 'tool_failed'
  | 'workspace_failed';

export type AgentError = {
  code: AgentErrorCode;
  message: string;
  cause?: unknown;
};

export type AgentEvent =
  | { type: 'agent_start'; run: Run }
  | { type: 'agent_end'; run: Run }
  | { type: 'run_status'; runId: string; status: RunStatus }
  | { type: 'work_status'; runId: string; workId: string; status: WorkStatus }
  | { type: 'work_step_status'; runId: string; workId: string; stepId: string; workspaceId: string; status: WorkStepStatus }
  | { type: 'before_work'; runId: string; work: Work }
  | { type: 'after_work'; runId: string; work: Work }
  | { type: 'space_enter'; runId: string; workId: string; step: WorkStep }
  | { type: 'space_exit'; runId: string; workId: string; step: WorkStep }
  | { type: 'workspace_delta'; runId: string; workId: string; stepId: string; workspaceId: string; delta: WorkspaceDelta }
  | { type: 'artifact_produced'; runId: string; workId: string; stepId: string; artifact: Artifact }
  | { type: 'tool_execution_start'; runId: string; workId: string; stepId: string; call: ToolCall }
  | { type: 'tool_execution_end'; runId: string; workId: string; stepId: string; call: ToolCall }
  | { type: 'error'; runId: string; error: AgentError };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

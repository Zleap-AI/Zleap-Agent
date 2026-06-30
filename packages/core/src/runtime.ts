import { randomUUID } from 'node:crypto';
import { AgentRegistry } from './agents.js';
import { AgentEventBus } from './events.js';
import { AgentHookRegistry } from './hooks.js';
import { MemoryRegistry } from './memory.js';
import { SessionRegistry } from './sessions.js';
import { SkillRegistry } from './skills.js';
import {
  formatMalformedJsonArguments,
  formatToolArgumentShapeIssues,
  looksLikeMalformedJsonArguments,
  recoverToolArgumentShape,
  validateToolArgumentShape,
} from './toolRecovery.js';
import { ToolRegistry } from './tools.js';
import { TraceStore } from './traces.js';
import { WorkSpaceRegistry } from './workspace.js';
import type {
  AgentError,
  AgentEvent,
  AgentEventHandler,
  AgentDefinition,
  AgentRuntimeHook,
  AgentRunContext,
  AgentRunRequest,
  AgentRunSessionRequest,
  Artifact,
  CreateSessionRequest,
  MemoryPersistencePolicy,
  MemoryQuery,
  MemoryRecord,
  Run,
  RunStatus,
  RuntimePersistence,
  RuntimePersistenceFailureHandler,
  RuntimePersistenceOperation,
  Session,
  SessionBinding,
  SessionTrigger,
  SkillDefinition,
  ToolCall,
  ToolDescriptor,
  ToolDefinition,
  ToolExecutionContext,
  TraceRecord,
  Work,
  WorkRequest,
  WorkStatus,
  WorkStep,
  WorkStepStatus,
  WorkSpaceDefinition,
} from './types.js';

type AgentRuntimeOptions = {
  idFactory?: () => string;
  now?: () => Date;
  /** Optional durable write-through sink (e.g. Postgres). Best-effort. */
  persistence?: RuntimePersistence;
  /** Observes best-effort persistence failures without receiving the original payload. */
  onPersistenceFailure?: RuntimePersistenceFailureHandler;
};

type ToolScope = {
  skills: SkillDefinition[];
  availableTools: ToolDescriptor[];
  allowedToolIds: Set<string>;
};

function createRuntimeId(): string {
  return `id_${randomUUID().replace(/-/g, '')}`;
}

export class AgentRuntime {
  readonly agents = new AgentRegistry();
  readonly events = new AgentEventBus();
  readonly hooks = new AgentHookRegistry();
  /** Legacy in-memory runtime cache for run artifacts; not the primary long-term memory system. */
  readonly memories = new MemoryRegistry();
  readonly sessions = new SessionRegistry();
  readonly skills = new SkillRegistry();
  readonly workspaces = new WorkSpaceRegistry();
  readonly tools = new ToolRegistry();
  readonly traces = new TraceStore();

  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly persistence?: RuntimePersistence;
  private readonly onPersistenceFailure?: RuntimePersistenceFailureHandler;

  constructor(options: AgentRuntimeOptions = {}) {
    this.idFactory = options.idFactory ?? createRuntimeId;
    this.now = options.now ?? (() => new Date());
    this.persistence = options.persistence;
    this.onPersistenceFailure = options.onPersistenceFailure;
    this.hooks.register({
      afterRun: ({ run, request }) => {
        if (run.status === 'completed') {
          this.persistRunMemory(run, request.memory);
        }
      },
    });
    this.events.observe((event) => {
      this.recordTrace(event);
    });
  }

  registerWorkspace(definition: WorkSpaceDefinition): void {
    this.workspaces.register(definition);
  }

  registerTool(definition: ToolDefinition): void {
    this.tools.register(definition);
  }

  registerSkill(definition: SkillDefinition): void {
    this.skills.register(definition);
  }

  registerAgent(definition: AgentDefinition): void {
    this.agents.register(definition);
  }

  registerSession(session: Session): void {
    this.sessions.register(session);
  }

  createSession(request: CreateSessionRequest): Session {
    const now = this.now();
    const session: Session = {
      id: request.id ?? this.idFactory(),
      agentId: request.agentId,
      kind: request.kind,
      trigger: request.trigger,
      title: request.title,
      parentSessionId: request.parentSessionId,
      runIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      metadata: request.metadata,
    };
    this.sessions.register(session);
    this.firePersistence('saveSession', () => this.persistence?.saveSession?.(session));
    return session;
  }

  observe(handler: AgentEventHandler): () => void {
    return this.events.observe(handler);
  }

  registerHook(hook: AgentRuntimeHook): () => void {
    return this.hooks.register(hook);
  }

  async runAgent(request: AgentRunRequest, options: { signal?: AbortSignal } = {}): Promise<Run> {
    const agent = this.agents.get(request.agentId);
    if (!agent) {
      return this.createFailedRun({
        agentId: request.agentId,
        goal: request.goal,
        error: errorOf('agent_not_found', `Agent not found: ${request.agentId}`),
      });
    }
    const session = this.resolveRunSession(agent.id, request.session);

    return this.run(
      {
        agent: toAgentRunContext(agent, request.instructions),
        session,
        spaces: request.spaces ?? agent.defaultSpaces,
        goal: request.goal,
        context: request.context,
        skillIds: unique([...(agent.defaultSkillIds ?? []), ...(request.skillIds ?? [])]),
        toolIds: unique([...(agent.defaultToolIds ?? []), ...(request.toolIds ?? [])]),
        memory: request.memory ?? agent.defaultMemory,
      },
      options,
    );
  }

  async run(request: WorkRequest, options: { signal?: AbortSignal } = {}): Promise<Run> {
    const run: Run = {
      id: this.idFactory(),
      agentId: request.agent?.id,
      session: request.session,
      status: 'created',
      goal: request.goal,
      works: [],
      artifacts: [],
      startedAt: this.now(),
    };

    await this.events.emit({ type: 'agent_start', run });

    try {
      await this.hooks.beforeRun({ run, request });
      this.assertNotAborted(options.signal);
      await this.setRunStatus(run, 'session_assembling');
      await this.setRunStatus(run, 'planning');
      await this.setRunStatus(run, 'working');

      const work = await this.work(run, request, options.signal);
      run.artifacts = work.artifacts;

      this.assertNotAborted(options.signal);
      await this.setRunStatus(run, 'integrating');
      await this.setRunStatus(run, 'delivering');
      await this.setRunStatus(run, 'completed');
      run.endedAt = this.now();
    } catch (error) {
      const agentError = toAgentError(error);
      run.error = agentError;
      run.endedAt = this.now();
      await this.setRunStatus(run, agentError.code === 'work_aborted' ? 'aborted' : 'failed');
      await this.events.emit({ type: 'error', runId: run.id, error: agentError });
    } finally {
      await this.hooks.afterRun({ run, request });
      const session = request.session;
      if (session) {
        const updatedAt = this.now();
        this.sessions.appendRun(session.id, run.id, updatedAt);
        this.firePersistence('touchSession', () => this.persistence?.touchSession?.(session.id, run.id, updatedAt));
        try {
          await this.hooks.afterSessionTouch({ run, request, session, updatedAt });
        } catch (hookError) {
          this.recordRunHookFailure(run, 'afterSessionTouch', 'afterSessionTouch hook failed', hookError);
        }
      }
      await this.events.emit({ type: 'agent_end', run });
    }

    return run;
  }

  async work(run: Run, request: WorkRequest, signal?: AbortSignal): Promise<Work> {
    if (request.spaces.length === 0) {
      throw errorOf('empty_work_spaces', 'work(spaces=[...]) requires at least one WorkSpace.');
    }

    const skillIds = requestedSkillIds(request);
    this.resolveSkills(request);
    const work: Work = {
      id: this.idFactory(),
      agentId: request.agent?.id,
      session: request.session,
      goal: request.goal,
      spaces: request.spaces,
      skillIds,
      toolIds: request.toolIds ?? [],
      status: 'created',
      steps: [],
      artifacts: [],
      startedAt: this.now(),
    };
    run.works.push(work);

    await this.updateWork(run.id, work, 'queued');
    await this.events.emit({ type: 'before_work', runId: run.id, work });
    await this.hooks.beforeWork({ run, work, request });

    try {
      let input = request.context;
      for (const workspaceId of request.spaces) {
        this.assertNotAborted(signal);
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace) {
          throw errorOf('workspace_not_found', `WorkSpace not found: ${workspaceId}`);
        }

        const step = await this.runStep(run, request, work, workspace, input, signal);
        if (step.artifact) {
          work.artifacts.push(step.artifact);
          input = step.artifact;
        }
      }

      await this.updateWork(run.id, work, 'exited');
      work.endedAt = this.now();
    } catch (error) {
      const agentError = toAgentError(error);
      work.error = agentError;
      work.endedAt = this.now();
      await this.updateWork(run.id, work, agentError.code === 'work_aborted' ? 'aborted' : 'failed');
      throw agentError;
    } finally {
      await this.hooks.afterWork({ run, work, request });
      await this.events.emit({ type: 'after_work', runId: run.id, work });
    }

    return work;
  }

  private async runStep(
    run: Run,
    request: WorkRequest,
    work: Work,
    workspace: WorkSpaceDefinition,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<WorkStep> {
    const step: WorkStep = {
      id: this.idFactory(),
      workId: work.id,
      workspaceId: workspace.id,
      status: 'loading',
      toolCalls: [],
    };
    work.steps.push(step);
    const executionContext: ToolExecutionContext = {
      runId: run.id,
      workId: work.id,
      stepId: step.id,
      workspaceId: workspace.id,
      workspaceRoot: request.workspaceRoot,
    };
    const toolScope = this.resolveToolScope(request, executionContext);

    await this.updateStep(run.id, work.id, step, 'loading');
    await this.updateStep(run.id, work.id, step, 'active');

    try {
      try {
        await this.hooks.beforeSpace({ run, work, step, request });
      } catch (hookError) {
        this.recordSpaceHookFailure(step, 'beforeSpace', 'beforeSpace hook failed', hookError);
        throw errorOf('workspace_failed', 'beforeSpace hook failed');
      }
      await this.events.emit({ type: 'space_enter', runId: run.id, workId: work.id, step });
      this.assertNotAborted(signal);
      const draft = await workspace.handler(
        {
          agent: request.agent,
          session: request.session,
          goal: work.goal,
          workspaceRoot: request.workspaceRoot,
          input,
          priorArtifacts: work.artifacts,
          skills: toolScope.skills,
          availableTools: toolScope.availableTools,
          searchSkills: request.searchSkills,
          queryMemory: (query) => this.queryMemoryForContext(request.agent, request.session, query),
          // Fire-and-forget: the event bus runs observers synchronously up to
          // their first await, so a cheap observer (queue.push) keeps delta
          // ordering relative to the awaited space/tool events.
          emit: (delta) => {
            void this.events.emit({
              type: 'workspace_delta',
              runId: run.id,
              workId: work.id,
              stepId: step.id,
              workspaceId: workspace.id,
              delta,
            });
          },
          callTool: (toolId, toolInput) =>
            this.callTool(
              executionContext,
              run,
              work,
              step,
              toolId,
              toolInput,
              toolScope,
              request,
              signal,
            ),
        },
        signal ?? new AbortController().signal,
      );
      this.assertNotAborted(signal);

      await this.updateStep(run.id, work.id, step, 'producing');
      const artifact: Artifact = {
        ...draft,
        id: this.idFactory(),
        workspaceId: workspace.id,
        createdAt: this.now(),
      };
      step.artifact = artifact;
      await this.events.emit({ type: 'artifact_produced', runId: run.id, workId: work.id, stepId: step.id, artifact });
      await this.hooks.afterArtifact({ run, work, step, artifact, request });

      await this.updateStep(run.id, work.id, step, 'curating');
      await this.updateStep(run.id, work.id, step, 'exited');
      step.endedAt = this.now();
      try {
        await this.hooks.afterSpace({ run, work, step, request });
      } catch (hookError) {
        this.recordSpaceHookFailure(step, 'afterSpace', 'afterSpace hook failed', hookError);
      }
      await this.events.emit({ type: 'space_exit', runId: run.id, workId: work.id, step });
      return step;
    } catch (error) {
      const agentError = toAgentError(error);
      step.error = agentError;
      step.endedAt = this.now();
      await this.updateStep(run.id, work.id, step, agentError.code === 'work_aborted' ? 'aborted' : 'failed');
      try {
        await this.hooks.afterSpace({ run, work, step, request });
      } catch (hookError) {
        this.recordSpaceHookFailure(step, 'afterSpace', 'afterSpace hook failed', hookError);
      }
      await this.events.emit({ type: 'space_exit', runId: run.id, workId: work.id, step });
      if (agentError.code === 'work_aborted' || isToolError(agentError)) {
        throw agentError;
      }
      throw errorOf('workspace_failed', `WorkSpace failed: ${workspace.id}`, agentError);
    }
  }

  private async setRunStatus(run: Run, status: RunStatus): Promise<void> {
    run.status = status;
    await this.events.emit({ type: 'run_status', runId: run.id, status });
  }

  private async callTool(
    context: ToolExecutionContext,
    run: Run,
    work: Work,
    step: WorkStep,
    toolId: string,
    input: unknown,
    toolScope: ToolScope,
    request: WorkRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertNotAborted(signal);
    if (!toolScope.allowedToolIds.has(toolId)) {
      throw errorOf('tool_not_allowed', `Tool is not allowed in this Work scope: ${toolId}`);
    }

    const tool = this.tools.get(toolId);
    if (!tool) {
      throw errorOf('tool_not_found', `Tool not found: ${toolId}`);
    }

    const call: ToolCall = {
      id: this.idFactory(),
      toolId,
      input,
      reason: toolReason(input),
      startedAt: this.now(),
    };
    step.toolCalls.push(call);
    await this.events.emit({
      type: 'tool_execution_start',
      runId: context.runId,
      workId: context.workId,
      stepId: context.stepId,
      call,
    });

    const hookContext = () => ({ run, work, step, call, tool, execution: context, request });
    let afterHookAttempted = false;
    let afterHookRan = false;
    let handlerStarted = false;
    const executionSignal = signal ?? new AbortController().signal;
    try {
      if (looksLikeMalformedJsonArguments(call.input)) {
        throw errorOf('tool_failed', formatMalformedJsonArguments(toolId));
      }
      call.input = recoverToolArgumentShape(call.input, tool.parameters);
      call.reason = toolReason(call.input);
      if (tool.requiresReason && !call.reason && toolRecoveryCanAutofill(tool, 'reason')) {
        call.input = withToolReason(call.input, runtimeToolReason(toolId, call.input, work.goal || run.goal));
        call.reason = toolReason(call.input);
      }
      if (tool.prepareArguments) {
        const preparedInput = await tool.prepareArguments(call.input, context, executionSignal);
        call.input = preparedInput;
        call.reason = toolReason(preparedInput);
      }
      const shapeIssues = validateToolArgumentShape(call.input, tool.parameters);
      if (shapeIssues.length > 0) {
        throw errorOf('tool_failed', formatToolArgumentShapeIssues(toolId, shapeIssues));
      }
      this.assertNotAborted(signal);
      await this.hooks.beforeToolCall(hookContext());
      if (tool.requiresReason && !call.reason) {
        throw errorOf('tool_reason_required', `Tool requires a non-empty reason: ${toolId}`);
      }
      handlerStarted = true;
      const result = await tool.handler(call.input, context, executionSignal);
      this.assertNotAborted(signal);
      call.result = result;
      call.endedAt = this.now();
      afterHookAttempted = true;
      try {
        await this.hooks.afterToolCall(hookContext());
        afterHookRan = true;
      } catch (hookError) {
        afterHookRan = true;
        this.recordAfterToolHookFailure(call, hookError);
      }
      await this.events.emit({
        type: 'tool_execution_end',
        runId: context.runId,
        workId: context.workId,
        stepId: context.stepId,
        call,
      });
      return result;
    } catch (error) {
      const agentError = toAgentError(error);
      call.error = agentError.code === 'work_aborted' || isToolError(agentError)
        ? agentError
        : handlerStarted
          ? toolHandlerFailedError(toolId, agentError.message, error)
          : errorOf('tool_failed', `Tool failed: ${toolId}`);
      call.endedAt = this.now();
      if (!afterHookAttempted && !afterHookRan) {
        try {
          afterHookAttempted = true;
          await this.hooks.afterToolCall(hookContext());
        } catch (hookError) {
          this.recordAfterToolHookFailure(call, hookError);
        }
      }
      await this.events.emit({
        type: 'tool_execution_end',
        runId: context.runId,
        workId: context.workId,
        stepId: context.stepId,
        call,
      });
      throw call.error;
    }
  }

  private recordAfterToolHookFailure(call: ToolCall, error: unknown): void {
    const summary = hookFailureSummary(error);
    call.hookFailures = [
      ...(call.hookFailures ?? []),
      {
        phase: 'afterToolCall',
        message: 'afterToolCall hook failed',
        ...(summary.code ? { code: summary.code } : {}),
        occurredAt: this.now(),
      },
    ];
  }

  private recordSpaceHookFailure(step: WorkStep, phase: string, message: string, error: unknown): void {
    const summary = hookFailureSummary(error);
    step.hookFailures = [
      ...(step.hookFailures ?? []),
      {
        phase,
        message,
        ...(summary.code ? { code: summary.code } : {}),
        occurredAt: this.now(),
      },
    ];
  }

  private recordRunHookFailure(run: Run, phase: string, message: string, error: unknown): void {
    const summary = hookFailureSummary(error);
    const metadata = run.metadata ?? {};
    const hookFailures = Array.isArray(metadata.hookFailures) ? metadata.hookFailures : [];
    run.metadata = {
      ...metadata,
      hookFailures: [
        ...hookFailures,
        {
          phase,
          message,
          ...(summary.code ? { code: summary.code } : {}),
          occurredAt: this.now(),
        },
      ],
    };
  }

  private resolveToolScope(request: WorkRequest, executionContext: ToolExecutionContext): ToolScope {
    const skills = this.resolveSkills(request);
    const allowedToolIds = new Set<string>(request.toolIds ?? []);
    for (const skill of skills) {
      for (const toolId of skill.toolIds) {
        allowedToolIds.add(toolId);
      }
    }

    return {
      skills,
      availableTools: [...allowedToolIds].flatMap((toolId): ToolDescriptor[] => {
        const tool = this.tools.get(toolId);
        if (!tool) {
          return [];
        }
        const descriptor: ToolDescriptor = {
          id: tool.id,
          description: tool.description,
          parameters: tool.parameters,
          promptSnippet: tool.promptSnippet,
          promptGuidelines: tool.promptGuidelines,
          executionMode: tool.executionMode ?? 'sequential',
          recovery: tool.recovery,
          cache: tool.cache,
        };
        return [{
          ...descriptor,
          ...(tool.describe?.(executionContext) ?? {}),
          id: tool.id,
        }];
      }),
      allowedToolIds,
    };
  }

  private resolveSkills(request: WorkRequest): SkillDefinition[] {
    const inlineSkills = new Map((request.skills ?? []).map((skill) => [skill.id, skill]));
    return requestedSkillIds(request).map((skillId) => {
      const skill = inlineSkills.get(skillId) ?? this.skills.get(skillId);
      if (!skill) {
        throw errorOf('skill_not_found', `Skill not found: ${skillId}`);
      }
      return skill;
    });
  }

  private async createFailedRun(options: { agentId?: string; goal: string; error: AgentError }): Promise<Run> {
    const run: Run = {
      id: this.idFactory(),
      agentId: options.agentId,
      status: 'created',
      goal: options.goal,
      works: [],
      artifacts: [],
      startedAt: this.now(),
    };

    await this.events.emit({ type: 'agent_start', run });
    run.error = options.error;
    run.endedAt = this.now();
    await this.setRunStatus(run, 'failed');
    await this.events.emit({ type: 'error', runId: run.id, error: options.error });
    await this.events.emit({ type: 'agent_end', run });
    return run;
  }

  private resolveRunSession(agentId: string, request: AgentRunSessionRequest | undefined): SessionBinding | undefined {
    if (!request) {
      return undefined;
    }

    const existing = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    const session = existing ?? this.createSession({
      id: request.sessionId,
      agentId,
      kind: request.kind ?? (request.parentSessionId ? 'sub' : 'main'),
      trigger: request.trigger ?? 'user',
      title: request.title,
      parentSessionId: request.parentSessionId,
      metadata: request.metadata,
    });

    return toSessionBinding(session);
  }

  private persistRunMemory(run: Run, policy: MemoryPersistencePolicy | undefined): void {
    // Legacy runtime-local artifact cache. Durable people/work/experience memory
    // is handled by MemoryOrchestrator + store adapters.
    if (!policy?.scopes.length) {
      return;
    }

    for (const artifact of run.artifacts) {
      for (const scope of unique(policy.scopes)) {
        if (scope === 'session' && !run.session) {
          continue;
        }
        if (scope === 'agent' && !run.agentId) {
          continue;
        }

        const record: MemoryRecord = {
          id: this.idFactory(),
          scope,
          agentId: run.agentId,
          sessionId: scope === 'session' ? run.session?.id : undefined,
          runId: run.id,
          artifactId: artifact.id,
          title: artifact.title,
          summary: artifact.summary,
          data: artifact.data,
          tags: policy.tags ?? [],
          createdAt: this.now(),
        };
        this.memories.register(record);
      }
    }
  }

  /** Mirror a write to durable storage without blocking; swallow failures. */
  private firePersistence(operation: RuntimePersistenceOperation, write: () => void | Promise<void>): void {
    let task: void | Promise<void>;
    try {
      task = write();
    } catch (error) {
      this.reportPersistenceFailure(operation, error);
      return;
    }
    if (task && typeof (task as Promise<void>).then === 'function') {
      void (task as Promise<void>).catch((error: unknown) => {
        this.reportPersistenceFailure(operation, error);
        // Persistence is best-effort: a storage outage must not break the run.
      });
    }
  }

  private reportPersistenceFailure(operation: RuntimePersistenceOperation, error: unknown): void {
    const summary = persistenceErrorSummary(error);
    this.onPersistenceFailure?.({
      operation,
      message: truncatePersistenceFailureMessage(summary.message),
      ...(summary.code ? { code: summary.code } : {}),
      occurredAt: this.now(),
    });
  }

  private queryMemoryForContext(
    agent: AgentRunContext | undefined,
    session: SessionBinding | undefined,
    query: MemoryQuery,
  ): MemoryRecord[] {
    if (query.scope === 'agent') {
      return this.memories.query({ ...query, agentId: query.agentId ?? agent?.id });
    }
    if (query.scope === 'session') {
      return this.memories.query({ ...query, sessionId: query.sessionId ?? session?.id });
    }

    const agentId = query.agentId ?? agent?.id;
    const records = this.memories.query({ ...query, agentId });
    if (!session?.id) {
      return records;
    }
    return records.filter((record) => record.scope === 'agent' || record.sessionId === session.id);
  }

  private async updateWork(runId: string, work: Work, status: WorkStatus): Promise<void> {
    work.status = status;
    await this.events.emit({ type: 'work_status', runId, workId: work.id, status });
  }

  private async updateStep(runId: string, workId: string, step: WorkStep, status: WorkStepStatus): Promise<void> {
    step.status = status;
    if (!step.startedAt && status === 'active') {
      step.startedAt = this.now();
    }
    await this.events.emit({
      type: 'work_step_status',
      runId,
      workId,
      stepId: step.id,
      workspaceId: step.workspaceId,
      status,
    });
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw errorOf('work_aborted', 'Work aborted.');
    }
  }

  private recordTrace(event: AgentEvent): void {
    const record = this.traceRecordForEvent(event);
    if (record) {
      this.traces.append(record);
    }
  }

  private traceRecordForEvent(event: AgentEvent): TraceRecord | undefined {
    const createdAt = this.now();
    const base = {
      id: this.idFactory(),
      type: event.type,
      createdAt,
    };

    if (event.type === 'agent_start' || event.type === 'agent_end') {
      return {
        ...base,
        kind: 'run',
        runId: event.run.id,
        status: event.run.status,
        summary: event.run.goal,
        data: event.run,
      };
    }
    if (event.type === 'run_status') {
      return {
        ...base,
        kind: 'run',
        runId: event.runId,
        status: event.status,
      };
    }
    if (event.type === 'work_status') {
      return {
        ...base,
        kind: 'work',
        runId: event.runId,
        workId: event.workId,
        status: event.status,
      };
    }
    if (event.type === 'work_step_status') {
      return {
        ...base,
        kind: 'step',
        runId: event.runId,
        workId: event.workId,
        stepId: event.stepId,
        status: event.status,
        data: { workspaceId: event.workspaceId },
      };
    }
    if (event.type === 'before_work' || event.type === 'after_work') {
      return {
        ...base,
        kind: 'work',
        runId: event.runId,
        workId: event.work.id,
        status: event.work.status,
        summary: event.work.goal,
        data: event.work,
      };
    }
    if (event.type === 'space_enter' || event.type === 'space_exit') {
      return {
        ...base,
        kind: 'step',
        runId: event.runId,
        workId: event.workId,
        stepId: event.step.id,
        status: event.step.status,
        data: event.step,
      };
    }
    if (event.type === 'artifact_produced') {
      return {
        ...base,
        kind: 'artifact',
        runId: event.runId,
        workId: event.workId,
        stepId: event.stepId,
        artifactId: event.artifact.id,
        title: event.artifact.title,
        summary: event.artifact.summary,
        data: event.artifact,
      };
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      return {
        ...base,
        kind: 'tool_call',
        runId: event.runId,
        workId: event.workId,
        stepId: event.stepId,
        toolCallId: event.call.id,
        title: event.call.toolId,
        data: event.call,
      };
    }
    if (event.type === 'error') {
      return {
        ...base,
        kind: 'error',
        runId: event.runId,
        title: event.error.code,
        summary: event.error.message,
        data: event.error,
      };
    }
    return undefined;
  }
}

export function errorOf(code: AgentError['code'], message: string, cause?: unknown): AgentError {
  return { code, message, cause };
}

export function toAgentError(error: unknown): AgentError {
  if (isAgentError(error)) {
    return error;
  }
  return errorOf('workspace_failed', error instanceof Error ? error.message : String(error), error);
}

function toolHandlerFailedError(toolId: string, message: string, cause: unknown): AgentError {
  const detail = message.trim() || 'Unknown handler error';
  return errorOf('tool_failed', `Tool "${toolId}" failed: ${detail}`, cause);
}

function isAgentError(error: unknown): error is AgentError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error,
  );
}

function isToolError(error: AgentError): boolean {
  return (
    error.code === 'tool_not_found' ||
    error.code === 'tool_not_allowed' ||
    error.code === 'tool_reason_required' ||
    error.code === 'tool_failed'
  );
}

function persistenceErrorSummary(error: unknown): { code?: string; message: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    const message =
      typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : 'Unknown persistence error';
    return {
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      message,
    };
  }
  return { message: error === undefined ? 'Unknown persistence error' : String(error) };
}

function hookFailureSummary(error: unknown): { code?: string } {
  if (!error || typeof error !== 'object') {
    return {};
  }
  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? { code: candidate.code } : {};
}

function truncatePersistenceFailureMessage(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function toolReason(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('reason' in input)) {
    return undefined;
  }
  const reason = (input as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}

function withToolReason(input: unknown, reason: string): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), reason };
  }
  return { reason };
}

function toolRecoveryCanAutofill(tool: ToolDefinition, field: 'reason'): boolean {
  return Boolean(tool.recovery?.autofill?.includes(field));
}

function runtimeToolReason(toolId: string, input: unknown, goal: string): string {
  const target = primaryToolTarget(input);
  const targetText = target ? ` on ${target}` : '';
  const goalText = goal.trim() ? ` for "${goal.replace(/\s+/g, ' ').slice(0, 120)}"` : '';
  return `Runtime auto reason: run ${toolId}${targetText}${goalText}.`.slice(0, 240);
}

function primaryToolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'file', 'dir', 'directory', 'command', 'query', 'url', 'space', 'task']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return `${key}=${JSON.stringify(value.replace(/\s+/g, ' ').slice(0, 80))}`;
    }
  }
  return undefined;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function requestedSkillIds(request: WorkRequest): string[] {
  return unique([...(request.skillIds ?? []), ...(request.skills ?? []).map((skill) => skill.id)]);
}

function toAgentRunContext(agent: AgentDefinition, extraInstructions?: string): AgentRunContext {
  const instructions = [agent.instructions, extraInstructions].filter(Boolean).join('\n\n');
  return {
    id: agent.id,
    label: agent.label,
    avatar: agent.avatar,
    instructions: instructions || undefined,
    model: agent.model,
  };
}

function toSessionBinding(session: Session): SessionBinding {
  return {
    id: session.id,
    kind: session.kind,
    trigger: session.trigger,
    parentSessionId: session.parentSessionId,
  };
}

import type { Message, ProviderCacheBreakpoint } from '@zleap/ai';
import type { AgentRunContext, AgentRuntime, MemoryPersistencePolicy, Run, ToolApprovalPolicy } from '@zleap/core';
import { type WorkspaceSpec, type WorkspaceStepInput } from '../workspaces/index.js';
import type { ToolConfirm } from '../workspaces/turnLoop.js';

/** Recall relevant prior memory for a goal; returns a rendered variable block. */
export type RecallFn = (goal: string) => Promise<string | undefined>;

type KernelOptions = {
  runtime: AgentRuntime;
  /** The resident master (`main`) space the kernel runs every reply through. */
  mainSpec: WorkspaceSpec;
  /** Agent identity for runs (enables agent-scoped memory persistence). */
  agent?: AgentRunContext;
  /** Memory persistence policy applied to each run. */
  memory?: MemoryPersistencePolicy;
  /** Vector recall, injected into the session before it runs. */
  recall?: RecallFn;
};

/**
 * The workspace-entry kernel. Every reply enters the resident `session` space,
 * where the session model itself routes to a work space by calling
 * `enterWorkspace(space, task)` (see ChatEngine). The kernel no longer
 * picks a work space up front — it just runs session and carries identity,
 * memory policy, and recall. Main→work depth stays 1 at the runtime tool layer.
 */
export class Kernel {
  private readonly runtime: AgentRuntime;
  private readonly mainSpec: WorkspaceSpec;
  private readonly agent?: AgentRunContext;
  private readonly memory?: MemoryPersistencePolicy;
  private readonly recallFn?: RecallFn;

  constructor(options: KernelOptions) {
    this.runtime = options.runtime;
    this.mainSpec = options.mainSpec;
    this.agent = options.agent;
    this.memory = options.memory;
    this.recallFn = options.recall;
  }

  /** Run the session master space for the goal; returns its Run. */
  async dispatch(
    goal: string,
    messages: Message[],
    signal: AbortSignal,
    options: {
      confirm?: ToolConfirm;
      globalSystem?: string;
      workspaceRoot?: string;
      cacheBreakpoints?: ProviderCacheBreakpoint[];
      approvalPolicy?: ToolApprovalPolicy;
    } = {},
  ): Promise<Run | undefined> {
    if (signal.aborted) {
      return undefined;
    }
    const spec = this.mainSpec;
    const recall = this.recallFn ? await this.recallFn(goal).catch(() => undefined) : undefined;
    const input: WorkspaceStepInput = {
      messages,
      confirm: options.confirm,
      globalSystem: options.globalSystem,
      recall,
      cacheBreakpoints: options.cacheBreakpoints,
      approvalPolicy: options.approvalPolicy,
    };
    return this.runtime.run(
      {
        spaces: [spec.id],
        goal,
        toolIds: spec.toolIds,
        workspaceRoot: options.workspaceRoot,
        context: input,
        agent: this.agent,
        memory: this.memory,
      },
      { signal },
    );
  }
}

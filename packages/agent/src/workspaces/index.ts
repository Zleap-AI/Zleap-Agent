import type { ToolApprovalPolicy } from '@zleap/core';
import type { Message, ProviderCacheBreakpoint } from '@zleap/ai';
import {
  createDefaultSuperAgentSeed,
  LEGACY_SESSION_SPACE_ID,
  type SkillDefinition,
  toCanonicalSpaceId,
  toRuntimeSpaceId,
} from '@zleap/core';
import type { ToolConfirm } from './turnLoop.js';
import { MAX_TOOL_ITERATIONS } from './turnLoop.js';

export {
  assembleWorkTurnContext,
  LOOP_DISCIPLINE,
  previewToolCall,
  runTurnLoop,
  runtimeToolExchange,
  toToolSchema,
  TOOL_REASON_DISCIPLINE,
  type ToolApprovalRequest,
  type ToolConfirm,
} from './turnLoop.js';

/**
 * Runtime, in-memory shape of a workspace the engine drives. There are NO
 * hardcoded workspace definitions in code: spaces live in the database (the
 * single source of truth — docs/core.md §3). Built-in defaults are derived from
 * the default seed so the agent is usable out of the box; user-created work
 * spaces are configured in the web UI and read from the store at dispatch time.
 */
export type WorkspaceSpec = {
  id: string;
  label: string;
  icon?: string;
  /** 'main' = the resident master space (its runtime id is `session`); 'work' = a dispatched sub-space. */
  kind?: 'main' | 'work';
  description: string;
  /** One-line routing hint shown to the kernel router. */
  when: string;
  /** Boundary hint shown to the router to sharpen routing. */
  notFor?: string;
  /** System prompt injected when the workspace is entered. */
  persona: string;
  /** Tool ids this workspace is allowed to use. */
  toolIds: string[];
  status?: 'ready' | 'planned';
  ui?: {
    label?: string;
    icon?: string;
    accent?: string;
  };
};

/** `session` is the runtime id of the resident master (`main`) space. */
export const FALLBACK_WORKSPACE_ID = LEGACY_SESSION_SPACE_ID;

type SpaceVersionTheme = { icon?: string; accent?: string };

function readTheme(metadata: Record<string, unknown> | undefined): SpaceVersionTheme {
  return {
    icon: typeof metadata?.icon === 'string' ? metadata.icon : undefined,
    accent: typeof metadata?.accent === 'string' ? metadata.accent : undefined,
  };
}

/**
 * The resident `main` space, derived from the default seed (NOT hand-written in
 * code). The seed is the same data `seedSuperAgentDefaults` writes to the store,
 * so the built-in fallback and the database agree.
 */
export function defaultMainWorkspaceSpec(): WorkspaceSpec {
  const seed = createDefaultSuperAgentSeed();
  const main = seed.spaces.find((entry) => entry.space.kind === 'main') ?? seed.spaces[0]!;
  const theme = readTheme(main.version.metadata);
  const toolIds = main.bindings
    .filter((binding) => binding.enabled && binding.capabilityType === 'tool')
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((binding) => binding.capabilityId);
  return {
    id: toRuntimeSpaceId(main.space.slug),
    label: main.version.label,
    kind: 'main',
    status: 'ready',
    description: main.version.description ?? '',
    when: main.version.routingCard ?? '',
    persona: main.version.instructions ?? '',
    toolIds,
    ui: { label: main.version.label, icon: theme.icon, accent: theme.accent },
  };
}

export function workspaceView(spec: WorkspaceSpec): WorkspaceView {
  return {
    id: spec.id,
    label: spec.ui?.label ?? spec.label,
    icon: spec.ui?.icon ?? spec.icon,
    accent: spec.ui?.accent,
    kind: spec.kind ?? 'work',
    description: spec.description,
    when: spec.when,
    notFor: spec.notFor,
    status: spec.status ?? 'ready',
    budget: { maxToolIterations: MAX_TOOL_ITERATIONS },
  };
}

export type WorkspaceView = {
  id: string;
  label: string;
  icon?: string;
  accent?: string;
  kind: 'main' | 'work';
  description: string;
  when: string;
  notFor?: string;
  status: 'ready' | 'planned';
  budget: {
    maxToolIterations: number;
    timeoutMs?: number;
  };
};

export type WorkspaceDetails = WorkspaceView & {
  /** Stable config/storage id. The runtime maps canonical `main` to legacy `session`. */
  canonicalId: string;
  /** DB storage id of the space (global slug); used by config write-back. */
  storageId: string;
  /** Optional LLM model config bound to this space. */
  modelConfigId?: string;
  routingCard?: string;
  instructions?: string;
  toolIds: string[];
  skillIds?: string[];
  autoMountSkills?: boolean;
};

export type AvatarSpaceViewSource = {
  id: string;
  storageId?: string;
  kind: 'main' | 'work';
  label: string;
  description?: string;
  routingCard?: string;
  instructions?: string;
  icon?: string;
  accent?: string;
  modelConfigId?: string;
  toolIds: string[];
  skillIds?: string[];
  autoMountSkills?: boolean;
};

/** Project the default seed into runtime workspace details (DB-free fallback). */
export function buildDefaultSeedWorkspaceDetails(): WorkspaceDetails[] {
  const seed = createDefaultSuperAgentSeed();

  return seed.spaces.map(({ space, version, bindings }) => {
    const canonicalId = space.slug;
    const runtimeId = toRuntimeSpaceId(canonicalId);
    const theme = readTheme(version.metadata);
    const toolIds = bindings
      .filter((binding) => binding.enabled && binding.capabilityType === 'tool')
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((binding) => binding.capabilityId);

    return {
      id: runtimeId,
      canonicalId,
      storageId: space.id,
      label: version.label,
      icon: theme.icon,
      accent: theme.accent,
      kind: space.kind,
      description: version.description ?? '',
      when: version.routingCard ?? '',
      routingCard: version.routingCard,
      instructions: version.instructions,
      status: space.status === 'disabled' ? 'planned' : 'ready',
      budget: { maxToolIterations: MAX_TOOL_ITERATIONS },
      modelConfigId: version.modelConfigId,
      toolIds,
      skillIds: [],
      autoMountSkills: true,
    };
  });
}

/** Project DB-sourced space profiles into runtime workspace details. */
export function buildWorkspaceDetailsFromAvatarProfile(profile: { spaces: AvatarSpaceViewSource[] }): WorkspaceDetails[] {
  return profile.spaces.map((space) => {
    const canonicalId = toCanonicalSpaceId(space.id);
    const runtimeId = toRuntimeSpaceId(canonicalId);
    return {
      id: runtimeId,
      canonicalId,
      storageId: space.storageId ?? canonicalId,
      label: space.label,
      icon: space.icon,
      accent: space.accent,
      kind: space.kind,
      description: space.description ?? '',
      when: space.routingCard ?? '',
      routingCard: space.routingCard,
      instructions: space.instructions,
      status: 'ready',
      budget: { maxToolIterations: MAX_TOOL_ITERATIONS },
      modelConfigId: space.modelConfigId,
      toolIds: space.toolIds,
      skillIds: space.skillIds ?? [],
      autoMountSkills: space.autoMountSkills !== false,
    };
  });
}

/** What the kernel passes into a workspace step via the run context. */
export type WorkspaceStepInput = {
  messages: Message[];
  confirm?: ToolConfirm;
  /** Optional model override resolved from the Space's durable model binding. */
  modelId?: string;
  /** Optional global guidance (the user's --system prompt). */
  globalSystem?: string;
  /** The turn-level goal (user's request), shared so a work space sees the big picture. */
  turnGoal?: string;
  /** Rendered typed-memory recall block to ground the workspace. */
  recall?: string;
  /** Runtime-built tool-result messages, such as listMemory, placed before replayed workspace turns. */
  runtimeMessages?: Message[];
  /** Runtime-built workspace handoff context appended to the current task message. */
  handoffContext?: string;
  /** Runtime skill candidates found only when no skill was selected or bound. */
  suggestedSkills?: SkillDefinition[];
  /** Context assembly boundaries declared by the caller and executed by providers that support them. */
  cacheBreakpoints?: ProviderCacheBreakpoint[];
  /** Tool approval policy for this workspace step. */
  approvalPolicy?: ToolApprovalPolicy;
};

export function parseWorkspaceInput(input: unknown): WorkspaceStepInput {
  if (input && typeof input === 'object' && 'messages' in input && Array.isArray(input.messages)) {
    return input as WorkspaceStepInput;
  }
  return { messages: [] };
}

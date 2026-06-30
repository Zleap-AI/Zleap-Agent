import type { ActorRole } from './actor.js';

export type ToolApprovalMode = 'request_approval' | 'full_access';
export type ToolApprovalDecision = 'allow' | 'require_approval';
export type ToolApprovalSpaceKind = 'main' | 'work';

export type ToolArgumentMatcher = {
  field: string;
  exists?: boolean;
  equals?: string | number | boolean;
  includes?: string;
  startsWith?: string;
  matches?: string;
};

export type ToolApprovalRule = {
  id: string;
  decision: ToolApprovalDecision;
  toolIds?: readonly string[];
  toolIdPrefixes?: readonly string[];
  spaceIds?: readonly string[];
  spaceKinds?: readonly ToolApprovalSpaceKind[];
  actorRoles?: readonly ActorRole[];
  arguments?: readonly ToolArgumentMatcher[];
};

export type ToolApprovalPolicy = {
  mode?: ToolApprovalMode;
  highRiskToolIds?: Iterable<string>;
  externalToolPrefixes?: readonly string[];
  rules?: readonly ToolApprovalRule[];
  defaultDecision?: ToolApprovalDecision;
};

export type ToolApprovalInput = {
  toolId: string;
  arguments?: unknown;
  spaceId?: string;
  spaceKind?: ToolApprovalSpaceKind;
  actorRole?: ActorRole;
  policy?: ToolApprovalPolicy;
};

export type ToolApprovalEvaluation = {
  requiresApproval: boolean;
  decision: ToolApprovalDecision;
  reason: string;
  matchedRuleId?: string;
};

const DEFAULT_EXTERNAL_TOOL_PREFIXES = ['mcp__'];

export function evaluateToolApproval(input: ToolApprovalInput): ToolApprovalEvaluation {
  const policy = input.policy ?? {};
  if (policy.mode === 'full_access') {
    return { requiresApproval: false, decision: 'allow', reason: 'permission_mode_full_access' };
  }

  const matchedRule = policy.rules?.find((rule) => matchesRule(rule, input));
  if (matchedRule) {
    return {
      requiresApproval: matchedRule.decision === 'require_approval',
      decision: matchedRule.decision,
      reason: `rule:${matchedRule.id}`,
      matchedRuleId: matchedRule.id,
    };
  }

  const highRiskToolIds = new Set(policy.highRiskToolIds ?? []);
  if (highRiskToolIds.has(input.toolId)) {
    return { requiresApproval: true, decision: 'require_approval', reason: 'tool_high_risk' };
  }

  const externalPrefixes = policy.externalToolPrefixes ?? DEFAULT_EXTERNAL_TOOL_PREFIXES;
  if (externalPrefixes.some((prefix) => input.toolId.startsWith(prefix))) {
    return { requiresApproval: true, decision: 'require_approval', reason: 'external_tool_prefix' };
  }

  const decision = policy.defaultDecision ?? 'allow';
  return { requiresApproval: decision === 'require_approval', decision, reason: 'policy_default' };
}

function matchesRule(rule: ToolApprovalRule, input: ToolApprovalInput): boolean {
  if (rule.toolIds && !rule.toolIds.includes(input.toolId)) {
    return false;
  }
  if (rule.toolIdPrefixes && !rule.toolIdPrefixes.some((prefix) => input.toolId.startsWith(prefix))) {
    return false;
  }
  if (rule.spaceIds && (!input.spaceId || !rule.spaceIds.includes(input.spaceId))) {
    return false;
  }
  if (rule.spaceKinds && (!input.spaceKind || !rule.spaceKinds.includes(input.spaceKind))) {
    return false;
  }
  if (rule.actorRoles && (!input.actorRole || !rule.actorRoles.includes(input.actorRole))) {
    return false;
  }
  if (rule.arguments && !rule.arguments.every((matcher) => matchesArgument(matcher, input.arguments))) {
    return false;
  }
  return true;
}

function matchesArgument(matcher: ToolArgumentMatcher, args: unknown): boolean {
  const value = readArgument(args, matcher.field);
  if (matcher.exists !== undefined && (value !== undefined) !== matcher.exists) {
    return false;
  }
  if (matcher.equals !== undefined && value !== matcher.equals) {
    return false;
  }
  if (matcher.includes !== undefined && !String(value ?? '').includes(matcher.includes)) {
    return false;
  }
  if (matcher.startsWith !== undefined && !String(value ?? '').startsWith(matcher.startsWith)) {
    return false;
  }
  if (matcher.matches !== undefined) {
    try {
      if (!new RegExp(matcher.matches).test(String(value ?? ''))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function readArgument(args: unknown, field: string): unknown {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  let current: unknown = args;
  for (const part of field.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

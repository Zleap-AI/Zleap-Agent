export type PermissionMode = 'request_approval' | 'full_access';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'request_approval';

const DENIED_WITHOUT_HITL_TOOL_IDS = new Set(['bash', 'write', 'append', 'edit']);

/** Auto-approve safe builtins on web; deny machine-mutating tools and MCP without HITL. */
export function shouldAutoApproveToolWithoutHitl(toolName: string): boolean {
  return !DENIED_WITHOUT_HITL_TOOL_IDS.has(toolName) && !toolName.startsWith('mcp__');
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'full_access' ? 'full_access' : DEFAULT_PERMISSION_MODE;
}

export function bypassesToolApproval(mode: PermissionMode): boolean {
  return mode === 'full_access';
}

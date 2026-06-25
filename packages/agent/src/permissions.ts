export type PermissionMode = 'request_approval' | 'full_access';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'request_approval';

export const PERMISSION_MODE_CYCLE: PermissionMode[] = ['request_approval', 'full_access'];

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'full_access' ? 'full_access' : DEFAULT_PERMISSION_MODE;
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const index = PERMISSION_MODE_CYCLE.indexOf(mode);
  return PERMISSION_MODE_CYCLE[(index + 1) % PERMISSION_MODE_CYCLE.length] ?? DEFAULT_PERMISSION_MODE;
}

export function bypassesToolApproval(mode: PermissionMode): boolean {
  return mode === 'full_access';
}

export function permissionModeLabel(mode: PermissionMode): string {
  return mode === 'full_access' ? '全权' : '审批';
}

export function permissionModeHint(mode: PermissionMode): string {
  return mode === 'full_access'
    ? '高风险工具自动执行（慎用）'
    : '写文件/命令/MCP 等需确认';
}

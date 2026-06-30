import type { CliConfig } from './config.js';
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  normalizeRunMode,
  type PermissionMode,
  type RunMode,
} from '@zleap/agent';

export type CliSessionPrefs = {
  runMode?: RunMode;
  permissionMode?: PermissionMode;
};

export type ResolvedSessionPrefs = {
  runMode: RunMode;
  permissionMode: PermissionMode;
};

export function resolveSessionPrefs(config: CliConfig): ResolvedSessionPrefs {
  return {
    runMode: normalizeRunMode(config.session?.runMode),
    permissionMode: normalizePermissionMode(config.session?.permissionMode ?? DEFAULT_PERMISSION_MODE),
  };
}

export function patchSessionPrefs(config: CliConfig, patch: Partial<CliSessionPrefs>): CliConfig {
  return {
    ...config,
    session: {
      ...config.session,
      ...patch,
    },
  };
}

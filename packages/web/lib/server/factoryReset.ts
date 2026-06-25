import { DEFAULT_FILE_WORKSPACE_ROOT } from '@zleap/core';
import { createStore, resetDurableStoreData, seedSuperAgentDefaults } from '@zleap/store';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, readdir, rm } from 'node:fs/promises';
import { storeConfigFromEnv } from './avatarStore';
import { clear302IntegrationConfig } from './integration302Config';
import { clearApprovalQueue } from './liveApprovals';
import { resetFileDefault302ModelConfigs, upsertDefault302ModelConfigs } from './modelPresets';
import { clearPermissionPreferences } from './permissionPreferenceStore';
import { projectStore } from './projectStore';
import { clearToolState } from './toolStateStore';

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_DIR_RE = /^(web|conv|conversation|codex)-/;
const DEFAULT_LEGACY_CONVERSATIONS_ROOT = join(homedir(), 'Documents', 'Zleap', 'conversations');

export type FactoryResetResult = {
  history: { removedCount: number };
  database: { enabled: boolean; tablesCleared: number; defaultsSeeded: boolean };
  local: {
    projectsCleared: boolean;
    tasksCleared: boolean;
    permissionPreferencesCleared: boolean;
    approvalsCleared: boolean;
    toolStateCleared: boolean;
    integrationConfigCleared: boolean;
    modelFileReset: boolean;
  };
};

export async function factoryResetWebData(): Promise<FactoryResetResult> {
  await clear302IntegrationConfig();
  const database = await resetDatabase();
  const [history] = await Promise.all([
    clearConversationHistoryFolders(),
    projectStore.clear(),
    clearPermissionPreferences(),
    clearApprovalQueue(),
    clearToolState(),
    resetFileDefault302ModelConfigs(),
  ]);

  return {
    history,
    database,
    local: {
      projectsCleared: true,
      tasksCleared: true,
      permissionPreferencesCleared: true,
      approvalsCleared: true,
      toolStateCleared: true,
      integrationConfigCleared: true,
      modelFileReset: true,
    },
  };
}

async function resetDatabase(): Promise<FactoryResetResult['database']> {
  const config = storeConfigFromEnv();
  if (!config) {
    return { enabled: false, tablesCleared: 0, defaultsSeeded: false };
  }
  const reset = await resetDurableStoreData(config);
  const store = await createStore(config);
  if (!store) {
    throw new Error('database_unreachable_after_reset');
  }
  try {
    await seedSuperAgentDefaults(store);
    await upsertDefault302ModelConfigs(store);
  } finally {
    await store.close().catch(() => {});
  }
  return { enabled: true, tablesCleared: reset.tablesCleared, defaultsSeeded: true };
}

async function clearConversationHistoryFolders(): Promise<{ removedCount: number }> {
  const activeRoot = resolve(process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT);
  let removedCount = await removeHistoryChildren(activeRoot);

  const defaultRoot = resolve(DEFAULT_FILE_WORKSPACE_ROOT);
  const legacyRoot = resolve(DEFAULT_LEGACY_CONVERSATIONS_ROOT);
  if (activeRoot === defaultRoot && legacyRoot !== activeRoot && legacyRoot.startsWith(defaultRoot)) {
    removedCount += await removeDirectoryIfExists(legacyRoot);
  }

  return { removedCount };
}

async function removeHistoryChildren(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!DATE_DIR_RE.test(entry.name) && !LEGACY_DIR_RE.test(entry.name)) continue;
    removed += await removeDirectoryIfExists(join(root, entry.name));
  }
  return removed;
}

async function removeDirectoryIfExists(path: string): Promise<number> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isDirectory()) return 0;
  await rm(path, { recursive: true, force: true });
  return 1;
}

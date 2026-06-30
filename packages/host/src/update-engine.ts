import { createHash } from 'node:crypto';
import { normalizeVersion, appArchiveName, appDownloadUrl } from './distribution.js';
import { installAppFromRelease, type InstallAppOptions } from './install.js';
import { releasePlatformTag } from './layout.js';
import { restartServe } from './service/manager.js';
import { readPreviousAppMetadata, readAppMetadata, restorePreviousApp } from './upgrade.js';
import { stopServe } from './supervisor.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { zleapLayout } from './layout.js';
import { acquireRuntimeLock } from './lock.js';
import { assertNoActiveTaskRuns, assertRuntimeUpdateAllowed, type RuntimeUpdatePolicy } from './update-preflight.js';

export type UpdateOptions = InstallAppOptions & {
  restart?: boolean;
  ignoreActiveTasks?: boolean;
};

export type RollbackOptions = RuntimeUpdatePolicy & {
  restart?: boolean;
  ignoreActiveTasks?: boolean;
};

export type UpdateResult = {
  previousVersion?: string;
  newVersion: string;
  restarted: boolean;
  checked?: boolean;
  upToDate?: boolean;
  rolledBack?: boolean;
};

async function acquireUpdateLock(): Promise<() => Promise<void>> {
  const { updateLockPath } = zleapLayout();
  const lock = await acquireRuntimeLock(updateLockPath, { owner: 'update' });
  return lock.release;
}

async function logUpdate(message: string): Promise<void> {
  const { updateLogPath, logsDir } = zleapLayout();
  await mkdir(logsDir, { recursive: true });
  await appendFile(updateLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

/** Full update pipeline with rollback and optional restart. */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const current = await readAppMetadata();

  if (options.checkOnly) {
    const result = await installAppFromRelease({ checkOnly: true, version: options.version });
    return { ...result, restarted: false };
  }

  const release = await acquireUpdateLock();
  try {
    await logUpdate(`starting update ${current?.version ?? 'none'}`);
    const check = await installAppFromRelease({ ...options, checkOnly: true });
    if (check.upToDate) {
      await logUpdate(`already up to date ${check.newVersion}`);
      return { ...check, restarted: false };
    }
    const taskPreflight = await assertNoActiveTaskRuns({ ignoreActiveTasks: options.ignoreActiveTasks });
    await logUpdate(`task preflight: ${taskPreflight.detail}`);
    await stopServe().catch(() => undefined);
    const result = await installAppFromRelease(options);
    if (options.restart !== false) {
      await restartServe();
      result.restarted = true;
    }
    await logUpdate(`update complete -> ${result.newVersion}`);
    return result;
  } catch (error) {
    await logUpdate(`update failed: ${error instanceof Error ? error.message : error}`);
    const restored = await restorePreviousApp().catch(() => false);
    if (restored) {
      await logUpdate('rolled back to previous app');
      if (options.restart !== false) {
        await restartServe().catch(() => undefined);
      }
      throw new Error(`${error instanceof Error ? error.message : error}（已回滚到上一版本）`);
    }
    throw error;
  } finally {
    await release();
  }
}

export async function runRollback(options: RollbackOptions = {}): Promise<UpdateResult> {
  const release = await acquireUpdateLock();
  try {
    const current = await readAppMetadata();
    const previous = await readPreviousAppMetadata();
    if (previous) {
      assertRuntimeUpdateAllowed(current, previous, options);
    }
    const taskPreflight = await assertNoActiveTaskRuns({ ignoreActiveTasks: options.ignoreActiveTasks });
    await logUpdate(`rollback task preflight: ${taskPreflight.detail}`);
    await stopServe().catch(() => undefined);
    const restored = await restorePreviousApp();
    if (!restored) {
      throw new Error('没有可回滚的 previous 版本');
    }
    const meta = await readAppMetadata();
    if (options.restart !== false) {
      await restartServe();
    }
    return {
      previousVersion: current?.version,
      newVersion: meta?.version ?? 'unknown',
      restarted: options.restart !== false,
      rolledBack: true,
    };
  } finally {
    await release();
  }
}

export function appSha256Hex(version: string, bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function appChecksumFileName(version: string, platform = releasePlatformTag()): string {
  return `${appArchiveName(normalizeVersion(version), platform)}.sha256`;
}

export function appChecksumUrl(version: string, platform = releasePlatformTag()): string {
  return `${appDownloadUrl(normalizeVersion(version), platform)}.sha256`;
}

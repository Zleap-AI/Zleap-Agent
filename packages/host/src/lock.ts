import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export type RuntimeLock = {
  path: string;
  release: () => Promise<void>;
};

export type RuntimeLockOptions = {
  owner?: string;
  staleAfterMs?: number;
};

type LockRecord = {
  pid?: number;
  owner?: string;
  acquiredAt?: string;
};

export async function acquireRuntimeLock(path: string, options: RuntimeLockOptions = {}): Promise<RuntimeLock> {
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = JSON.stringify(
      {
        pid: process.pid,
        owner: options.owner ?? 'unknown',
        acquiredAt: new Date().toISOString(),
      },
      null,
      2,
    );

    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(`${payload}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path,
        release: async () => {
          await rm(path, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      if (attempt === 0 && (await reclaimStaleRuntimeLock(path, options))) {
        continue;
      }
      throw new Error(`另一个 ${options.owner ?? 'runtime'} 操作正在进行中：${path}`);
    }
  }

  throw new Error(`另一个 ${options.owner ?? 'runtime'} 操作正在进行中：${path}`);
}

export async function reclaimStaleRuntimeLock(path: string, options: RuntimeLockOptions = {}): Promise<boolean> {
  const existing = await readRuntimeLock(path);
  if (!existing) {
    return false;
  }
  if (existing.pid && pidAlive(existing.pid)) {
    const staleAfterMs = options.staleAfterMs ?? 0;
    if (staleAfterMs <= 0 || !existing.acquiredAt) {
      return false;
    }
    const ageMs = Date.now() - Date.parse(existing.acquiredAt);
    if (!Number.isFinite(ageMs) || ageMs < staleAfterMs) {
      return false;
    }
  }
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}

export async function readRuntimeLock(path: string): Promise<LockRecord | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as LockRecord;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, type PermissionMode } from '../permissions';

function storePath(): string {
  return process.env.ZLEAP_WEB_PERMISSION_PREFS_PATH ?? join(homedir(), '.zleap', 'permission-preferences.json');
}

type PermissionPrefsFile = {
  version: 1;
  records: Record<string, { mode: PermissionMode; updatedAt: string }>;
};

export type PermissionPreferenceScope = {
  tenantId?: string;
  userId: string;
  avatarId?: string;
  spaceId?: string;
};

export async function readPermissionPreference(scope: PermissionPreferenceScope): Promise<PermissionMode> {
  const file = await readFileSafe();
  return normalizePermissionMode(file.records[scopeKey(scope)]?.mode);
}

export async function savePermissionPreference(scope: PermissionPreferenceScope, mode: PermissionMode): Promise<PermissionMode> {
  const file = await readFileSafe();
  const normalized = normalizePermissionMode(mode);
  file.records[scopeKey(scope)] = { mode: normalized, updatedAt: new Date().toISOString() };
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return normalized;
}

export async function clearPermissionPreferences(): Promise<void> {
  await rm(storePath(), { force: true });
}

function scopeKey(scope: PermissionPreferenceScope): string {
  return [scope.tenantId ?? '', scope.userId, scope.avatarId ?? '*', scope.spaceId ?? '*'].join(':');
}

async function readFileSafe(): Promise<PermissionPrefsFile> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<PermissionPrefsFile>;
    return { version: 1, records: parsed.records && typeof parsed.records === 'object' ? parsed.records as PermissionPrefsFile['records'] : {} };
  } catch {
    return { version: 1, records: {} };
  }
}

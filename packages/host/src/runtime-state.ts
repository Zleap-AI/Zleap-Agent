import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { zleapLayout } from './layout.js';
import { readAppMetadata } from './upgrade.js';

export type RuntimeState = {
  home: string;
  runtimeRoot: string;
  version: string;
  platform: string;
  schemaVersion?: number;
  updatedAt: string;
};

export type LauncherState = {
  installedCliVersion?: string;
  installedDesktopVersion?: string;
  lastLauncher?: 'cli' | 'desktop' | 'service' | 'dev';
  lastBootstrapSource?: 'download' | 'embedded' | 'existing' | 'dev';
  updatedAt: string;
};

export async function readRuntimeState(): Promise<RuntimeState | undefined> {
  try {
    const raw = await readFile(zleapLayout().runtimeStatePath, 'utf8');
    return JSON.parse(raw) as RuntimeState;
  } catch {
    return undefined;
  }
}

export async function writeRuntimeState(state: Partial<RuntimeState> = {}): Promise<RuntimeState> {
  const layout = zleapLayout();
  const meta = await readAppMetadata();
  const full: RuntimeState = {
    home: state.home ?? layout.home,
    runtimeRoot: state.runtimeRoot ?? layout.current,
    version: state.version ?? meta?.version ?? '0.0.0',
    platform: state.platform ?? meta?.platform ?? 'unknown',
    schemaVersion: state.schemaVersion ?? meta?.schemaVersion,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  await writeJson(layout.runtimeStatePath, full);
  return full;
}

export async function readLauncherState(): Promise<LauncherState | undefined> {
  try {
    const raw = await readFile(zleapLayout().launcherStatePath, 'utf8');
    return JSON.parse(raw) as LauncherState;
  } catch {
    return undefined;
  }
}

export async function writeLauncherState(state: Partial<LauncherState>): Promise<LauncherState> {
  const current = await readLauncherState();
  const full: LauncherState = {
    ...current,
    ...state,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  await writeJson(zleapLayout().launcherStatePath, full);
  return full;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

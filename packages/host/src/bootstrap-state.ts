import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { zleapLayout } from './layout.js';
import { readAppMetadata } from './upgrade.js';

export type BootstrapState = {
  completedAt: string;
  version: string;
  platform: string;
  seededFrom?: string;
  method?: 'desktop' | 'cli';
};

const DESKTOP_LOG_RING = 500;

export function bootstrapStatePath(): string {
  return zleapLayout().bootstrapStatePath;
}

export function desktopLogPath(): string {
  return zleapLayout().desktopLogPath;
}

export async function readBootstrapState(): Promise<BootstrapState | undefined> {
  try {
    const raw = await readFile(bootstrapStatePath(), 'utf8');
    return JSON.parse(raw) as BootstrapState;
  } catch {
    return undefined;
  }
}

export async function writeBootstrapState(state: BootstrapState): Promise<void> {
  const layout = zleapLayout();
  await mkdir(layout.stateDir, { recursive: true });
  await writeFile(bootstrapStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function isBootstrapComplete(): Promise<boolean> {
  const state = await readBootstrapState();
  if (!state?.completedAt) {
    return false;
  }
  const meta = await readAppMetadata();
  if (!meta?.version) {
    return false;
  }
  return meta.version === state.version;
}

export async function appendDesktopLog(line: string): Promise<void> {
  const layout = zleapLayout();
  await mkdir(layout.logsDir, { recursive: true });
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  await appendFile(desktopLogPath(), entry, 'utf8');
}

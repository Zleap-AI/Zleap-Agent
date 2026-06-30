import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Web-owned tool on/off state — a JSON file under the home dir (web bypass,
 * docs/core.md §7). The tool catalog itself is code-defined; this only records
 * which toolsets / individual tools the user has switched OFF. A tool is usable
 * for mounting iff its toolset is enabled AND the tool isn't individually off.
 */
export type ToolState = {
  disabledToolSetIds: string[];
  disabledToolIds: string[];
  cacheByToolId: Record<string, ToolCacheState>;
};

export type ToolCacheState = {
  produces: boolean;
  kinds: string[];
  capture: 'auto' | 'none';
};

const EMPTY: ToolState = { disabledToolSetIds: [], disabledToolIds: [], cacheByToolId: {} };

function storePath(): string {
  return process.env.ZLEAP_WEB_TOOL_STATE_PATH ?? join(homedir(), '.zleap', 'tool-state.json');
}

export async function readToolState(): Promise<ToolState> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<ToolState>;
    return {
      disabledToolSetIds: Array.isArray(parsed.disabledToolSetIds) ? parsed.disabledToolSetIds.filter((id) => typeof id === 'string') : [],
      disabledToolIds: Array.isArray(parsed.disabledToolIds) ? parsed.disabledToolIds.filter((id) => typeof id === 'string') : [],
      cacheByToolId: normalizeCacheByToolId(parsed.cacheByToolId),
    };
  } catch {
    return { ...EMPTY };
  }
}

async function writeToolState(state: ToolState): Promise<void> {
  const file = storePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

/** Toggle a toolset or a single tool on/off; persists and returns the new state. */
export async function setToolEnabled(scope: 'toolset' | 'tool', id: string, enabled: boolean): Promise<ToolState> {
  const state = await readToolState();
  const key = scope === 'toolset' ? 'disabledToolSetIds' : 'disabledToolIds';
  const set = new Set(state[key]);
  if (enabled) set.delete(id);
  else set.add(id);
  const next: ToolState = { ...state, [key]: [...set] };
  await writeToolState(next);
  return next;
}

export async function setToolCacheState(id: string, cache: ToolCacheState): Promise<ToolState> {
  const state = await readToolState();
  const next: ToolState = {
    ...state,
    cacheByToolId: {
      ...state.cacheByToolId,
      [id]: normalizeToolCacheState(cache),
    },
  };
  await writeToolState(next);
  return next;
}

export async function clearToolState(): Promise<void> {
  await rm(storePath(), { force: true });
}

function normalizeCacheByToolId(value: unknown): Record<string, ToolCacheState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, ToolCacheState> = {};
  for (const [id, cache] of Object.entries(value)) {
    if (!id.trim()) continue;
    out[id] = normalizeToolCacheState(cache);
  }
  return out;
}

function normalizeToolCacheState(value: unknown): ToolCacheState {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    produces: record.produces === true,
    kinds: Array.isArray(record.kinds) ? record.kinds.filter((kind): kind is string => typeof kind === 'string' && kind.trim().length > 0) : [],
    capture: record.capture === 'none' ? 'none' : 'auto',
  };
}

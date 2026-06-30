import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_PROJECTS_ROOT = join(homedir(), '.zleap', 'project');

const HOME = resolve(homedir());

export function defaultSkillsRoot(): string {
  return process.env.ZLEAP_WEB_SKILLS_ROOT ?? join(homedir(), 'Documents', 'Zleap', 'skills');
}

export function resolveBrowsePath(input?: string): string {
  const raw = input?.trim() || DEFAULT_PROJECTS_ROOT;
  const resolved = resolve(raw);
  if (!resolved.startsWith(HOME)) {
    throw new Error('path_not_allowed');
  }
  return resolved;
}

export type BrowseEntry = { name: string; path: string };

export async function browseDirectories(inputPath?: string): Promise<{
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}> {
  const current = resolveBrowsePath(inputPath);
  const info = await stat(current);
  if (!info.isDirectory()) {
    throw new Error('not_a_directory');
  }

  const parent = dirname(current);
  const parentResolved = resolve(parent);
  const entries = await readdir(current, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: current,
    parent: parentResolved.startsWith(HOME) && parentResolved !== current ? parentResolved : null,
    entries: dirs,
  };
}

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Web-owned project registry — a small JSON file under the home dir. This is the
 * web config "bypass" (docs/core.md §7): the core runtime doesn't depend on it.
 * A project is a registered working directory + a free-form spec (project.md,
 * the analogue of AGENT.md). Swap to the DB store when it lands.
 */
export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  note?: string;
  /** project.md — conventions/requirements the agent follows in this project. */
  spec?: string;
  /** Sidebar icon emoji; omit for name initial on accent. */
  emoji?: string;
  accent?: string;
  createdAt: string;
  updatedAt: string;
};

function storePath(): string {
  return process.env.ZLEAP_WEB_PROJECTS_PATH ?? join(homedir(), '.zleap', 'projects.json');
}

async function readAll(): Promise<ProjectRecord[]> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(records: ProjectRecord[]): Promise<void> {
  const file = storePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(records, null, 2), 'utf8');
}

export const projectStore = {
  list: readAll,
  async create(input: { id: string; name: string; path: string; note?: string }): Promise<ProjectRecord> {
    const all = await readAll();
    if (all.some((p) => p.id === input.id)) {
      throw new Error(`project "${input.id}" already exists`);
    }
    const now = new Date().toISOString();
    const record: ProjectRecord = { ...input, spec: '', createdAt: now, updatedAt: now };
    await writeAll([...all, record]);
    return record;
  },
  async update(
    id: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'path' | 'note' | 'spec' | 'emoji' | 'accent'>>,
  ): Promise<ProjectRecord> {
    const all = await readAll();
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new Error(`project "${id}" not found`);
    }
    const next = { ...all[idx]!, ...patch, updatedAt: new Date().toISOString() };
    all[idx] = next;
    await writeAll(all);
    return next;
  },
  async remove(id: string): Promise<void> {
    const all = await readAll();
    await writeAll(all.filter((p) => p.id !== id));
  },
  async clear(): Promise<void> {
    await rm(storePath(), { force: true });
  },
};

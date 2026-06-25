import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_ROUTES = new Set(['app/api/health/live/route.ts']);

describe('web API actor guard coverage', () => {
  it('requires every app/api route to declare an actor boundary', async () => {
    const apiRoot = join(process.cwd(), 'app', 'api');
    const routeFiles = await listRouteFiles(apiRoot);
    expect(routeFiles.length).toBeGreaterThan(0);

    const unguarded: string[] = [];
    for (const file of routeFiles) {
      const source = await readFile(file, 'utf8');
      const rel = relative(process.cwd(), file);
      if (!source.includes('requireHttpActor(') && !PUBLIC_ROUTES.has(rel)) {
        unguarded.push(rel);
      }
    }

    expect(unguarded).toEqual([]);
  });
});

async function listRouteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listRouteFiles(path);
      }
      return entry.isFile() && entry.name === 'route.ts' ? [path] : [];
    }),
  );
  return files.flat().sort();
}

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config as loadEnvFile } from 'dotenv';

function zleapHome(): string {
  return process.env.ZLEAP_HOME ?? join(homedir(), '.zleap');
}

/** Load `.env` / `.env.local` walking up from cwd, plus `~/.zleap/.env` (aligned with runtime). */
export function loadDotEnv(): void {
  loadProjectEnv();
}

export function loadProjectEnv(startDir = process.cwd()): void {
  const dirs: string[] = [];
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    dirs.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    for (const name of ['.env', '.env.local']) {
      const file = join(d, name);
      if (existsSync(file)) {
        loadEnvFile({ path: file, override: true, quiet: true });
      }
    }
  }
  const homeEnv = join(zleapHome(), '.env');
  if (existsSync(homeEnv)) {
    loadEnvFile({ path: homeEnv, override: false, quiet: true });
  }
}

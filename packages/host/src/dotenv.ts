import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { resolveRepoRoot, zleapHome } from './paths.js';

/** Load `.env` from repo root, bundled app root, and `~/.zleap/.env`. */
export function loadServeEnvFiles(repoRoot?: string): void {
  const root = repoRoot ?? resolveRepoRoot();
  const candidates = [join(root, '.env.local'), join(root, '.env'), join(zleapHome(), '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadEnvFile({ path: file, override: false, quiet: true });
    }
  }
}

import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every local + LAN IPv4 of this machine, so opening the dev server via a LAN IP
// (not just localhost) still loads the `_next` client chunks. Auto-detected — no
// hardcoded address. Without it Next 16 blocks the cross-origin dev resources and
// the client never hydrates (page renders SSR but is non-interactive).
function localDevOrigins() {
  const origins = ['localhost', '127.0.0.1'];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        origins.push(addr.address);
      }
    }
  }
  return origins;
}

// Next only auto-loads .env from this package dir, but the project keeps model
// creds in the monorepo root .env. Load it here (without overwriting anything
// already set) so /api/chat can see LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
function loadRootEnv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(resolve(here, '../../.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue; // skips blank and # comment lines
      const key = match[1];
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // no root .env — fall back to faux-fast
  }
}

loadRootEnv();

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  // Allow Next standalone tracing to include server-side workspace and database
  // dependencies from the monorepo root.
  allowedDevOrigins: localDevOrigins(),
};

export default nextConfig;

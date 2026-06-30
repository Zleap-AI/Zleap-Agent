import { runQuiet } from './process.js';

export type PnpmRef = { command: string; argsPrefix: string[] };

export async function resolvePnpm(): Promise<PnpmRef> {
  const configured = process.env.ZLEAP_PNPM_BIN;
  if (configured) {
    return { command: configured, argsPrefix: [] };
  }
  if (await runQuiet('pnpm', ['--version'])) {
    return { command: 'pnpm', argsPrefix: [] };
  }
  if (await runQuiet('npx', ['--yes', 'pnpm', '--version'])) {
    return { command: 'npx', argsPrefix: ['--yes', 'pnpm'] };
  }
  throw new Error('pnpm is required. Install pnpm or set ZLEAP_PNPM_BIN to a pnpm-compatible executable.');
}

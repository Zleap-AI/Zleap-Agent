#!/usr/bin/env node
import './clear-ci.js';
import { loadDotEnv } from './dotenv.js';

const SUBCOMMANDS = new Set([
  'app',
  'channels',
  'config',
  'connect',
  'doctor',
  'init',
  'rollback',
  'serve',
  'setup',
  'status',
  'stop',
  'uninstall',
  'update',
  'upgrade',
]);

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2).filter((arg) => arg !== '--');

  if (args.length === 0) {
    const { runDefaultChat } = await import('./chat/mode.js');
    await runDefaultChat([]);
    return;
  }

  const head = args[0];
  if (head === '--help' || head === '-h' || head === '--version' || head === '-v' || (head && SUBCOMMANDS.has(head))) {
    const { runCli } = await import('./cli/router.js');
    await runCli(args);
    return;
  }

  const { runDefaultChat } = await import('./chat/mode.js');
  await runDefaultChat(args);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

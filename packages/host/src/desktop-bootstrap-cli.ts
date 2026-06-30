#!/usr/bin/env node
import { runDesktopBootstrap, type BootstrapStep } from './desktop-bootstrap.js';

const jsonMode = process.argv.includes('--json');

function emit(step: BootstrapStep): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(step)}\n`);
  } else {
    process.stdout.write(`${step.message}\n`);
  }
}

runDesktopBootstrap({
  bundledRoot: process.env.ZLEAP_BUNDLED_ROOT,
  payloadDir: process.env.ZLEAP_BUNDLED_PAYLOAD,
  downloadIfMissing: process.env.ZLEAP_DESKTOP_DOWNLOAD === '1',
  startServe: !process.argv.includes('--no-serve'),
  autoUpdate: process.env.ZLEAP_DESKTOP_AUTO_UPDATE === '1',
  onProgress: emit,
}).then((result) => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ...result, step: 'result' })}\n`);
  } else if (!result.ok) {
    process.stderr.write(`${result.error ?? 'bootstrap failed'}\n`);
  }
  process.exit(result.ok ? 0 : 1);
});

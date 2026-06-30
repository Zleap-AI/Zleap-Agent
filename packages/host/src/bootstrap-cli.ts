import { finishInstall, type FinishInstallOptions } from './lifecycle.js';

const args = process.argv.slice(2);
const options: FinishInstallOptions = {
  method: 'cli',
  startServe: !args.includes('--no-serve'),
  openBrowser: !args.includes('--no-open'),
};

if (process.env.ZLEAP_VERSION) {
  options.version = process.env.ZLEAP_VERSION;
}
if (process.env.ZLEAP_PLATFORM) {
  options.platform = process.env.ZLEAP_PLATFORM;
}

finishInstall(options).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

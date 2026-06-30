import { runSetupFlow } from '@zleap/host';

export async function runSetup(): Promise<number> {
  return runSetupFlow({ openBrowser: true });
}

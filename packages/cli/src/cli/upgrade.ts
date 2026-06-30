import { runUpdateCommand } from './update.js';

export type UpgradeCommandOptions = {
  version?: string;
  check?: boolean;
};

/** @deprecated Use runUpdateCommand */
export async function runUpgradeCommand(options: UpgradeCommandOptions = {}): Promise<number> {
  return runUpdateCommand({
    version: options.version,
    checkOnly: options.check,
  });
}

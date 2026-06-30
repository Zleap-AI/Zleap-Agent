import { runRollback, type RollbackOptions } from '@zleap/host';

export type RollbackCommandOptions = RollbackOptions;

export async function runRollbackCommand(options: RollbackCommandOptions = {}): Promise<number> {
  try {
    const result = await runRollback({ restart: true, ...options });
    process.stdout.write(`已回滚到 ${result.newVersion}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

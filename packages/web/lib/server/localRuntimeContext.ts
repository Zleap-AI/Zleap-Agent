import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string | Buffer }>;

const execFileAsync = promisify(execFile) as ExecFileLike;

export type LocalRuntimeContext = {
  mode: 'local';
  availableModes: ['local'];
  branch?: string;
};

export async function getLocalRuntimeContext(cwd = process.cwd()): Promise<LocalRuntimeContext> {
  return {
    mode: 'local',
    availableModes: ['local'],
    branch: await readGitBranch(cwd),
  };
}

export async function readGitBranch(cwd = process.cwd(), runner: ExecFileLike = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 1000 });
    const branch = String(stdout).trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

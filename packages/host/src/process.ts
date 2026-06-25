import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions['stdio'];
  shell?: boolean;
};

export function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return runProcess(command, args, { ...options, stdio: options.stdio ?? 'inherit' });
}

export function runQuiet(command: string, args: string[], options: RunOptions = {}): Promise<boolean> {
  return runProcess(command, args, { ...options, stdio: 'ignore' }).then(
    () => true,
    () => false,
  );
}

export function runCapture(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export function spawnDetached(
  command: string,
  args: string[],
  options: RunOptions = {},
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    shell: options.shell ?? false,
    detached: process.platform !== 'win32',
  });
}

export function runForeground(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnDetached(command, args, options);
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      if (code === 0 || signal) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.once('error', reject);
  });
}

function runProcess(command: string, args: string[], options: RunOptions & { stdio: SpawnOptions['stdio'] }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

#!/usr/bin/env node
import { buildServeEnv, webUrl } from './env.js';
import { healthCheck, readServeState, stopServe } from './supervisor.js';
import { restartServe } from './service/manager.js';
import { runRollback } from './update-engine.js';

const [command = 'status', ...args] = process.argv.slice(2);

main(command, args).then((code) => {
  process.exit(code);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

async function main(cmd: string, args: string[]): Promise<number> {
  if (cmd === 'status') {
    return status();
  }
  if (cmd === 'stop') {
    return stop(args);
  }
  if (cmd === 'restart') {
    await restartServe();
    process.stdout.write(`服务已重启：${webUrl(buildServeEnv())}\n`);
    return 0;
  }
  if (cmd === 'update') {
    process.stdout.write('control-cli 不再从远程下载 runtime；请通过 npm 更新 CLI，或安装新版 Desktop。\n');
    return 0;
  }
  if (cmd === 'rollback') {
    const result = await runRollback({ restart: !args.includes('--no-restart') });
    process.stdout.write(`已回滚到 ${result.newVersion}\n`);
    return 0;
  }
  process.stderr.write('Usage: control-cli <status|stop|restart|update|rollback>\n');
  return 1;
}

async function status(): Promise<number> {
  const env = buildServeEnv();
  const state = await readServeState();
  const health = await healthCheck(env);
  if (state) {
    process.stdout.write(`Web: ${state.webUrl}\n`);
    process.stdout.write(`Mode: ${state.mode}\n`);
    for (const svc of state.services) {
      process.stdout.write(`${svc.name}: ${svc.pid ?? '-'}\n`);
    }
  } else {
    process.stdout.write('Zleap services are not running\n');
  }
  process.stdout.write(`Postgres: ${health.postgres.ok ? 'ok' : 'fail'} ${health.postgres.detail}\n`);
  process.stdout.write(`Web: ${health.web.ok ? 'ok' : 'fail'} ${health.web.detail}\n`);
  process.stdout.write(`Worker: ${health.worker.ok ? 'ok' : 'fail'} ${health.worker.detail}\n`);
  process.stdout.write(`Gateway: ${health.gateway.ok ? 'ok' : 'fail'} ${health.gateway.detail}\n`);
  return health.web.ok ? 0 : 1;
}

async function stop(args: string[]): Promise<number> {
  const onlyIfSessionOwned = args.includes('--desktop-session-only');
  const sessionIndex = args.indexOf('--session-id');
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
  const result = await stopServe({
    onlyIfSessionOwned,
    sessionId,
    startedBy: onlyIfSessionOwned ? 'desktop' : undefined,
  });
  if (result.skipped) {
    process.stdout.write(`${result.skipped}\n`);
    return 0;
  }
  if (result.missing) {
    process.stdout.write('未找到运行中的 Zleap 服务\n');
    return 0;
  }
  process.stdout.write(result.stopped.length > 0 ? `已停止：${result.stopped.join(', ')}\n` : '已清理服务状态\n');
  return 0;
}

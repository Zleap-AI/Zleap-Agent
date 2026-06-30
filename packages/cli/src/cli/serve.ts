import {
  buildServeEnv,
  healthCheck,
  installUserService,
  isBundledInstall,
  readServeState,
  runServe,
  startDetachedServe,
  stopServe,
  webUrl,
} from '@zleap/host';
import { formatChannelsStatusSummary } from './channels.js';

export type ServeCommandOptions = {
  production?: boolean;
  gateway?: boolean;
  skipPostgres?: boolean;
  skipBuild?: boolean;
  detach?: boolean;
  installService?: boolean;
};

export async function runServeCommand(options: ServeCommandOptions = {}): Promise<number> {
  const baseEnv = buildServeEnv();
  const mode =
    options.production || baseEnv.ZLEAP_SERVE_MODE === 'production' || isBundledInstall() ? 'production' : 'dev';
  const env = buildServeEnv({ ZLEAP_SERVE_MODE: mode });

  if (options.installService) {
    await installUserService(env);
    return 0;
  }

  if (options.detach || mode === 'production') {
    process.stdout.write(`正在后台启动 Zleap 本地栈（${mode}${options.gateway ? ' + gateway' : ''}）…\n`);
    await startDetachedServe({ env, gateway: options.gateway ?? env.ZLEAP_GATEWAY === '1' });
    process.stdout.write(`服务已在后台启动，日志见 ~/.zleap/logs/serve.log\n`);
    process.stdout.write(`Web: ${webUrl(env)}\n`);
    return 0;
  }

  process.stdout.write(`正在启动 Zleap 本地栈（${mode}${options.gateway ? ' + gateway' : ''}）…\n`);
  return runServe({
    mode,
    gateway: options.gateway,
    skipPostgres: options.skipPostgres,
    skipBuild: options.skipBuild,
  });
}

export async function runStatusCommand(): Promise<number> {
  const env = buildServeEnv();
  const state = await readServeState();
  const health = await healthCheck(env);

  process.stdout.write('\nZleap 服务状态\n\n');
  if (state) {
    process.stdout.write(`启动时间  ${state.startedAt}\n`);
    process.stdout.write(`模式      ${state.mode}\n`);
    process.stdout.write(`Web       ${state.webUrl}\n`);
    for (const svc of state.services) {
      process.stdout.write(`  ${svc.name.padEnd(8)} pid ${svc.pid ?? '-'}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write('未找到 ~/.zleap/state/serve.json（可能未通过 zleap serve 启动）\n\n');
  }

  const rows: Array<[string, boolean, string]> = [
    ['Postgres', health.postgres.ok, health.postgres.detail],
    ['Web', health.web.ok, `${health.web.detail} · ${health.web.url}`],
    ['Worker', health.worker.ok, health.worker.detail],
    ['Gateway', health.gateway.ok, health.gateway.detail],
  ];
  for (const [name, ok, detail] of rows) {
    process.stdout.write(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${detail}\n`);
  }
  const channels = await formatChannelsStatusSummary();
  if (channels) {
    process.stdout.write(`\n${channels}\n`);
  }
  process.stdout.write(`\n打开 Web：${webUrl(env)}\n\n`);
  return health.postgres.ok && health.web.ok ? 0 : 1;
}

export async function runStopCommand(): Promise<number> {
  const result = await stopServe();
  if (result.missing) {
    if (result.stopped.length > 0) {
      process.stdout.write(`已停止残留进程：${result.stopped.join(', ')}\n`);
      return 0;
    }
    process.stdout.write('未找到运行中的 Zleap 服务\n');
    return 1;
  }
  if (result.stopped.length === 0) {
    process.stdout.write('已清除 serve 状态，但未找到存活进程\n');
    return 0;
  }
  process.stdout.write(`已停止：${result.stopped.join(', ')}\n`);
  return 0;
}

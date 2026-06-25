import cac from 'cac';
import { readCliVersion } from '../util/version.js';

function printHelp(): void {
  process.stdout.write(`zleap/${readCliVersion()}

用法：
  zleap [prompt]              交互式 TUI 或一次性对话
  zleap serve [选项]          启动本地栈（Postgres + Web + Worker）
  zleap stop                  停止 zleap serve 启动的进程
  zleap status                查看服务健康状态
  zleap update [--check]      查看 npm/Desktop 更新方式
  zleap rollback              回滚到上一版本
  zleap setup                 打开配置向导（Web onboarding）
  zleap app                   启动并打开 Web 控制台
  zleap init                  首次配置向导（CLI，兼容旧版）
  zleap doctor [--json]       环境体检
  zleap uninstall [--full]    卸载 App runtime（保留数据）；--full 删除全部 ~/.zleap
  zleap config <子命令>       管理 ~/.zleap/config.json
  zleap channels <子命令>     IM 频道连接
  zleap connect <channel>     连接频道（channels connect 别名）

serve 选项：
  --gateway           同时启动 IM gateway
  --production        生产模式（默认后台 detach）
  --detach            后台运行
  --install-service   注册 launchd/systemd 用户服务（macOS/Linux）
  --skip-postgres     跳过 Postgres 引导
  --skip-build        跳过构建

示例：
  zleap setup
  zleap update --check
  zleap rollback
`);
}

export async function runCli(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${readCliVersion()}\n`);
    return;
  }

  const cli = cac('zleap');

  cli
    .command('serve', '启动本地栈（Postgres + Web + Worker）')
    .option('--gateway', '同时启动 IM gateway')
    .option('--production', '生产模式')
    .option('--detach', '后台运行')
    .option('--install-service', '注册系统用户服务')
    .option('--skip-postgres', '跳过 Postgres 引导')
    .option('--skip-build', '跳过构建')
    .action(async (options: {
      gateway?: boolean;
      production?: boolean;
      detach?: boolean;
      installService?: boolean;
      skipPostgres?: boolean;
      skipBuild?: boolean;
    }) => {
      const { runServeCommand } = await import('./serve.js');
      process.exitCode = await runServeCommand({
        gateway: options.gateway,
        production: options.production,
        detach: options.detach,
        installService: options.installService,
        skipPostgres: options.skipPostgres,
        skipBuild: options.skipBuild,
      });
    });

  cli.command('status', '查看 Zleap 服务健康状态').action(async () => {
    const { runStatusCommand } = await import('./serve.js');
    process.exitCode = await runStatusCommand();
  });

  cli.command('stop', '停止 zleap serve 启动的本地栈').action(async () => {
    const { runStopCommand } = await import('./serve.js');
    process.exitCode = await runStopCommand();
  });

  cli
    .command('update', '显示 npm/Desktop 官方更新方式')
    .option('--version <ver>', '指定版本号')
    .option('--check', '仅检查是否有新版本')
    .action(async (options: {
      version?: string;
      check?: boolean;
    }) => {
      const { runUpdateCommand } = await import('./update.js');
      process.exitCode = await runUpdateCommand({
        version: options.version,
        checkOnly: options.check,
      });
    });

  cli
    .command('rollback', '回滚 App runtime 到上一版本')
    .option('--allow-downgrade', '允许回滚到低于当前版本的 runtime')
    .option('--allow-schema-downgrade', '允许 schemaVersion 降级（危险）')
    .option('--ignore-active-tasks', '忽略 queued/running 定时任务保护')
    .action(async (options: {
      allowDowngrade?: boolean;
      allowSchemaDowngrade?: boolean;
      ignoreActiveTasks?: boolean;
    }) => {
      const { runRollbackCommand } = await import('./rollback.js');
      process.exitCode = await runRollbackCommand({
        allowDowngrade: options.allowDowngrade,
        allowSchemaDowngrade: options.allowSchemaDowngrade,
        ignoreActiveTasks: options.ignoreActiveTasks,
      });
    });

  cli
    .command('upgrade', 'update 的别名')
    .option('--version <ver>', '指定版本号')
    .option('--check', '仅检查')
    .action(async (options: {
      version?: string;
      check?: boolean;
    }) => {
      const { runUpgradeCommand } = await import('./upgrade.js');
      process.exitCode = await runUpgradeCommand({
        version: options.version,
        check: options.check,
      });
    });

  cli.command('setup', '启动服务并打开 Web 配置向导').action(async () => {
    const { runSetup } = await import('./setup.js');
    process.exitCode = await runSetup();
  });

  cli.command('app', '启动服务并打开 Web 控制台').action(async () => {
    const { runSetup } = await import('./setup.js');
    process.exitCode = await runSetup();
  });

  cli
    .command('init', '交互式首次配置（数据库、模型）')
    .option('--force', '重置 onboarded 并忽略损坏的 config.json')
    .option('--from-env', '从 .env / 环境变量导入模型与数据库')
    .action(async (options: { force?: boolean; fromEnv?: boolean }) => {
      const { runInit } = await import('./init.js');
      await runInit({ force: options.force, fromEnv: options.fromEnv });
    });

  cli
    .command('doctor', '环境体检（Node、数据库、模型、gateway）')
    .option('--json', 'JSON 输出')
    .action(async (options: { json?: boolean }) => {
      const { runDoctor } = await import('./doctor.js');
      process.exitCode = await runDoctor({ json: options.json });
    });

  cli
    .command('uninstall', '卸载 App runtime')
    .option('--gui', '仅提示删除桌面 App')
    .option('--full', '删除整个 ~/.zleap（含数据库）')
    .option('--yes', '跳过确认（配合 --full）')
    .action(async (options: { gui?: boolean; full?: boolean; yes?: boolean }) => {
      const { runUninstallCommand } = await import('./uninstall.js');
      process.exitCode = await runUninstallCommand(options);
    });

  cli.command('config <subcommand...>', '管理 ~/.zleap/config.json').action(async (subcommand: string[]) => {
    const { runConfigCommand } = await import('./config-cmd.js');
    await runConfigCommand(subcommand);
  });

  cli.command('channels <subcommand...>', 'IM 频道连接（feishu / wechat / feishu-cli）').action(async (subcommand: string[]) => {
    const { runChannelsCommand } = await import('./channels.js');
    await runChannelsCommand(subcommand);
  });

  cli
    .command('connect <channel>', '连接 IM 频道（channels connect 的别名）')
    .option('--refresh', '刷新 QR / 授权链接')
    .option('--logout', '退出登录')
    .action(async (channel: string, options: { refresh?: boolean; logout?: boolean }) => {
      const { runChannelsCommand } = await import('./channels.js');
      const action = options.logout ? 'logout' : options.refresh ? 'refresh' : 'connect';
      await runChannelsCommand([action, channel]);
    });

  cli.parse(['node', 'zleap', ...argv], { run: false });
  await cli.runMatchedCommand();
}

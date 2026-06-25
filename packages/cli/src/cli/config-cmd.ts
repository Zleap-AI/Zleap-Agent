import { spawnSync } from 'node:child_process';
import {
  CONFIG_PATH,
  envKeyForConfigPath,
  flattenConfig,
  getConfigValue,
  loadConfig,
  loadConfigWithMeta,
  saveConfig,
  setConfigValue,
  trackedEnvEntries,
} from '@zleap/host';
import { resolveCliContext, modelSourceLabel } from './context.js';

export async function runConfigCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help') {
    printConfigHelp();
    return;
  }
  if (sub === 'path') {
    process.stdout.write(`${CONFIG_PATH}\n`);
    return;
  }
  if (sub === 'list') {
    await runConfigList();
    return;
  }
  if (sub === 'get') {
    await runConfigGet(rest[0]);
    return;
  }
  if (sub === 'set') {
    await runConfigSet(rest[0], rest.slice(1).join(' '));
    return;
  }
  if (sub === 'edit') {
    runConfigEdit();
    return;
  }
  process.stderr.write(`未知子命令：config ${sub}\n`);
  printConfigHelp();
  process.exitCode = 1;
}

async function runConfigList(): Promise<void> {
  const { config, parseError } = await loadConfigWithMeta();
  process.stdout.write(`配置文件：${CONFIG_PATH}\n`);
  if (parseError) {
    process.stdout.write(`⚠ ${parseError}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write('[ config.json ]\n');
  const rows = flattenConfig(config);
  if (rows.length === 0) {
    process.stdout.write('  （空）\n');
  } else {
    for (const row of rows) {
      process.stdout.write(`  ${row.key.padEnd(22)} ${row.value}\n`);
    }
  }
  const ctx = await resolveCliContext();
  process.stdout.write('\n[ 当前生效 ]\n');
  process.stdout.write(`  model                ${ctx.model?.displayName ?? ctx.model?.model ?? '—'} (${modelSourceLabel(ctx.modelSource)})\n`);
  process.stdout.write(`  database.url         ${ctx.persistence.databaseUrl ? maskSecret(ctx.persistence.databaseUrl) : '—'}\n`);
  process.stdout.write('\n[ 环境变量 ]\n');
  for (const entry of trackedEnvEntries()) {
    const mark = entry.set ? '✓' : '·';
    process.stdout.write(`  ${mark} ${entry.key.padEnd(24)} ${entry.value}\n`);
  }
}

async function runConfigGet(path: string | undefined): Promise<void> {
  if (!path) {
    process.stderr.write('用法：zleap config get <path>\n');
    process.exitCode = 1;
    return;
  }
  const envKey = envKeyForConfigPath(path) ?? path.toUpperCase().replace(/\./g, '_');
  if (process.env[envKey]) {
    const masked = /SECRET|KEY|PASSWORD|TOKEN/i.test(envKey) ? '***' : process.env[envKey];
    process.stdout.write(`${masked}  (env: ${envKey})\n`);
    return;
  }
  const { config, parseError } = await loadConfigWithMeta();
  if (parseError) {
    process.stderr.write(`${parseError}\n`);
    process.exitCode = 1;
    return;
  }
  const value = getConfigValue(config, path);
  if (value === undefined) {
    process.stderr.write(`未找到：${path}\n`);
    process.exitCode = 1;
    return;
  }
  if (typeof value === 'object') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    const masked = /secret|apikey|api_key|password|token/i.test(path) && String(value).length > 0 ? '***' : String(value);
    process.stdout.write(`${masked}\n`);
  }
}

async function runConfigSet(path: string | undefined, rawValue: string | undefined): Promise<void> {
  if (!path || rawValue === undefined || rawValue === '') {
    process.stderr.write('用法：zleap config set <path> <value>\n');
    process.exitCode = 1;
    return;
  }
  const { config, parseError } = await loadConfigWithMeta();
  if (parseError) {
    process.stderr.write(`${parseError}\n`);
    process.stderr.write('请先修复 config.json 或使用 zleap init --force 重置。\n');
    process.exitCode = 1;
    return;
  }
  let parsed: unknown = rawValue;
  if (rawValue === 'true') parsed = true;
  else if (rawValue === 'false') parsed = false;
  else if (/^\d+$/.test(rawValue)) parsed = Number(rawValue);
  const next = setConfigValue(config, path, parsed);
  await saveConfig(next);
  process.stdout.write(`已写入 ${path}\n`);
}

function runConfigEdit(): void {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const result = spawnSync(editor, [CONFIG_PATH], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

function maskSecret(value: string): string {
  return /:([^:@/]+)@/.test(value) ? value.replace(/:([^:@/]+)@/, ':***@') : value;
}

function printConfigHelp(): void {
  process.stdout.write(`用法：zleap config <子命令>

子命令：
  path              打印 config.json 路径
  list              列出 config.json、生效值与关键环境变量
  get <path>        读取配置项（如 model.baseUrl）
  set <path> <val>  写入 config.json
  edit              用 $EDITOR 打开 config.json
`);
}

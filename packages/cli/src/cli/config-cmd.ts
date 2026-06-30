import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_302_API_BASE_URL,
  DEFAULT_302_MODEL_BASE_URL,
  INTEGRATION_302_CHANNEL,
  resolveIntegration302Detailed,
  setIntegration302Store,
} from '@zleap/agent';
import { createSharedStore } from '@zleap/agent/conversation';
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
import { loadProjectEnv } from '../dotenv.js';

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
  if (sub === '302') {
    await run302ConfigCommand(rest);
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

async function run302ConfigCommand(argv: string[]): Promise<void> {
  const [sub = 'status', ...rest] = argv;
  if (sub === 'help' || sub === '--help') {
    print302ConfigHelp();
    return;
  }
  if (sub === 'setup') {
    await reportConfigError(() => run302Setup(rest));
    return;
  }
  if (sub === 'status') {
    await reportConfigError(run302Status);
    return;
  }
  if (sub === 'clear') {
    await reportConfigError(run302Clear);
    return;
  }
  process.stderr.write(`未知子命令：config 302 ${sub}\n`);
  print302ConfigHelp();
  process.exitCode = 1;
}

async function reportConfigError(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function run302Setup(argv: string[]): Promise<void> {
  const options = parseFlagOptions([...argv, ...currentConfig302Args()]);
  const existing = await with302Store(async () => resolveIntegration302Detailed());
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (!interactive && !options.apiKey && !existing.apiKey) {
    process.stderr.write('非交互环境请传入 --api-key <key>。\n');
    process.exitCode = 1;
    return;
  }

  const apiBaseUrl = normalizeBaseUrl(
    options.apiBaseUrl ?? (interactive ? await promptLine('API Base URL', existing.apiBaseUrl || DEFAULT_302_API_BASE_URL) : undefined),
    DEFAULT_302_API_BASE_URL,
  );
  const apiKey =
    options.apiKey ??
    (interactive
      ? await promptHidden(existing.apiKey ? 'API Key [已配置，直接 Enter 保留]: ' : 'API Key: ')
      : undefined) ??
    '';
  const modelBaseUrl = normalizeBaseUrl(
    options.modelBaseUrl ?? (interactive ? await promptLine('Model Base URL', existing.modelBaseUrl || DEFAULT_302_MODEL_BASE_URL) : undefined),
    DEFAULT_302_MODEL_BASE_URL,
  );
  const finalApiKey = apiKey.trim() || existing.apiKey;
  if (!finalApiKey) {
    process.stderr.write('API Key 不能为空。\n');
    process.exitCode = 1;
    return;
  }

  await with302Store(async (store) => {
    await store.integrations.saveIntegration({
      channel: INTEGRATION_302_CHANNEL,
      config: {
        apiKey: finalApiKey,
        apiBaseUrl,
        modelBaseUrl,
      },
      updatedAt: new Date(),
    });
  });

  process.stdout.write('302 通用配置已保存。\n');
  process.stdout.write(`  API Key        ${maskKey(finalApiKey)}\n`);
  process.stdout.write(`  API Base URL   ${apiBaseUrl}\n`);
  process.stdout.write(`  Model Base URL ${modelBaseUrl}\n`);
}

async function run302Status(): Promise<void> {
  loadProjectEnv();
  const store = await createSharedStore({ onWarn: () => undefined });
  let resolved;
  try {
    resolved = await resolveIntegration302Detailed();
  } finally {
    await store?.close().catch(() => undefined);
    setIntegration302Store(undefined);
  }
  process.stdout.write('302 通用配置：\n');
  process.stdout.write(`  API Key        ${resolved.apiKey ? `已配置 (${sourceLabel(resolved.source.apiKey)})` : '未配置'}\n`);
  process.stdout.write(`  API Base URL   ${resolved.apiBaseUrl} (${sourceLabel(resolved.source.apiBaseUrl)})\n`);
  process.stdout.write(`  Model Base URL ${resolved.modelBaseUrl} (${sourceLabel(resolved.source.modelBaseUrl)})\n`);
}

async function run302Clear(): Promise<void> {
  await with302Store(async (store) => {
    await store.integrations.deleteIntegration(INTEGRATION_302_CHANNEL);
  });
  process.stdout.write('已清除 DB 中的 302 通用配置；环境变量和 legacy 文件不会被修改。\n');
}

async function with302Store<T>(fn: (store: NonNullable<Awaited<ReturnType<typeof createSharedStore>>>) => Promise<T>): Promise<T> {
  loadProjectEnv();
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    throw new Error('无法连接本地数据库，不能读写 302 通用配置。请先运行 zleap setup 或 zleap serve。');
  }
  try {
    return await fn(store);
  } finally {
    await store.close().catch(() => undefined);
    setIntegration302Store(undefined);
  }
}

function parseFlagOptions(argv: string[]): { apiKey?: string; apiBaseUrl?: string; modelBaseUrl?: string } {
  const options: { apiKey?: string; apiBaseUrl?: string; modelBaseUrl?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--api-key' && next) {
      options.apiKey = next;
      i += 1;
    } else if (arg === '--api-base-url' && next) {
      options.apiBaseUrl = next;
      i += 1;
    } else if (arg === '--model-base-url' && next) {
      options.modelBaseUrl = next;
      i += 1;
    }
  }
  return options;
}

function currentConfig302Args(): string[] {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('config');
  if (configIndex < 0 || args[configIndex + 1] !== '302') {
    return [];
  }
  return args.slice(configIndex + 2);
}

async function promptLine(label: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${label} [${defaultValue}]: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(label)).trim();
    } finally {
      rl.close();
    }
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const chars: string[] = [];
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(chars.join('').trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          if (chars.length > 0) {
            chars.pop();
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          chars.push(String.fromCharCode(byte));
          process.stdout.write('*');
        }
      }
    };
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    return raw.replace(/\/+$/, '');
  } catch {
    throw new Error(`无效 URL：${raw}`);
  }
}

function maskKey(value: string): string {
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'db':
      return 'DB';
    case 'env':
      return 'env';
    case 'file':
      return 'legacy file';
    case 'default':
      return 'default';
    default:
      return 'none';
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
  302 setup         配置 302 API Key / Base URL（写入数据库）
  302 status        查看 302 通用配置来源
  302 clear         清除数据库里的 302 通用配置
`);
}

function print302ConfigHelp(): void {
  process.stdout.write(`用法：zleap config 302 <子命令>

子命令：
  setup             交互式写入 302 通用配置
  status            查看 Key / API Base URL / Model Base URL 及来源
  clear             清除数据库中的 302 配置（不修改 env / legacy file）

选项：
  --api-key <key>
  --api-base-url <url>
  --model-base-url <url>
`);
}

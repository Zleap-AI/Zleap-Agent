import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DEFAULT_DATABASE_URL } from '@zleap/host';
import { modelFromEnv } from '@zleap/agent/conversation';
import {
  loadConfigWithMeta,
  resolveConfiguredDatabaseUrl,
  resolvePersistence,
  saveConfig,
  type CliConfig,
} from '@zleap/host';
import { runModelWizardReadline } from '../wizard/modelWizard.js';
import { collectDoctorChecks } from './doctor.js';

export type InitOptions = {
  force?: boolean;
  fromEnv?: boolean;
};

export async function runInit(options: InitOptions = {}): Promise<void> {
  output.write('\n欢迎使用 Zleap — 首次配置向导\n\n');
  const loaded = await loadConfigWithMeta();
  if (loaded.parseError && !options.force) {
    output.write(`⚠ ${loaded.parseError}\n`);
    output.write('运行 zleap init --force 可重置配置。\n\n');
  }
  let config: CliConfig = options.force ? {} : { ...loaded.config };
  const rl = createInterface({ input, output });

  try {
    if (options.fromEnv) {
      config = applyEnvImport(config);
      output.write('已从环境变量导入模型与数据库配置。\n');
    }

    const configuredDatabaseUrl = resolveConfiguredDatabaseUrl(config);
    if (!configuredDatabaseUrl) {
      output.write(`未检测到数据库 URL。\n默认（docker-compose）：${DEFAULT_DATABASE_URL}\n`);
      output.write('输入数据库 URL（回车使用默认，输入 skip 跳过）：\n');
      const dbLine = (await rl.question('> ')).trim();
      if (dbLine.toLowerCase() !== 'skip' && dbLine.toLowerCase() !== 's') {
        const url = dbLine || DEFAULT_DATABASE_URL;
        config = { ...config, database: { url } };
        process.env.ZLEAP_DATABASE_URL = url;
        output.write('已设置 database.url\n');
      }
    } else {
      output.write(`已检测到数据库：${maskUrl(configuredDatabaseUrl)}\n`);
    }

    if (!config.model?.model) {
      output.write('\n配置 LLM 模型（OpenAI 兼容 API）：\n');
      rl.close();
      const withModel = await runModelWizardReadline();
      config = { ...config, ...withModel };
    } else {
      output.write(`已检测到模型：${config.model.displayName ?? config.model.model}\n`);
    }

    output.write('\nEmbedding：可在 Web 管理台或 .env 中配置 ZLEAP_EMBED_*；未配置时使用 faux embedding。\n');
    output.write('\nIM 频道：保存配置后运行 zleap serve --gateway，然后 zleap connect <channel>\n');

    config.onboarded = true;
    await saveConfig(config);
    output.write('\n✓ 配置已保存。运行 zleap doctor 检查环境，然后 zleap 进入对话。\n\n');

    const checks = await collectDoctorChecks();
    const failed = checks.filter((c) => !c.ok && c.critical !== false);
    if (failed.length > 0) {
      output.write('注意：以下关键项仍需处理：\n');
      for (const check of failed) {
        output.write(`  - ${check.name}: ${check.fix ?? check.detail}\n`);
      }
    }
  } finally {
    try {
      rl.close();
    } catch {
      // already closed before model wizard
    }
  }
}

function applyEnvImport(config: CliConfig): CliConfig {
  const envModel = modelFromEnv();
  const dbUrl = process.env.ZLEAP_DATABASE_URL ?? process.env.DATABASE_URL;
  let next = { ...config };
  if (envModel) {
    next = { ...next, model: envModel };
  }
  if (dbUrl?.trim()) {
    next = { ...next, database: { url: dbUrl.trim() } };
  }
  return next;
}

function maskUrl(url: string): string {
  return url.replace(/:([^:@/]+)@/, ':***@');
}

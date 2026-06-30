#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { ConnectionsService, ConversationService, createSharedStore } from '@zleap/agent/conversation';
import type { ZleapStore } from '@zleap/store';
import { FeishuAdapter, FEISHU_CHANNEL } from './platforms/feishu.js';
import { WeChatAdapter, WECHAT_CHANNEL } from './platforms/wechat/index.js';
import { DbWeChatSessionStore } from './platforms/wechat/session.js';
import { FeishuCliAdapter, FEISHU_CLI_CHANNEL } from './platforms/feishucli/index.js';
import { FileDedupStore } from './dedup.js';
import { GatewayRunner } from './runner.js';
import { ChannelSupervisor, type ChannelDescriptor } from './supervisor.js';
import {
  loadGatewayProcessConfig,
  resolveFeishuCliConfig,
  resolveFeishuConfig,
  resolveWeChatConfig,
  type FeishuCliConfig,
  type FeishuConfig,
  type WeChatConfig,
} from './config.js';
import type { GatewayLogger } from './types.js';

const logger: GatewayLogger = {
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};

function emit(level: string, message: string, meta?: Record<string, unknown>): void {
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const line = `[gateway:${level}] ${message}${suffix}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

function loadDotEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    for (const name of ['.env.local', '.env']) {
      const file = join(dir, name);
      if (existsSync(file)) {
        loadEnvFile({ path: file, override: false, quiet: true });
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function gatewayStateDir(): string {
  return process.env.ZLEAP_GATEWAY_STATE_DIR ?? join(homedir(), '.zleap', 'gateway');
}

function dedupPath(channel: string): string {
  return join(gatewayStateDir(), `${channel}_seen.json`);
}

async function main(): Promise<void> {
  loadDotEnv();

  // Shared, process-level store (one PG pool for every conversation). Embedding
  // config is data-first (DB default embedding row → env) and the default avatar
  // is seeded once here, since the injected store bypasses the engine's own seed.
  const store: ZleapStore | null = await createSharedStore({ onWarn: (message) => logger.warn(message) });
  if (!store) {
    throw new Error('ZLEAP_DATABASE_URL (or DATABASE_URL) is required for the Zleap gateway.');
  }

  const process_ = loadGatewayProcessConfig();
  const service = new ConversationService({
    store,
    maxConcurrent: process_.maxConcurrent,
  });
  const connections = new ConnectionsService(store.integrations);

  // Known-channel registry for the control plane. Each descriptor resolves its
  // desired config data-first (DB → env), so enabling/disabling/reconfiguring a
  // channel via the web settings UI is picked up by the reconcile loop without a
  // process restart. `hash` is the config fingerprint that triggers a restart.
  const descriptors: ChannelDescriptor[] = [
    {
      channel: FEISHU_CHANNEL,
      resolve: () => resolveFeishuConfig(store),
      hash: (config) => stableHash(config),
      permissionMode: (config) => (config as FeishuConfig).permissionMode,
      build: (config, publishState) =>
        new FeishuAdapter(config as FeishuConfig, {
          dedup: new FileDedupStore(dedupPath(FEISHU_CHANNEL)),
          logger,
          publishState,
        }),
    },
    {
      channel: WECHAT_CHANNEL,
      resolve: () => resolveWeChatConfig(store),
      hash: (config) => stableHash(config),
      permissionMode: (config) => (config as WeChatConfig).permissionMode,
      build: (config, publishState) =>
        new WeChatAdapter(config as WeChatConfig, {
          sessionStore: new DbWeChatSessionStore(store.integrations),
          dedup: new FileDedupStore(dedupPath(WECHAT_CHANNEL)),
          logger,
          publishState,
        }),
    },
    {
      channel: FEISHU_CLI_CHANNEL,
      resolve: async () => {
        const cli = await resolveFeishuCliConfig(store);
        return cli ? { ...cli, cliHome: cli.cliHome ?? join(gatewayStateDir(), 'feishu-cli-home') } : undefined;
      },
      hash: (config) => stableHash(config),
      permissionMode: (config) => (config as FeishuCliConfig).permissionMode,
      build: (config, publishState) =>
        new FeishuCliAdapter(config as FeishuCliConfig, {
          dedup: new FileDedupStore(dedupPath(FEISHU_CLI_CHANNEL)),
          logger,
          publishState,
        }),
    },
  ];

  const runner = new GatewayRunner({ service, logger });
  const supervisor = new ChannelSupervisor({ runner, connections, descriptors, logger });
  await supervisor.start();
  logger.info('zleap-gateway started (control plane)', { channels: descriptors.map((d) => d.channel) });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

/**
 * Fingerprint of a config object for restart detection. The resolvers build each
 * config with a fixed key order, so a plain stringify is stable across reads.
 */
function stableHash(config: unknown): string {
  return JSON.stringify(config);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

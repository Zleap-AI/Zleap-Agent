import { describe, expect, it } from 'vitest';
import { resolveLarkCliBin } from '../src/platforms/feishucli/cli.js';
import {
  feishuCliConfigFromRecord,
  feishuConfigFromRecord,
  resolveFeishuCliConfig,
  resolveFeishuConfig,
  resolveWeChatConfig,
  wechatConfigFromRecord,
  type GatewayIntegrationReader,
} from '../src/config.js';

function reader(config: Record<string, unknown> | undefined): GatewayIntegrationReader {
  return {
    integrations: {
      getIntegration: async () => (config ? { config } : undefined),
    },
  };
}

const ENV = {
  FEISHU_APP_ID: 'env_app',
  FEISHU_APP_SECRET: 'env_secret',
  FEISHU_GROUP_POLICY: 'allowlist',
} as unknown as NodeJS.ProcessEnv;

describe('feishuConfigFromRecord', () => {
  it('builds a config from a complete DB blob', () => {
    const config = feishuConfigFromRecord({
      appId: 'db_app',
      appSecret: 'db_secret',
      domain: 'lark',
      groupPolicy: 'blacklist',
      allowedUsers: ['ou_a', 'ou_b'],
      botName: 'zleap',
    });
    expect(config).toEqual({
      appId: 'db_app',
      appSecret: 'db_secret',
      domain: 'lark',
      encryptKey: undefined,
      verificationToken: undefined,
      groupPolicy: 'blacklist',
      allowedUsers: ['ou_a', 'ou_b'],
      botOpenId: undefined,
      botUserId: undefined,
      botName: 'zleap',
      permissionMode: 'request_approval',
    });
  });

  it('returns undefined when credentials are incomplete', () => {
    expect(feishuConfigFromRecord({ appId: 'db_app' })).toBeUndefined();
    expect(feishuConfigFromRecord({})).toBeUndefined();
  });

  it('reads full_access permission mode from the DB blob', () => {
    const config = feishuConfigFromRecord({
      appId: 'db_app',
      appSecret: 'db_secret',
      permissionMode: 'full_access',
    });
    expect(config?.permissionMode).toBe('full_access');
  });

  it('defaults permission mode to request_approval for unknown values', () => {
    const config = feishuConfigFromRecord({
      appId: 'db_app',
      appSecret: 'db_secret',
      permissionMode: 'wide_open',
    });
    expect(config?.permissionMode).toBe('request_approval');
  });
});

describe('resolveFeishuConfig', () => {
  it('prefers a complete DB config over env', async () => {
    const config = await resolveFeishuConfig(reader({ appId: 'db_app', appSecret: 'db_secret' }), ENV);
    expect(config?.appId).toBe('db_app');
    expect(config?.appSecret).toBe('db_secret');
  });

  it('falls back to env when the DB row is absent', async () => {
    const config = await resolveFeishuConfig(reader(undefined), ENV);
    expect(config?.appId).toBe('env_app');
    expect(config?.groupPolicy).toBe('allowlist');
  });

  it('falls back to env when the DB row is incomplete', async () => {
    const config = await resolveFeishuConfig(reader({ appId: 'db_app' }), ENV);
    expect(config?.appId).toBe('env_app');
  });

  it('degrades to env when the store read throws', async () => {
    const broken: GatewayIntegrationReader = {
      integrations: {
        getIntegration: async () => {
          throw new Error('db down');
        },
      },
    };
    const config = await resolveFeishuConfig(broken, ENV);
    expect(config?.appId).toBe('env_app');
  });
});

const WECHAT_ENV = {
  WECHAT_ENABLED: 'true',
  WECHAT_GROUP_POLICY: 'allowlist',
  WECHAT_PERMISSION_MODE: 'full_access',
} as unknown as NodeJS.ProcessEnv;

describe('wechatConfigFromRecord', () => {
  it('builds a config from an enabled DB blob with defaults', () => {
    const config = wechatConfigFromRecord({ enabled: true });
    expect(config).toMatchObject({
      enabled: true,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botType: 3,
      channelVersion: '1.0.2',
      groupPolicy: 'open',
      allowedUsers: [],
      permissionMode: 'request_approval',
    });
  });

  it('returns undefined when the channel is not enabled', () => {
    expect(wechatConfigFromRecord({})).toBeUndefined();
    expect(wechatConfigFromRecord({ enabled: false })).toBeUndefined();
  });

  it('reads policy/permission overrides and numeric bot type', () => {
    const config = wechatConfigFromRecord({
      enabled: true,
      groupPolicy: 'blacklist',
      permissionMode: 'full_access',
      botType: '7',
      allowedUsers: ['o_a@im.wechat', 'o_b@im.wechat'],
    });
    expect(config).toMatchObject({
      groupPolicy: 'blacklist',
      permissionMode: 'full_access',
      botType: 7,
      allowedUsers: ['o_a@im.wechat', 'o_b@im.wechat'],
    });
  });
});

describe('resolveWeChatConfig', () => {
  it('prefers an enabled DB config over env', async () => {
    const config = await resolveWeChatConfig(reader({ enabled: true, groupPolicy: 'open' }), WECHAT_ENV);
    expect(config?.enabled).toBe(true);
    expect(config?.groupPolicy).toBe('open');
  });

  it('falls back to env when the DB row is absent', async () => {
    const config = await resolveWeChatConfig(reader(undefined), WECHAT_ENV);
    expect(config?.groupPolicy).toBe('allowlist');
    expect(config?.permissionMode).toBe('full_access');
  });

  it('falls back to env when the DB row is disabled', async () => {
    const config = await resolveWeChatConfig(reader({ enabled: false }), WECHAT_ENV);
    expect(config?.groupPolicy).toBe('allowlist');
  });

  it('returns undefined when neither DB nor env enables the channel', async () => {
    const config = await resolveWeChatConfig(reader(undefined), {} as NodeJS.ProcessEnv);
    expect(config).toBeUndefined();
  });
});

const FEISHU_CLI_ENV = {
  FEISHU_CLI_ENABLED: 'true',
  FEISHU_CLI_IDENTITY: 'bot',
  FEISHU_CLI_GROUP_POLICY: 'open',
  FEISHU_CLI_PERMISSION_MODE: 'full_access',
  FEISHU_CLI_BIN: 'env-lark',
} as unknown as NodeJS.ProcessEnv;

describe('feishuCliConfigFromRecord', () => {
  it('builds a config from an enabled DB blob with defaults', () => {
    const config = feishuCliConfigFromRecord({ enabled: true }, {} as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      enabled: true,
      identity: 'user',
      domain: 'feishu',
      eventKey: 'im.message.receive_v1',
      groupPolicy: 'disabled',
      allowedUsers: [],
      permissionMode: 'request_approval',
      cliBin: resolveLarkCliBin(),
    });
    expect(config?.cliBin).toBe(resolveLarkCliBin());
  });

  it('returns undefined when the channel is not enabled', () => {
    expect(feishuCliConfigFromRecord({}, {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(feishuCliConfigFromRecord({ enabled: false }, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('reads identity/domain/permission overrides and app credentials', () => {
    const config = feishuCliConfigFromRecord(
      {
        enabled: true,
        identity: 'bot',
        domain: 'lark',
        permissionMode: 'full_access',
        groupPolicy: 'allowlist',
        allowedUsers: ['ou_a'],
        appId: 'cli_x',
        appSecret: 's3cret',
        eventKey: 'im.message.receive_v1',
      },
      {} as NodeJS.ProcessEnv,
    );
    expect(config).toMatchObject({
      identity: 'bot',
      domain: 'lark',
      permissionMode: 'full_access',
      groupPolicy: 'allowlist',
      allowedUsers: ['ou_a'],
      appId: 'cli_x',
      appSecret: 's3cret',
    });
  });

  it('falls back to env for cliBin when the DB omits it', () => {
    const config = feishuCliConfigFromRecord({ enabled: true }, { FEISHU_CLI_BIN: 'env-lark' } as unknown as NodeJS.ProcessEnv);
    expect(config?.cliBin).toBe('env-lark');
  });
});

describe('resolveFeishuCliConfig', () => {
  it('prefers an enabled DB config over env', async () => {
    const config = await resolveFeishuCliConfig(reader({ enabled: true, identity: 'user' }), FEISHU_CLI_ENV);
    expect(config?.enabled).toBe(true);
    expect(config?.identity).toBe('user');
  });

  it('falls back to env when the DB row is absent', async () => {
    const config = await resolveFeishuCliConfig(reader(undefined), FEISHU_CLI_ENV);
    expect(config?.identity).toBe('bot');
    expect(config?.permissionMode).toBe('full_access');
    expect(config?.cliBin).toBe('env-lark');
  });

  it('falls back to env when the DB row is disabled', async () => {
    const config = await resolveFeishuCliConfig(reader({ enabled: false }), FEISHU_CLI_ENV);
    expect(config?.identity).toBe('bot');
  });

  it('returns undefined when neither DB nor env enables the channel', async () => {
    const config = await resolveFeishuCliConfig(reader(undefined), {} as NodeJS.ProcessEnv);
    expect(config).toBeUndefined();
  });
});

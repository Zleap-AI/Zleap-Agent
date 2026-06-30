import type { CustomModelConfig } from '@zleap/ai';
import { render } from 'ink';
import { ChatEngine, DEFAULT_SYSTEM_PROMPT } from '@zleap/agent/engine';
import { loadLastSession } from '../session.js';
import type { ToolApprovalRequest } from '../state/types.js';
import { App } from '../app.js';
import { resolveCliContext, type CliContext } from '../cli/context.js';

export type ChatRunOptions = {
  prompt?: string;
  systemPrompt: string;
  protocol?: 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  modelConfigId?: string;
  resume: boolean;
  fresh: boolean;
  yes: boolean;
};

export async function runDefaultChat(args: string[]): Promise<void> {
  const options = parseChatArgs(args);
  const ctx = await resolveCliContext({ modelConfigId: options.modelConfigId });
  const custom = resolveCustomModel(options, ctx);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.prompt;
  if (!interactive) {
    await runOnce(options, custom, ctx);
    return;
  }

  if (!custom && !options.prompt) {
    process.stderr.write('提示：尚未配置模型，将进入内联配置向导（也可运行 zleap init）。\n');
  }

  const continueSession = options.resume && !options.fresh;
  let initialMessages = undefined;
  if (continueSession) {
    initialMessages = (await loadLastSession()) ?? undefined;
  }

  const app = render(
    <App
      initialContext={ctx}
      initialSessionModel={custom !== ctx.model ? custom : undefined}
      systemPrompt={options.systemPrompt}
      initialMessages={initialMessages}
      continueSession={continueSession}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  process.exit(0);
}

export function resolveCustomModel(options: ChatRunOptions, ctx: CliContext): CustomModelConfig | undefined {
  if (options.baseUrl && options.apiKey && options.model) {
    return {
      protocol: options.protocol,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      id: options.model,
      displayName: options.model,
    };
  }
  if (ctx.model && options.model) {
    return {
      ...ctx.model,
      model: options.model,
      id: options.model,
      displayName: options.model,
    };
  }
  return ctx.model;
}

async function runOnce(options: ChatRunOptions, custom: CustomModelConfig | undefined, ctx: CliContext): Promise<void> {
  const prompt = options.prompt ?? (process.stdin.isTTY ? '' : await readStdin());
  if (!prompt.trim()) {
    process.stderr.write('用法：zleap "你的问题"   （或通过 stdin 管道输入）\n');
    process.stderr.write('帮助：zleap --help\n');
    process.exitCode = 1;
    return;
  }

  if (!custom) {
    process.stderr.write('未配置模型。运行 zleap init 或设置 ZLEAP_MODEL_* 环境变量。\n');
    process.exitCode = 1;
    return;
  }

  const engine = new ChatEngine(custom, ctx.persistence);
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  const messages = [{ role: 'user' as const, content: prompt }];
  let errored = false;

  const confirm = async (request: ToolApprovalRequest): Promise<boolean> => {
    if (options.yes) return true;
    process.stderr.write(
      `\n[已拒绝] ${request.name} 需要确认；一次性模式请加 --yes 以允许工具执行。\n`,
    );
    return false;
  };

  try {
    for await (const delta of engine.reply(messages, options.systemPrompt, controller.signal, { confirm })) {
      if (delta.type === 'delta') {
        process.stdout.write(delta.text);
      } else if (delta.type === 'needs_approval') {
        process.stderr.write(`\n${delta.message}\n`);
        errored = true;
      } else if (delta.type === 'error') {
        process.stderr.write(`\n${delta.message}\n`);
        errored = true;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  process.stdout.write('\n');
  if (errored) {
    process.exitCode = 1;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

export function parseChatArgs(args: string[]): ChatRunOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const BOOLEAN_FLAGS = new Set(['resume', 'continue', 'yes', 'help', 'version', 'fresh']);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.add(key);
        continue;
      }
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`缺少 --${key} 的参数值`);
      }
      values.set(key, value);
      index += 1;
    } else if (arg) {
      positional.push(arg);
    }
  }

  return {
    prompt: values.get('prompt') ?? (positional.length ? positional.join(' ') : undefined),
    systemPrompt: values.get('system') ?? DEFAULT_SYSTEM_PROMPT,
    protocol: normalizeProtocol(values.get('protocol') ?? process.env.ZLEAP_MODEL_PROTOCOL),
    baseUrl: values.get('base-url') ?? process.env.ZLEAP_MODEL_BASE_URL,
    apiKey: values.get('api-key') ?? process.env.ZLEAP_MODEL_API_KEY,
    model: values.get('model') ?? process.env.ZLEAP_MODEL_NAME,
    modelConfigId: values.get('model-config-id'),
    resume: flags.has('resume') || flags.has('continue'),
    fresh: flags.has('fresh'),
    yes: flags.has('yes'),
  };
}

function normalizeProtocol(value: string | undefined): 'openai' | 'anthropic' | undefined {
  return value === 'anthropic' || value === 'openai' ? value : undefined;
}

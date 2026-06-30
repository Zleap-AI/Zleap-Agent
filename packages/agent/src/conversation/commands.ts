import type { ActorContext, InboundMessage } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';

/** Result of a conversation-level command (never reaches the agent). */
export type CommandOutcome = { text?: string };

export type CommandContext = {
  inbound: InboundMessage;
  actor?: ActorContext;
  store: ZleapStore | null;
  /** Start a fresh context for this conversation (history cutoff). */
  reset: () => void | Promise<void>;
  /** Human-readable label of the currently resolved model. */
  modelLabel: () => Promise<string>;
};

export type Command = {
  name: string;
  run: (ctx: CommandContext) => Promise<CommandOutcome> | CommandOutcome;
};

const HELP_TEXT = [
  '可用命令：',
  '/new, /reset  开始新会话（不再读取之前的历史）',
  '/model        查看当前使用的模型',
  '/stop         中止当前正在进行的回复',
  '/help         显示本帮助',
].join('\n');

async function resetOutcome(ctx: CommandContext): Promise<CommandOutcome> {
  await ctx.reset();
  return { text: '已开启新会话，后续不再读取之前的历史。' };
}

const COMMANDS = new Map<string, Command>([
  ['/new', { name: 'new', run: resetOutcome }],
  ['/reset', { name: 'reset', run: resetOutcome }],
  ['/clear', { name: 'clear', run: resetOutcome }],
  ['/help', { name: 'help', run: () => ({ text: HELP_TEXT }) }],
  ['/?', { name: 'help', run: () => ({ text: HELP_TEXT }) }],
  ['/model', { name: 'model', run: async (ctx) => ({ text: `当前模型：${await ctx.modelLabel()}` }) }],
]);

/** Commands that interrupt an in-flight run; handled before the per-chat lock. */
const STOP_COMMANDS = new Set(['/stop', '/cancel', '/abort']);

export function isStopCommand(text: string): boolean {
  return STOP_COMMANDS.has(firstToken(text));
}

export function matchCommand(text: string): Command | undefined {
  return COMMANDS.get(firstToken(text));
}

function firstToken(text: string): string {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

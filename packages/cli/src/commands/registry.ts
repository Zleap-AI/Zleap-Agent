import type { BuiltinCommand } from './builtin.js';
import { RUN_MODE_SHORTCUT } from '@zleap/agent';

export type SlashCommand = {
  name: BuiltinCommand;
  description: string;
  group?: 'chat' | 'config' | 'serve' | 'im';
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/mode', description: '切换运行模式（普通 / 计划 / 目标）', group: 'chat' },
  { name: '/plan', description: '进入计划模式（只分析不执行）', group: 'chat' },
  { name: '/normal', description: '回到普通模式（直接执行）', group: 'chat' },
  { name: '/goal', description: '进入目标模式（持续追踪目标）', group: 'chat' },
  { name: '/execute', description: '确认计划并开始执行（切到普通模式）', group: 'chat' },
  { name: '/permissions', description: '切换权限模式（审批 / 全权）', group: 'config' },
  { name: '/model', description: '选择或配置模型（数据库列表 / 手动向导）', group: 'config' },
  { name: '/sessions', description: '列出并恢复历史会话', group: 'chat' },
  { name: '/new', description: '开始新对话', group: 'chat' },
  { name: '/abort', description: '中断当前生成（Esc 同效）', group: 'chat' },
  { name: '/status', description: '显示模型、记忆、上下文与 IM 频道状态', group: 'config' },
  { name: '/config', description: '显示当前配置摘要（模型来源、数据库）', group: 'config' },
  { name: '/doctor', description: '运行环境体检', group: 'config' },
  { name: '/serve', description: '后台启动本地栈（Postgres + Web + Worker + gateway）', group: 'serve' },
  { name: '/stop', description: '停止 /serve 启动的本地栈（非中断生成）', group: 'serve' },
  { name: '/connect', description: '连接 IM 频道并显示 QR（例：/connect wechat）', group: 'im' },
  { name: '/channels', description: '查看 IM 频道连接状态', group: 'im' },
  { name: '/spaces', description: '列出可路由的 workspace 及工具', group: 'chat' },
  { name: '/context', description: '对话大小与滚动摘要 compaction 状态', group: 'chat' },
  { name: '/compact', description: '立即将较早轮次提取到 item/event 记忆', group: 'chat' },
  { name: '/clear', description: '清空对话（同 /new）', group: 'chat' },
  { name: '/resume', description: '恢复最近一次保存的对话', group: 'chat' },
  { name: '/memory', description: '显示最近 durable memory（Postgres）', group: 'chat' },
  { name: '/help', description: '列出 slash 命令与快捷键', group: 'chat' },
  { name: '/exit', description: '退出 Zleap 并恢复终端', group: 'chat' },
  { name: '/quit', description: '/exit 的别名', group: 'chat' },
];

export function isSlashPaletteOpen(draft: string): boolean {
  const head = draft.split('\n', 1)[0] ?? '';
  return head.startsWith('/');
}

export function filterSlashCommands(draft: string, options: { running?: boolean } = {}): SlashCommand[] {
  const query = (draft.split('\n', 1)[0] ?? '').trimEnd();
  if (!query.startsWith('/')) {
    return [];
  }
  let commands = SLASH_COMMANDS;
  if (options.running) {
    commands = commands.filter((command) => command.name === '/abort');
  }
  if (query === '/') {
    return commands;
  }
  const token = query.split(/\s+/, 1)[0] ?? query;
  return commands.filter((command) => command.name.startsWith(token));
}

export function formatSlashHelp(): string {
  const groups: Array<{ label: string; key: SlashCommand['group'] }> = [
    { label: '对话', key: 'chat' },
    { label: '配置', key: 'config' },
    { label: '服务', key: 'serve' },
    { label: 'IM', key: 'im' },
  ];
  const lines: string[] = ['Slash 命令：'];
  for (const { label, key } of groups) {
    const items = SLASH_COMMANDS.filter((command) => command.group === key);
    if (items.length === 0) continue;
    lines.push('', `  ${label}`);
    for (const command of items) {
      lines.push(`    ${command.name.padEnd(12)} ${command.description}`);
    }
  }
  lines.push(
    '',
    `模式：${RUN_MODE_SHORTCUT} 循环切换 · /plan /normal /goal · /permissions 权限`,
    '输入 / 打开菜单 · ↑↓ 选择 · Enter 执行 · Esc 取消',
    '运行中 Esc 或 /abort 中断生成 · /stop 仅停止本地栈',
    'Enter 发送 · Shift+Enter 换行 · Ctrl+C 退出',
  );
  return lines.join('\n');
}

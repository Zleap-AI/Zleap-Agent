import type { ThreadRecord } from '@zleap/core';

export type SessionListItem = {
  id: string;
  title: string;
  updatedAt: Date;
  source: 'local' | 'db';
};

export function formatSessionList(items: SessionListItem[]): string {
  if (items.length === 0) {
    return '暂无已保存会话。发送消息后自动创建。';
  }
  const lines = ['会话列表（输入编号恢复，或 /new 新建）：'];
  items.forEach((item, index) => {
    const when = formatRelativeTime(item.updatedAt);
    const tag = item.source === 'local' ? '本地' : '数据库';
    lines.push(`  ${String(index + 1).padStart(2)}. [${tag}] ${item.title}  · ${when}`);
  });
  return lines.join('\n');
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function threadToSessionItem(thread: ThreadRecord): SessionListItem {
  const meta = thread.metadata as { title?: unknown } | undefined;
  const title =
    (typeof thread.title === 'string' && thread.title.trim()) ||
    (typeof meta?.title === 'string' && meta.title.trim()) ||
    '未命名对话';
  return { id: thread.id, title, updatedAt: thread.updatedAt, source: 'db' };
}

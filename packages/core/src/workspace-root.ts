import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const DEFAULT_FILE_WORKSPACE_ROOT = join(homedir(), 'Documents', 'Zleap');

export type ConversationWorkspaceRootOptions = {
  conversationId?: string;
  baseRoot?: string;
  titleSeed?: string;
  now?: Date;
};

export function resolveConversationWorkspaceRoot(options: ConversationWorkspaceRootOptions = {}): string {
  const base = resolve(options.baseRoot ?? DEFAULT_FILE_WORKSPACE_ROOT);
  const [date, segment] = conversationWorkspaceSegments(options);
  const target = resolve(base, date, segment);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('conversation_workspace_root_escape');
  }
  return target;
}

function conversationWorkspaceSegments(options: ConversationWorkspaceRootOptions): [string, string] {
  const date = formatLocalDate(conversationDate(options.conversationId, options.now));
  const topic = sanitizeSegment(options.titleSeed) ?? fallbackConversationSegment(options);
  return [date, topic];
}

function fallbackConversationSegment(options: ConversationWorkspaceRootOptions): string {
  const title = options.titleSeed?.trim();
  if (title) {
    return `chat-${shortHash(title)}`;
  }
  const conversationSegment = sanitizeSegment(options.conversationId);
  if (conversationSegment && !isGeneratedWebConversationId(options.conversationId)) {
    return conversationSegment;
  }
  const source = options.conversationId?.trim();
  return source ? `chat-${shortHash(source)}` : 'new-chat';
}

function conversationDate(conversationId: string | undefined, fallback = new Date()): Date {
  const match = /^web-([a-z0-9]+)-/i.exec(conversationId ?? '');
  if (!match) return fallback;
  const timestamp = Number.parseInt(match[1]!, 36);
  if (!Number.isFinite(timestamp)) return fallback;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isGeneratedWebConversationId(conversationId: string | undefined): boolean {
  return /^web-[a-z0-9]+-[a-z0-9]+$/i.test(conversationId ?? '');
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const meaningfulChars = value.match(/[A-Za-z0-9]/g)?.length ?? 0;
  if (meaningfulChars < 3) {
    return undefined;
  }
  const sanitized = value
    .normalize('NFKC')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^-+|-+$/g, '');
  const limited = Array.from(sanitized).slice(0, 64).join('').replace(/^-+|-+$/g, '');
  return limited || undefined;
}

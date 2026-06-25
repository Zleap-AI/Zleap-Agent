import type { GroupPolicy } from '../../config.js';

/**
 * Shared Feishu message normalization, used by both the node-sdk `FeishuAdapter`
 * and the CLI-based `FeishuCliAdapter` so inbound handling stays standardized
 * across the two Feishu access methods. Pure functions only (no adapter state).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FeishuMessageLike = any;

/** Flatten a Feishu inbound message into plain text. */
export function extractText(message: FeishuMessageLike): string {
  const type = message?.message_type;
  const raw = message?.content;
  if (typeof raw !== 'string') {
    return '';
  }
  let parsed: FeishuMessageLike;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (type === 'text') {
    return stripMentions(String(parsed?.text ?? ''));
  }
  if (type === 'post') {
    return stripMentions(flattenPost(parsed));
  }
  return '';
}

/** Flatten Feishu rich-text "post" content into newline-joined text. */
export function flattenPost(parsed: FeishuMessageLike): string {
  const locale = parsed?.zh_cn ?? parsed?.en_us ?? Object.values(parsed ?? {})[0];
  const blocks: FeishuMessageLike[] = Array.isArray(locale?.content) ? locale.content : [];
  const lines: string[] = [];
  if (typeof locale?.title === 'string' && locale.title.trim()) {
    lines.push(locale.title.trim());
  }
  for (const block of blocks) {
    const segments: FeishuMessageLike[] = Array.isArray(block) ? block : [];
    const line = segments
      .map((segment) => (segment?.tag === 'a' ? String(segment?.text ?? segment?.href ?? '') : String(segment?.text ?? '')))
      .join('');
    lines.push(line);
  }
  return lines.join('\n').trim();
}

export function stripMentions(text: string): string {
  return text
    .replace(/@_all/g, '')
    .replace(/@_user_\d+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export type BotMatch = { botOpenId?: string; botName?: string };

/** Whether the bot was @-mentioned in a (group) message. */
export function mentionsBot(message: FeishuMessageLike, match: BotMatch): boolean {
  const mentions: FeishuMessageLike[] = Array.isArray(message?.mentions) ? message.mentions : [];
  if (mentions.length === 0) {
    // Feishu only pushes group messages to the bot when it is @-mentioned
    // (im:message.group_at_msg). Absent an explicit list, assume mentioned.
    return !match.botOpenId;
  }
  return mentions.some((mention) => {
    const openId = mention?.id?.open_id;
    if (match.botOpenId) {
      return openId === match.botOpenId;
    }
    if (match.botName && typeof mention?.name === 'string') {
      // Case-insensitive, whitespace-tolerant: the configured name is often a
      // near-miss of the bot's real display name (e.g. "zleap Agent" vs
      // "ZLeap Agent"), which must not silently drop @-mentions.
      return mention.name.trim().toLowerCase() === match.botName.trim().toLowerCase();
    }
    return true;
  });
}

export type GroupAdmission = { groupPolicy: GroupPolicy; allowedUsers: string[] };

/** Apply the group admission policy to a normalized (group) event. */
export function acceptGroupMessage(
  event: { mentionsBot?: boolean; userId?: string },
  admission: GroupAdmission,
): boolean {
  const { groupPolicy, allowedUsers } = admission;
  if (groupPolicy === 'disabled') {
    return false;
  }
  if (!event.mentionsBot) {
    return false;
  }
  const userId = event.userId ?? '';
  switch (groupPolicy) {
    case 'allowlist':
      return allowedUsers.includes(userId);
    case 'blacklist':
      return !allowedUsers.includes(userId);
    case 'admin_only':
      // Admin verification needs the contact API; treated as @-gated for MVP.
      return true;
    case 'open':
    default:
      return true;
  }
}

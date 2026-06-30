import { DEFAULT_SPACE_ACCENT, SPACE_ICONS } from '@/lib/spaces';

export const DEFAULT_AVATAR_ACCENT = DEFAULT_SPACE_ACCENT;

export type AvatarTheme = {
  emoji?: string;
  accent: string;
};

/** Parse theme fields from avatar version metadata. */
export function parseAvatarTheme(metadata?: Record<string, unknown>): AvatarTheme {
  const rawEmoji = metadata?.emoji;
  let emoji = typeof rawEmoji === 'string' && rawEmoji.trim() ? rawEmoji.trim() : undefined;
  if (!emoji) {
    const legacyIcon = metadata?.icon;
    if (typeof legacyIcon === 'string' && legacyIcon.trim() && !SPACE_ICONS[legacyIcon.trim()]) {
      emoji = legacyIcon.trim();
    }
  }
  const accent = typeof metadata?.accent === 'string' ? metadata.accent : DEFAULT_AVATAR_ACCENT;
  return { emoji, accent };
}

/** First grapheme of the display name, uppercased, for the default badge. */
export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

'use client';

import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { avatarInitial } from '@/lib/avatars';

type AvatarBadgeProps = {
  name: string;
  emoji?: string;
  accent: string;
  className?: string;
  emojiClassName?: string;
  letterClassName?: string;
};

/** Nav list + composer toolbar — keep glyph proportions identical. */
export const NAV_AVATAR_BADGE_PROPS = {
  className: 'size-4',
  letterClassName: 'text-2xs',
  emojiClassName: 'text-sm leading-none',
} as const;

/** Sidebar / header avatar glyph: emoji when set, otherwise the name initial on accent. */
export function AvatarBadge({ name, emoji, accent, className, emojiClassName, letterClassName }: AvatarBadgeProps) {
  if (emoji) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center leading-none', className)}>
        <span className={emojiClassName}>{emoji}</span>
      </span>
    );
  }
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white', className)}
      style={{ backgroundColor: accent } as CSSProperties}
    >
      <span className={letterClassName}>{avatarInitial(name)}</span>
    </span>
  );
}

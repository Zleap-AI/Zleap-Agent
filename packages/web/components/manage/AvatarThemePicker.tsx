'use client';

import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SPACE_COLOR_OPTIONS } from '@/lib/spaces';

export type AvatarThemePickerHandle = {
  commitEmoji: () => string | undefined;
};

type AvatarThemePickerProps = {
  emoji?: string;
  accent: string;
  onEmojiChange: (emoji: string | undefined) => void;
  onAccentChange: (accent: string) => void;
  onEmojiDraftChange?: (draft: string) => void;
  commitRef?: Ref<AvatarThemePickerHandle>;
};

function normalizeEmojiInput(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return [...trimmed].slice(0, 1).join('');
}

/** Color dropdown + emoji input — same full-width layout as SpaceThemePicker. */
export function AvatarThemePicker({ emoji, accent, onEmojiChange, onAccentChange, onEmojiDraftChange, commitRef }: AvatarThemePickerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(emoji ?? '');

  // Sync draft when the stored value changes (init / save / switch avatar), not on every parent re-render.
  useEffect(() => {
    setDraft(emoji ?? '');
  }, [emoji]);

  const commitEmoji = () => {
    const next = normalizeEmojiInput(draft);
    onEmojiChange(next);
    setDraft(next ?? '');
    return next;
  };

  useImperativeHandle(commitRef, () => ({ commitEmoji }), [draft, onEmojiChange]);

  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('space.color')}</Label>
        <Select value={accent} onValueChange={onAccentChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPACE_COLOR_OPTIONS.map((color) => (
              <SelectItem key={color.value} value={color.value}>
                <span className="size-3.5 rounded-full" style={{ backgroundColor: color.value }} />
                {color.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t('avatar.icon')}</Label>
        <Input
          value={draft}
          onChange={(e) => {
            const nextDraft = e.target.value;
            setDraft(nextDraft);
            onEmojiDraftChange?.(nextDraft);
            onEmojiChange(normalizeEmojiInput(nextDraft));
          }}
          onBlur={commitEmoji}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEmoji();
            }
          }}
          className="text-lg"
          placeholder={t('avatar.emojiPlaceholder')}
        />
        <p className="text-xs text-muted-foreground">{t('avatar.emojiHint')}</p>
      </div>
    </>
  );
}

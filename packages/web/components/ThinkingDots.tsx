'use client';

import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Lively "thinking" indicator shown before the first token of a turn. */
export function ThinkingDots() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 text-muted-foreground">
      <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent-soft">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
      </span>
      <span className="text-sm">{t('chat.thinking', { defaultValue: '思考中' })}</span>
      <span className="flex items-center gap-1">
        <span className="think-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/60" style={{ animationDelay: '0ms' }} />
        <span className="think-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/60" style={{ animationDelay: '160ms' }} />
        <span className="think-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/60" style={{ animationDelay: '320ms' }} />
      </span>
    </div>
  );
}

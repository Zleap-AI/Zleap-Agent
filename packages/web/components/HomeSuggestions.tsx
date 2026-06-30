'use client';

import { ArrowUpRight, Code2, FileSearch, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The prompt starters shown under the hero composer on the home screen. */
export function HomeSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useTranslation();
  const suggestions = [
    { icon: FileSearch, title: t('chat.suggest.exploreTitle'), prompt: t('chat.suggest.explorePrompt') },
    { icon: Code2, title: t('chat.suggest.codeTitle'), prompt: t('chat.suggest.codePrompt') },
    { icon: Sparkles, title: t('chat.suggest.summaryTitle'), prompt: t('chat.suggest.summaryPrompt') },
  ];
  return (
    <div className="mt-5 grid gap-2.5 sm:grid-cols-3">
      {suggestions.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.title}
            type="button"
            onClick={() => onPick(item.prompt)}
            style={{ animationDelay: `${120 + index * 70}ms` }}
            className="animate-msg-in group flex items-center gap-2.5 rounded-lg border border-border/80 bg-muted px-3 py-2.5 text-left shadow-xs transition-all duration-[var(--duration-base)] ease-out hover:-translate-y-px hover:border-border hover:bg-muted/50 hover:shadow-sm"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition group-hover:bg-accent-soft group-hover:text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <span className="truncate text-xs font-medium text-foreground">{item.title}</span>
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
  );
}

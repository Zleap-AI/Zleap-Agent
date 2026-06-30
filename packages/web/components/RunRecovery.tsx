'use client';

import { RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RunStatus } from '../lib/types';

type RunRecoveryProps = {
  status: RunStatus;
  onRetry: () => void;
  onClear: () => void;
};

export function RunRecovery({ status, onRetry, onClear }: RunRecoveryProps) {
  const { t } = useTranslation();
  const running = status === 'running';
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm shadow-xs">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-destructive/10">
        <TriangleAlert className="h-4 w-4 text-destructive" />
      </span>
      <span className="min-w-0 flex-1 text-destructive">{t('common.retryLastInput')}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={running}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-destructive/30 bg-card px-2.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t('common.retry')}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={running}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t('common.delete')}
        title={t('common.delete')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

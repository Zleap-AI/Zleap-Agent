'use client';

import { RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import type { RunStatus } from '../lib/types';

type RunRecoveryProps = {
  status: RunStatus;
  onRetry: () => void;
  onClear: () => void;
};

export function RunRecovery({ status, onRetry, onClear }: RunRecoveryProps) {
  const running = status === 'running';
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm shadow-xs">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-rose-500/10">
        <TriangleAlert className="h-4 w-4 text-rose-500" />
      </span>
      <span className="min-w-0 flex-1 text-rose-500">上一次运行中断或失败，可以重试最后一条输入。</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={running}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-rose-500/30 bg-surface px-2.5 text-xs font-medium text-ink transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Retry
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={running}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Clear conversation"
        title="Clear conversation"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

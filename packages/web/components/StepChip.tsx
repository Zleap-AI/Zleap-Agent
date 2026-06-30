'use client';

import { ArrowUpRight, Check, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCallView } from '../lib/types';

type StepChipProps = {
  tool: ToolCallView;
  spaceId?: string;
  onOpen?: (spaceId: string) => void;
};

function StatusIcon({ status }: { status: ToolCallView['status'] }) {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (status === 'error') {
    return <X className="h-3.5 w-3.5 text-destructive" />;
  }
  return <Check className="h-3.5 w-3.5 text-success" />;
}

/** Brief summary for the chip — first meaningful line of the result. */
function brief(tool: ToolCallView): string {
  if (tool.status === 'running') {
    return 'running…';
  }
  const head = (tool.result.split('\n').find((line) => line.trim()) ?? '').trim();
  return head.length > 48 ? `${head.slice(0, 47)}…` : head;
}

/** A one-line tool step in the conversation; click opens it in the workspace console. */
export function StepChip({ tool, spaceId, onOpen }: StepChipProps) {
  const clickable = Boolean(spaceId && onOpen);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? () => onOpen!(spaceId!) : undefined}
      className={clsx(
        'group inline-flex max-w-full items-center gap-2 rounded-pill border border-border bg-card py-1.5 pl-2.5 pr-3 text-left shadow-xs transition-all duration-[var(--duration-base)] ease-out',
        clickable ? 'hover:-translate-y-px hover:border-border hover:shadow-sm' : 'cursor-default',
      )}
    >
      <StatusIcon status={tool.status} />
      <span className="font-mono text-xs font-medium text-foreground">{tool.name}</span>
      <span className="truncate text-xs text-muted-foreground">{brief(tool)}</span>
      {clickable ? (
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
      ) : null}
    </button>
  );
}

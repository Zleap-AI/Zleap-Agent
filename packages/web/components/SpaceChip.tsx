'use client';

import { motion } from 'framer-motion';
import { DURATION, EASE_OUT } from "@/lib/motion";
import { Check, ChevronRight, Clock, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { summarizeToolPayload } from '../lib/toolPayload';
import type { Envelope, SpaceView, ToolCallView, WorkPane } from '../lib/types';
import { spaceMeta, type SpaceItem } from '../lib/spaces';

type SpaceChipProps = {
  space: SpaceView;
  /** The live pane backing this chip while it is the running dispatch. */
  pane?: WorkPane;
  /** THIS dispatch's own result, frozen once it returned — independent of the
   *  reused live pane. When set, the chip shows its own stats, not the pane's. */
  envelope?: Envelope;
  spaces: SpaceItem[];
  /** The tool currently executing in this pane, if any. */
  activeTool?: ToolCallView | null;
  /** Whether this workspace is still actively running. */
  running?: boolean;
  onOpen?: (paneId: string) => void;
};

/**
 * Progressive workspace summary shown inline in the conversation: how many
 * tools the kernel ran in this space, plus the one currently executing. The
 * full, scrollable tool history lives in the workspace console — click to open that tab.
 */
export function SpaceChip({ space, pane, envelope, spaces, activeTool, running = false, onOpen }: SpaceChipProps) {
  const { t } = useTranslation();
  const meta = spaceMeta(spaces, space.spaceId, space.label);
  const [, setTick] = useState(0);
  // This card is "live" only while it is the still-running dispatch (no frozen
  // result yet). Once its own envelope arrives, it shows that — never the live
  // pane, which a later dispatch to the same space resets.
  const live = !envelope && (pane?.status === 'running' || running);
  const total = pane?.tools.length ?? 0;
  const maxSteps = Math.max(pane?.budget?.maxToolIterations ?? 0, meta.budget.maxToolIterations);
  const progress = maxSteps ? Math.min(total / maxSteps, 1) : 0;
  const elapsed = pane?.startedAt ? formatElapsed((pane.endedAt ?? Date.now()) - pane.startedAt) : '';
  const tools = pane?.tools ?? [];
  const latestTool = activeTool ?? tools.find((tool) => tool.status === 'running') ?? tools.at(-1) ?? null;
  const Icon = meta.iconComponent;
  const resultSummary = envelope?.summary ? summarizeText(envelope.summary) : '';
  const progressSummary = pane?.statusLine ? summarizeText(pane.statusLine) : '';
  const statusLabel = envelope
    ? envelope.status === 'success'
      ? t('space.statusDone', { defaultValue: '完成' })
      : t('space.statusFailed', { defaultValue: '失败' })
    : live
      ? t('space.statusWorking', { defaultValue: '工作中' })
      : t('space.statusPending', { defaultValue: '等待结果' });
  const statusTone = envelope?.status === 'failed' ? 'rose' : envelope?.status === 'success' ? 'emerald' : 'muted';
  const task = pane?.goal || pane?.context?.detail;

  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  return (
    <div className="group w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card/95 text-left shadow-xs transition-all duration-[var(--duration-base)] ease-out hover:-translate-y-px hover:border-border hover:bg-card hover:shadow-sm">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: meta.accent + '18' }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: meta.accent }} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <span className="truncate">{meta.label}</span>
            <StatusPill tone={statusTone} label={statusLabel} />
          </div>
          {task ? (
            <div className="mt-1 truncate text-xs leading-5 text-muted-foreground">
              <span className="mr-1 text-muted-foreground">Task</span>
              {task}
            </div>
          ) : null}
          {live ? (
            // Live progress for the running dispatch only. A finished card drops
            // this — its per-dispatch stats live in the footer status line, kept
            // independent of the reused pane (per the reuse/isolation split).
            <div className="mt-1.5 flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
              <span className="shrink-0">{maxSteps ? `${total}/${maxSteps} steps` : `${total} tools`}</span>
              {elapsed ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {elapsed}
                </span>
              ) : null}
              {latestTool ? (
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">tool</span>{' '}
                  <span className="font-mono text-muted-foreground">{latestTool.name}</span>
                  <span className="text-muted-foreground">: </span>
                  {toolSummary(latestTool)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(space.id)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title={t('space.openWorkspace', { defaultValue: '打开调度工作区' })}
            aria-label={t('space.openWorkspace', { defaultValue: '打开调度工作区' })}
          >
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </button>
        ) : null}
      </div>

      <div className="px-3 pb-2.5">
        {live && maxSteps ? (
          <div className="h-1 overflow-hidden rounded-pill bg-muted/80">
            <motion.div
              className="h-full rounded-pill"
              initial={false}
              animate={{ width: `${progress * 100}%` }}
              transition={{ duration: DURATION.base, ease: EASE_OUT }}
              style={{ backgroundColor: meta.accent + '66' }}
            />
          </div>
        ) : null}

        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
          <ResultIcon status={envelope?.status} running={live} />
          <div className="min-w-0 flex-1 truncate text-muted-foreground">
            <span className="font-medium text-foreground">{statusLabel}</span>
            {resultSummary ? (
              <>
                <span className="text-muted-foreground"> · </span>
                {resultSummary}
              </>
            ) : progressSummary ? (
              <>
                <span className="text-muted-foreground"> · </span>
                {progressSummary}
              </>
            ) : (
              <span className="text-muted-foreground"> · workspace result pending</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function toolSummary(tool: ToolCallView): string {
  if (tool.status === 'running') {
    return tool.args ? summarizeToolPayload(tool.args) : 'Executing tool call';
  }
  if (tool.status === 'error') {
    return summarizeToolPayload(tool.result) || 'Tool failed';
  }
  return summarizeToolPayload(tool.result) || summarizeToolPayload(tool.args) || 'Completed';
}

function StatusPill({ tone, label }: { tone: 'emerald' | 'rose' | 'muted'; label: string }) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-success/10 text-success'
      : tone === 'rose'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';
  return <span className={`shrink-0 rounded-pill px-1.5 py-0.5 text-2xs font-medium ${toneClass}`}>{label}</span>;
}

function ResultIcon({ status, running }: { status?: 'success' | 'failed'; running: boolean }) {
  if (running) {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === 'failed') {
    return <X className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  if (!status) {
    return <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-success" />;
}

function summarizeText(value: string): string {
  const normalized = value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!normalized) {
    return '';
  }
  return normalized.length > 120 ? `${normalized.slice(0, 119)}...` : normalized;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest.toString().padStart(2, '0')}s` : `${rest}s`;
}

'use client';

import { AlertCircle, CheckCircle2, Loader2, PanelRightClose } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunStatus, WorkPane } from '../../lib/types';
import { spaceMeta, type SpaceItem } from '../../lib/spaces';
import { IconButton } from '../ui/icon-button';
import { WorkConsoleTabs } from './WorkConsoleTabs';
import { WorkScreen } from './WorkScreen';

type WorkConsoleProps = {
  workspaces: WorkPane[];
  spaces: SpaceItem[];
  activeWorkspaceId: string | null;
  status: RunStatus;
  onSelect: (id: string) => void;
  onCollapse: () => void;
  /** Hide the built-in tab strip when an external (unified) tab bar drives it. */
  hideTabs?: boolean;
};

/** The dispatch console: a "computer" window whose tabs are the spaces the kernel entered. */
export function WorkConsole({ workspaces, spaces, activeWorkspaceId, onSelect, onCollapse, hideTabs = false }: WorkConsoleProps) {
  const activeIndex = workspaces.findIndex((pane) => pane.id === activeWorkspaceId);
  const active = activeIndex >= 0 ? workspaces[activeIndex] : (workspaces[0] ?? null);
  const effectiveActiveId = active?.id ?? null;
  const running = active?.status === 'running';
  const hasError = workspaces.some((pane) => pane.status === 'error' || pane.tools.some((tool) => tool.status === 'error'));
  const activeMeta = active ? spaceMeta(spaces, active.spaceId, active.label) : null;
  const activeTask = active?.goal || active?.context?.detail || 'Waiting for workspace activity';
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {!hideTabs && workspaces.length ? (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-background pr-2">
          <WorkConsoleTabs spaces={spaces} workspaces={workspaces} activeWorkspaceId={effectiveActiveId} onSelect={onSelect} />
          <IconButton
            size="icon-xs"
            onClick={onCollapse}
            className="ml-1.5 shrink-0 text-muted-foreground"
            title="Collapse"
            aria-label="Collapse workspace"
          >
            <PanelRightClose className="size-3.5" />
          </IconButton>
        </div>
      ) : null}

      <div className="shrink-0 border-b border-border bg-background">
        <div className="px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="mt-0.5 h-9 w-0.5 shrink-0 rounded-pill"
              style={{ backgroundColor: activeMeta?.accent ?? 'var(--border-strong)' }}
            />
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 text-2xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Task</div>
              <div className="truncate text-sm font-semibold leading-5 text-foreground">
                {activeTask}
              </div>
              {active?.context?.source ? <div className="mt-0.5 text-xs text-muted-foreground">from {active.context.source}</div> : null}
            </div>
            <StatusBadge running={running} hasError={hasError} />
          </div>

          {/* No per-run stats here: the dispatch console is a REUSED pane — a tab shared
              across dispatches to the same space, so an aggregate count/elapsed is
              meaningless. Per-dispatch stats live on each conversation card. */}
        </div>
      </div>

      <WorkScreen pane={active} />
    </div>
  );
}

function StatusBadge({ running, hasError }: { running: boolean; hasError: boolean }) {
  const { t } = useTranslation();
  if (running) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
        {t('workspace.statusWorking')}
      </span>
    );
  }
  if (hasError) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        {t('workspace.statusError')}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-success/10 px-2 py-0.5 text-xs text-success">
      <CheckCircle2 className="h-3 w-3" />
      {t('workspace.statusDone')}
    </span>
  );
}

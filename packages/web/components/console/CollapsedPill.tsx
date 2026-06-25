'use client';

import { Loader2, Maximize2 } from 'lucide-react';
import type { RunStatus, WorkPane } from '../../lib/types';
import { spaceMeta, type SpaceItem } from '../../lib/spaces';

type CollapsedPillProps = {
  workspaces: WorkPane[];
  spaces: SpaceItem[];
  activeWorkspaceId: string | null;
  status: RunStatus;
  onExpand: () => void;
};

/** Collapsed-console handle shown on the conversation, above the composer. */
export function CollapsedPill({ workspaces, spaces, activeWorkspaceId, onExpand }: CollapsedPillProps) {
  if (!workspaces.length) {
    return null;
  }
  const activeIndex = workspaces.findIndex((pane) => pane.id === activeWorkspaceId);
  const active = activeIndex >= 0 ? workspaces[activeIndex] : workspaces[workspaces.length - 1]!;
  const meta = spaceMeta(spaces, active.spaceId, active.label);
  const Icon = meta.iconComponent;
  const running = active.status === 'running';
  const task = active.goal || active.context?.detail;

  return (
    <button
      type="button"
      onClick={onExpand}
      className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2.5 text-left shadow-xs transition-all duration-300 ease-out hover:-translate-y-px hover:border-border-strong hover:shadow-sm"
      title="Expand workspace"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-accent-soft">
        <Icon className="h-3.5 w-3.5" style={{ color: meta.accent }} />
      </span>
      <span className="shrink-0 text-xs font-medium text-ink">{meta.label}</span>
      <span className="truncate text-xs text-muted-foreground">{task}</span>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : null}
      <Maximize2 className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

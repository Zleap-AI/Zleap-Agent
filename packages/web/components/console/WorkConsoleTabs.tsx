import { FolderTree } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { WorkPane } from '../../lib/types';
import { spaceMeta, type SpaceItem } from '../../lib/spaces';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';

const FILES_TAB = '__files__';

type WorkConsoleTabsProps = {
  workspaces: WorkPane[];
  spaces: SpaceItem[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
  /** When provided, a leading "files" tab is rendered before the space tabs. */
  filesActive?: boolean;
  onSelectFiles?: () => void;
  filesLabel?: string;
};

/**
 * The workspace-console tab strip. One tab per subspace (Stage-Manager model): the most
 * recently dispatched space is leftmost, and re-entering a space reuses its tab
 * rather than spawning a duplicate. An optional leading "files" tab unifies the
 * directory browser into the same strip.
 */
export function WorkConsoleTabs({
  workspaces,
  spaces,
  activeWorkspaceId,
  onSelect,
  filesActive = false,
  onSelectFiles,
  filesLabel,
}: WorkConsoleTabsProps) {
  const value = filesActive ? FILES_TAB : (activeWorkspaceId ?? undefined);
  return (
    <Tabs
      value={value}
      onValueChange={(next) => (next === FILES_TAB ? onSelectFiles?.() : onSelect(next))}
      className="min-w-0 flex-1"
    >
      <TabsList className="no-scrollbar m-1.5 h-7 max-w-[calc(100%-0.75rem)] justify-start overflow-x-auto rounded-md bg-muted/70 p-0.5">
        {onSelectFiles ? (
          <TabsTrigger
            value={FILES_TAB}
            title={filesLabel}
            className="h-6 shrink-0 flex-none gap-1 rounded px-1.5 leading-none data-active:border-border data-active:shadow-sm"
          >
            <FolderTree className="size-3 opacity-80" />
            <span className="whitespace-nowrap text-xs font-medium leading-none">{filesLabel}</span>
          </TabsTrigger>
        ) : null}
        {workspaces.map((pane) => {
          const meta = spaceMeta(spaces, pane.spaceId, pane.label);
          const Icon = meta.iconComponent;
          const hasError = pane.status === 'error' || pane.tools.some((tool) => tool.status === 'error');
          const running = pane.status === 'running';
          return (
            <TabsTrigger
              key={pane.id}
              value={pane.id}
              title={meta.label}
              className="h-6 shrink-0 flex-none gap-1 rounded px-1.5 leading-none data-active:border-border data-active:shadow-sm"
            >
              <Icon className="size-3 opacity-80" style={{ color: meta.accent } as CSSProperties} />
              <span className="whitespace-nowrap text-xs font-medium leading-none">{meta.label}</span>
              {pane.tools.length > 0 ? <span className="font-mono text-2xs leading-none text-muted-foreground/50">{pane.tools.length}</span> : null}
              {hasError ? (
                <span className="size-1 rounded-full bg-destructive" />
              ) : running ? (
                <span className="relative flex size-1.5 items-center justify-center">
                  <span className="animate-pulse-ring absolute size-1.5 rounded-full bg-primary" />
                  <span className="size-1 rounded-full bg-primary" />
                </span>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

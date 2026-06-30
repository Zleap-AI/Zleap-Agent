'use client';

import { PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import type { ProjectView } from '../../lib/useResources';
import type { SpaceItem } from '../../lib/spaces';
import type { RunStatus, WorkPane } from '../../lib/types';
import type { WorkspaceFileTarget } from '../../lib/workspaceFiles';
import { WorkspaceFilesDrawer } from '../WorkspaceFilesDrawer';
import { IconButton } from '../ui/icon-button';
import { WorkConsole } from './WorkConsole';
import { WorkConsoleTabs } from './WorkConsoleTabs';

type WorkspacePanelProps = {
  presentation?: 'inline' | 'overlay';
  /** Whether the directory ("files") tab is the active one. */
  filesActive: boolean;
  onSelectFiles: () => void;
  onSelectWorkspace: (id: string) => void;
  onCollapse: () => void;
  // Directory tab inputs.
  conversationId: string;
  conversationTitle?: string;
  projectId?: string;
  projects: ProjectView[];
  fileTarget?: WorkspaceFileTarget | null;
  filesRefreshToken?: number;
  // Space tab inputs.
  spaces: SpaceItem[];
  workspaces: WorkPane[];
  activeWorkspaceId: string | null;
  status: RunStatus;
};

/**
 * The shared right sidebar: one tab strip whose first tab is the directory
 * browser and whose remaining tabs are the spaces the kernel entered. A single
 * collapse control closes the whole panel.
 */
export function WorkspacePanel({
  presentation = 'inline',
  filesActive,
  onSelectFiles,
  onSelectWorkspace,
  onCollapse,
  conversationId,
  conversationTitle,
  projectId,
  projects,
  fileTarget,
  filesRefreshToken,
  spaces,
  workspaces,
  activeWorkspaceId,
  status,
}: WorkspacePanelProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-center border-b border-border pr-1.5">
        <WorkConsoleTabs
          spaces={spaces}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={onSelectWorkspace}
          filesActive={filesActive}
          onSelectFiles={onSelectFiles}
          filesLabel={
            projectId
              ? t('workspace.projectTab', { defaultValue: '项目' })
              : t('workspace.artifactsTab', { defaultValue: '产物' })
          }
        />
        <IconButton
          size="icon-xs"
          onClick={onCollapse}
          className="ml-1 shrink-0 text-muted-foreground"
          title={t('workspace.collapse')}
          aria-label={t('workspace.collapse')}
        >
          <PanelRightClose className="size-3.5" />
        </IconButton>
      </div>
      {/* Both views stay mounted so switching tabs keeps the open file and the
          tree expansion (only closing the whole panel resets them). */}
      <div className="relative min-h-0 flex-1">
        <div className={cn('absolute inset-0 flex flex-col', filesActive ? '' : 'hidden')}>
          <WorkspaceFilesDrawer
            key={`${conversationId}:${projectId ?? 'conversation'}`}
            embedded
            open
            onOpenChange={() => {}}
            presentation={presentation}
            conversationId={conversationId}
            conversationTitle={conversationTitle}
            projectId={projectId}
            projects={projects}
            target={fileTarget}
            refreshToken={filesRefreshToken}
          />
        </div>
        {workspaces.length ? (
          <div className={cn('absolute inset-0 flex flex-col', filesActive ? 'hidden' : '')}>
            <WorkConsole
              hideTabs
              spaces={spaces}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              status={status}
              onSelect={onSelectWorkspace}
              onCollapse={onCollapse}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

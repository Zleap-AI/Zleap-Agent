'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FolderOpen, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArtifactPreviewContent } from '@/components/ArtifactPreviewContent';
import { CodeView, langFromPath } from '@/components/CodeView';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { artifactPreviewKind } from '@/lib/artifactPreview';
import { cn } from '@/lib/utils';
import type { FileViewMode, PreviewState } from './types';

export function PreviewPane({
  preview,
  fileViewMode,
  onFileViewModeChange,
  rootTitle,
  singlePane = false,
  treeCollapsed,
  onToggleTree,
  onBack,
}: {
  preview: PreviewState;
  fileViewMode: FileViewMode;
  onFileViewModeChange: (mode: FileViewMode) => void;
  rootTitle: string;
  singlePane?: boolean;
  treeCollapsed?: boolean;
  onToggleTree?: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const headerProps = { fileViewMode, onFileViewModeChange, rootTitle, singlePane, treeCollapsed, onToggleTree, onBack };
  if (preview.status === 'idle') {
    return <EmptyState title={t('workspace.openFileTitle')} detail={t('workspace.openFileDetail')} />;
  }
  if (preview.status === 'loading') {
    return (
      <>
        <PreviewHeader preview={preview} {...headerProps} />
        <LoadingState label={t('workspace.openingFile')} />
      </>
    );
  }
  if (preview.status === 'error') {
    return (
      <>
        <PreviewHeader preview={preview} {...headerProps} />
        <EmptyState title={t('workspace.previewErrorTitle')} detail={preview.message} />
      </>
    );
  }
  return (
    <>
      <PreviewHeader preview={preview} {...headerProps} />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {fileViewMode === 'preview' && canPreviewFile(preview.name) ? (
          <ArtifactPreviewContent
            content={preview.content}
            path={preview.path}
            compact
            fullHeight
            className="h-full rounded-none border-0"
          />
        ) : (
          <CodeView
            code={preview.content}
            lang={langFromPath(preview.name)}
            lineNumbers
            className="h-full rounded-none border-0 bg-background text-xs leading-6"
          />
        )}
      </div>
    </>
  );
}

function PreviewHeader({
  preview,
  fileViewMode,
  onFileViewModeChange,
  rootTitle,
  singlePane,
  treeCollapsed,
  onToggleTree,
  onBack,
}: {
  preview: Exclude<PreviewState, { status: 'idle' }>;
  fileViewMode: FileViewMode;
  onFileViewModeChange: (mode: FileViewMode) => void;
  rootTitle: string;
  singlePane?: boolean;
  treeCollapsed?: boolean;
  onToggleTree?: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const toggleLabel = treeCollapsed ? t('workspace.expandTree') : t('workspace.collapseTree');
  const showModeToggle = preview.status === 'ready' && canPreviewFile(preview.name);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2 pl-2.5 text-sm">
      {singlePane ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onBack}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('workspace.back')}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('workspace.back')}</TooltipContent>
        </Tooltip>
      ) : null}
      <Breadcrumb parts={[rootTitle, ...preview.relativePath.split('/').filter(Boolean)]} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {showModeToggle ? (
          <div className="flex h-7 items-center rounded-md bg-muted p-0.5">
            <button
              type="button"
              onClick={() => onFileViewModeChange('preview')}
              className={cn(
                'h-6 rounded-sm px-2 text-xs transition-colors',
                fileViewMode === 'preview' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('workspace.previewMode')}
            </button>
            <button
              type="button"
              onClick={() => onFileViewModeChange('source')}
              className={cn(
                'h-6 rounded-sm px-2 text-xs transition-colors',
                fileViewMode === 'source' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('workspace.sourceMode')}
            </button>
          </div>
        ) : null}
        {onToggleTree ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onToggleTree}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={toggleLabel}
              >
                {treeCollapsed ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{toggleLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

export function canPreviewFile(path: string): boolean {
  return artifactPreviewKind(path) !== 'code';
}

export function defaultFileViewMode(path: string): FileViewMode {
  return canPreviewFile(path) ? 'preview' : 'source';
}

function Breadcrumb({ parts }: { parts: string[] }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <FragmentPart key={`${part}-${index}`} muted={index < parts.length - 1}>
          {part}
        </FragmentPart>
      ))}
    </div>
  );
}

function FragmentPart({ children, muted }: { children: ReactNode; muted: boolean }) {
  return (
    <>
      <span className={cn('min-w-0 truncate', muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>{children}</span>
      {muted ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
    </>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <FolderOpen className="mb-3 h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  );
}

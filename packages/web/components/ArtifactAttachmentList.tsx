'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { artifactContentType, artifactPreviewKind, artifactPreviewNeedsText, fileExtension } from '../lib/artifactPreview';
import { webApiFetch } from '../lib/api';
import type { ArtifactView } from '../lib/types';
import type { WorkspaceFileTarget } from '../lib/workspaceFiles';
import { artifactPathFromTitle, dedupeArtifactViews } from '../lib/workspaceArtifacts';
import { ArtifactPreviewContent } from './ArtifactPreviewContent';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from './ui/item';

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; message: string };

export function ArtifactAttachmentList({
  artifacts,
  onOpenWorkspaceFile,
}: {
  artifacts: ArtifactView[];
  onOpenWorkspaceFile?: (target: WorkspaceFileTarget) => void;
}) {
  const { t } = useTranslation();
  const visibleArtifacts = dedupeArtifacts(artifacts).filter(isVisibleArtifact);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});

  if (!visibleArtifacts.length) {
    return null;
  }

  const openPreview = async (artifact: ArtifactView, key: string) => {
    const path = artifactLocalPath(artifact);
    if (path && onOpenWorkspaceFile) {
      onOpenWorkspaceFile({ path, source: 'artifact' });
      return;
    }
    setPreviewKey(key);
    await loadArtifactContent(artifact, key, previews, setPreviews, t).catch(() => undefined);
  };

  const openInNewTab = async (artifact: ArtifactView, key: string) => {
    if (artifact.href) {
      window.open(artifact.href, '_blank', 'noopener,noreferrer');
      return;
    }
    const content = await loadArtifactContent(artifact, key, previews, setPreviews, t).catch(() => undefined);
    if (!content) {
      return;
    }
    const blob = blobForArtifactPreview(content, artifactPathForPreview(artifact));
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const previewArtifact = previewKey ? visibleArtifacts.find((artifact) => artifactKey(artifact) === previewKey) : undefined;

  return (
    <>
      <div className="mt-3 flex w-full max-w-xl flex-col gap-2">
        {visibleArtifacts.map((artifact) => {
          const key = artifactKey(artifact);
          const localPath = artifactLocalPath(artifact);
          const canPreview = Boolean(localPath || artifact.preview);
          const previewLabel = localPath && onOpenWorkspaceFile
            ? t('artifactList.openInFile', { defaultValue: '在文件中打开' })
            : t('artifactList.preview', { defaultValue: '预览' });
          return (
            <Item key={key} variant="outline" size="xs" className="max-w-xl bg-card shadow-xs">
              <button
                type="button"
                disabled={!canPreview}
                onClick={() => void openPreview(artifact, key)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
                aria-label={canPreview ? t('artifactList.previewAria', { defaultValue: '预览 {{title}}', title: artifact.title }) : artifact.title}
              >
                <ItemMedia variant="image" className="bg-muted text-muted-foreground">
                  <FileText />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full truncate text-xs">{artifact.title}</ItemTitle>
                  <ItemDescription className="truncate text-xs">{artifactSubtitle(artifact, t)}</ItemDescription>
                </ItemContent>
              </button>
              <ItemActions>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" aria-label={t('artifactList.openAria', { defaultValue: '打开 {{title}}', title: artifact.title })}>
                      {t('artifactList.openWith', { defaultValue: '打开方式' })}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32">
                    {canPreview ? (
                      <DropdownMenuItem onSelect={() => void openPreview(artifact, key)}>
                        {previewLabel}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => void openInNewTab(artifact, key)}>
                      <ExternalLink />
                      {t('artifactList.openNewTab', { defaultValue: '新标签打开' })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          );
        })}
      </div>
      <ArtifactPreviewDialog
        artifact={previewArtifact}
        state={previewKey ? previews[previewKey] : undefined}
        open={Boolean(previewArtifact)}
        onOpenChange={(open) => {
          if (!open) setPreviewKey(null);
        }}
      />
    </>
  );
}

function ArtifactPreviewDialog({
  artifact,
  state,
  open,
  onOpenChange,
}: {
  artifact: ArtifactView | undefined;
  state: PreviewState | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const path = artifact ? artifactPathForPreview(artifact) : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(900px,calc(100dvh-48px))] !w-[calc(100vw-32px)] !max-w-[calc(100vw-32px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:!w-[calc(100vw-48px)] sm:!max-w-[min(1400px,calc(100vw-48px))]">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="truncate text-sm">{artifact?.title ?? t('artifactList.preview', { defaultValue: '预览' })}</DialogTitle>
          <DialogDescription className="truncate text-xs">{artifact ? artifactSubtitle(artifact, t) : ''}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 bg-background">
          {!state || state.status === 'loading' ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('artifactList.opening', { defaultValue: '正在打开文件内容...' })}
            </div>
          ) : state.status === 'error' ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">{state.message}</div>
          ) : artifactPreviewKind(path) === 'html' ? (
            <div className="h-full p-3">
              <ArtifactPreviewContent content={state.content} path={path} fullHeight className="rounded-lg" />
            </div>
          ) : (
            <div className="soft-scroll h-full overflow-auto p-4">
              <ArtifactPreviewContent content={state.content} path={path} codeLineNumbers className="min-h-full" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function loadArtifactContent(
  artifact: ArtifactView,
  key: string,
  previews: Record<string, PreviewState>,
  setPreviews: (updater: (current: Record<string, PreviewState>) => Record<string, PreviewState>) => void,
  t: ReturnType<typeof useTranslation>['t'],
): Promise<string> {
  const existing = previews[key];
  if (existing?.status === 'ready') {
    return existing.content;
  }

  setPreviews((current) => ({ ...current, [key]: { status: 'loading' } }));
  try {
    const path = artifactLocalPath(artifact);
    const content = path ? await fetchLocalArtifact(path, t) : (artifact.preview ?? '');
    if (!content && (!path || artifactPreviewNeedsText(path))) {
      throw new Error(t('artifactList.noContent', { defaultValue: '没有可打开的文件内容' }));
    }
    setPreviews((current) => ({ ...current, [key]: { status: 'ready', content } }));
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPreviews((current) => ({ ...current, [key]: { status: 'error', message } }));
    throw error;
  }
}

async function fetchLocalArtifact(path: string, t: ReturnType<typeof useTranslation>['t']): Promise<string> {
  const response = await webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(path)}`);
  const data = (await response.json().catch(() => ({}))) as { content?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
  }
  if (typeof data.content !== 'string') {
    throw new Error(t('artifactList.emptyContent', { defaultValue: '文件内容为空' }));
  }
  return data.content;
}

function dedupeArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return dedupeArtifactViews(artifacts);
}

function isVisibleArtifact(artifact: ArtifactView): boolean {
  return Boolean(artifact.href || artifact.preview || artifactLocalPath(artifact));
}

function artifactKey(artifact: ArtifactView): string {
  return `${artifact.spaceId}:${artifact.id}:${artifactLocalPath(artifact) ?? artifact.href ?? artifact.title}`;
}

function artifactLocalPath(artifact: ArtifactView): string | undefined {
  return artifact.path ?? artifactPathFromTitle(artifact.title);
}

function artifactSubtitle(artifact: ArtifactView, t: ReturnType<typeof useTranslation>['t']): string {
  const path = artifactLocalPath(artifact) ?? artifact.href ?? artifact.title;
  const ext = fileExtension(path);
  if (artifact.href || artifact.kind === 'url') {
    return t('artifactList.subtitleLink', { defaultValue: '链接' });
  }
  if (ext === 'md' || ext === 'mdx') {
    return t('artifactList.subtitleDoc', { defaultValue: '文档 · {{ext}}', ext: ext.toUpperCase() });
  }
  if (artifactPreviewKind(path) === 'html') {
    return t('artifactList.subtitleWeb', { defaultValue: '网页 · {{ext}}', ext: ext.toUpperCase() });
  }
  if (artifact.kind === 'diff') {
    return ext ? t('artifactList.subtitleFile', { defaultValue: '文件 · {{ext}}', ext: ext.toUpperCase() }) : t('artifactList.subtitleFilePlain', { defaultValue: '文件' });
  }
  return ext ? t('artifactList.subtitleFile', { defaultValue: '文件 · {{ext}}', ext: ext.toUpperCase() }) : t('artifactList.subtitleFilePlain', { defaultValue: '文件' });
}

function artifactPathForPreview(artifact: ArtifactView): string {
  return artifactLocalPath(artifact) ?? artifact.title;
}

function blobForArtifactPreview(content: string, path: string): Blob {
  if (artifactPreviewKind(path) === 'html') {
    return new Blob([sandboxedHtmlPreviewDocument(content, path)], { type: 'text/html;charset=utf-8' });
  }
  return new Blob([content], { type: artifactContentType(path) });
}

function sandboxedHtmlPreviewDocument(content: string, path: string): string {
  const title = escapeHtml(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);
  const srcdoc = JSON.stringify(content).replace(/</g, '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
    body { background: #fff; }
  </style>
</head>
<body>
  <iframe id="artifact-preview" title="${title}" sandbox="allow-scripts"></iframe>
  <script>
    document.getElementById('artifact-preview').srcdoc = ${srcdoc};
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

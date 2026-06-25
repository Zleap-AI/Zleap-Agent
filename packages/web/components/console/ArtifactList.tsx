'use client';

import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, Download, ExternalLink, FileText } from 'lucide-react';
import { webApiFetch } from '../../lib/api';
import { artifactPreviewNeedsText } from '../../lib/artifactPreview';
import { isDiffResult } from '../../lib/diff';
import type { ArtifactView } from '../../lib/types';
import { artifactPathFromTitle } from '../../lib/workspaceArtifacts';
import { ArtifactPreviewContent } from '../ArtifactPreviewContent';
import { DiffBlock } from '../DiffBlock';

const ARTIFACT_PREVIEW_MAX_LINES = 240;

type RemotePreviewState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; message: string };

export function ArtifactList({ artifacts }: { artifacts: ArtifactView[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [remotePreviews, setRemotePreviews] = useState<Record<number, RemotePreviewState>>({});

  const openArtifact = artifacts.find((artifact) => artifact.id === openId);
  const openPath = openArtifact ? artifactPath(openArtifact) : undefined;

  useEffect(() => {
    if (!openArtifact || openArtifact.preview || !openPath || remotePreviews[openArtifact.id]) {
      return;
    }
    setRemotePreviews((current) => ({ ...current, [openArtifact.id]: { status: 'loading' } }));
    void webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(openPath)}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { content?: unknown; error?: unknown };
        if (!response.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
        }
        if (typeof data.content !== 'string') {
          throw new Error('artifact_content_missing');
        }
        const content = data.content;
        setRemotePreviews((current) => ({ ...current, [openArtifact.id]: { status: 'ready', content } }));
      })
      .catch((error: unknown) => {
        setRemotePreviews((current) => ({
          ...current,
          [openArtifact.id]: { status: 'error', message: error instanceof Error ? error.message : String(error) },
        }));
      });
  }, [openArtifact, openPath]);

  if (!artifacts.length) {
    return null;
  }
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Artifacts</div>
      <div className="flex flex-col gap-2">
        {artifacts.map((artifact) => {
          const resolvedPath = artifactPath(artifact);
          const remote = remotePreviews[artifact.id];
          const preview = artifact.preview ?? (remote?.status === 'ready' ? remote.content : undefined);
          const loading = remote?.status === 'loading';
          const error = remote?.status === 'error' ? remote.message : undefined;
          const hasPreview = Boolean(preview || resolvedPath || loading || error);
          const rawHref = resolvedPath ? `/api/artifacts/local?path=${encodeURIComponent(resolvedPath)}&raw=1` : undefined;
          const open = openId === artifact.id;
          return (
            <div key={artifact.id} className="overflow-hidden rounded border border-border bg-surface">
              <button
                type="button"
                disabled={!hasPreview}
                onClick={() => hasPreview && setOpenId((value) => (value === artifact.id ? null : artifact.id))}
                className={clsx(
                  'flex w-full items-start gap-2 px-2.5 py-2.5 text-left',
                  hasPreview ? 'hover:bg-console-screen/50' : 'cursor-default',
                )}
                aria-expanded={open}
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] text-ink">{artifact.title}</div>
                  {resolvedPath ? <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{resolvedPath}</div> : null}
                  <div className="mt-0.5 text-xs text-muted-foreground">{artifact.detail}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">来源 {artifact.spaceId}</span>
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                      写回 {artifact.kind === 'diff' ? '待应用' : artifact.path ? '文件产物' : '无'}
                    </span>
                    {artifact.lines ? <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">{artifact.lines}</span> : null}
                  </div>
                </div>
                {hasPreview ? (
                  <ChevronDown className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open ? '' : '-rotate-90')} />
                ) : null}
              </button>
              <div className="mx-2.5 mb-2 flex flex-wrap gap-1.5">
                {artifact.href ? (
                  <ArtifactAction href={artifact.href} label="打开链接" icon={<ExternalLink className="h-3 w-3" />} />
                ) : null}
                {rawHref ? (
                  <>
                    <ArtifactAction href={rawHref} label="打开" icon={<ExternalLink className="h-3 w-3" />} />
                    <ArtifactAction href={rawHref} label="下载" icon={<Download className="h-3 w-3" />} download />
                  </>
                ) : null}
              </div>
              {open && artifact.preview ? (
                <div className="border-t border-border px-2.5 pb-2.5">
                  <ArtifactPreview artifact={{ ...artifact, path: resolvedPath, preview }} loading={loading} error={error} />
                </div>
              ) : null}
              {open && !artifact.preview && hasPreview ? (
                <div className="border-t border-border px-2.5 pb-2.5">
                  <ArtifactPreview artifact={{ ...artifact, path: resolvedPath, preview }} loading={loading} error={error} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ArtifactAction({ href, label, icon, download }: { href: string; label: string; icon: ReactNode; download?: boolean }) {
  return (
    <a
      href={href}
      target={download ? undefined : '_blank'}
      rel={download ? undefined : 'noreferrer'}
      download={download}
      className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground hover:text-ink"
    >
      {icon}
      {label}
    </a>
  );
}

function ArtifactPreview({ artifact, loading, error }: { artifact: ArtifactView; loading?: boolean; error?: string }) {
  if (loading) {
    return <div className="mt-2 rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">读取产物内容...</div>;
  }
  if (error) {
    return <div className="mt-2 rounded-sm border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">{error}</div>;
  }
  const preview = artifact.preview ?? '';
  const path = artifact.path ?? artifact.title;
  const canRenderFromPath = Boolean(artifact.path && !artifactPreviewNeedsText(path));
  if (!preview && !canRenderFromPath) {
    return <div className="mt-2 rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">暂无可预览内容</div>;
  }
  if (artifact.kind === 'diff' && isDiffResult(preview)) {
    return <DiffBlock result={preview} maxLines={ARTIFACT_PREVIEW_MAX_LINES} />;
  }

  return (
    <div className="mt-2">
      <ArtifactPreviewContent
        content={preview}
        path={path}
        compact
        codeLineNumbers
        maxCodeLines={ARTIFACT_PREVIEW_MAX_LINES}
      />
    </div>
  );
}

function artifactPath(artifact: ArtifactView): string | undefined {
  return artifact.path ?? artifactPathFromTitle(artifact.title);
}

'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';
import { FileText, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react';
import { artifactContentType, artifactPreviewNeedsText } from '@/lib/artifactPreview';
import { deleteJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { ArtifactPreviewContent } from '@/components/ArtifactPreviewContent';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageDrawer,
  ManageEmptyState as EmptyState,
  ManageList,
  ManageListRow,
  ManagePageShell as PageShell,
  ManagePreviewBlock,
  ManageSearchBar as SearchBar,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

type ArtifactType = 'html' | 'image' | 'video' | 'text' | 'md';
type ArtifactItem = { id: string; title?: string; summary?: string; kind?: string; status?: string; contentUri?: string; createdAt?: string };

function inferType(item: ArtifactItem): ArtifactType {
  const name = `${item.title ?? ''} ${item.summary ?? ''} ${item.contentUri ?? ''}`.toLowerCase();
  if (/\.(html?|htm)\b/.test(name)) return 'html';
  if (/\.(png|jpe?g|gif|svg|webp)\b/.test(name)) return 'image';
  if (/\.(mp4|mov|webm)\b/.test(name)) return 'video';
  if (/\.md\b/.test(name)) return 'md';
  return 'text';
}

function artifactLocalPath(item: ArtifactItem): string | undefined {
  const uri = item.contentUri?.trim();
  if (!uri) return item.summary?.startsWith('/') ? item.summary : undefined;
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return undefined;
}

function openGalleryArtifact(item: ArtifactItem): void {
  const localPath = artifactLocalPath(item);
  if (!localPath) {
    if (item.contentUri && /^https?:\/\//i.test(item.contentUri)) {
      window.open(item.contentUri, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  void webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(localPath)}`)
    .then(async (response) => {
      const data = (await response.json().catch(() => ({}))) as { content?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
      }
      if (typeof data.content !== 'string') {
        throw new Error('artifact_content_missing');
      }
      const blob = new Blob([data.content], { type: artifactContentType(localPath) });
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        toast.error(i18n.t('artifactList.popupBlocked', { defaultValue: '浏览器拦截了新标签，请允许弹窗后重试。' }));
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
}

export function ArtifactPage({ onBack }: PageProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ArtifactItem | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactItem | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewContentLoading, setPreviewContentLoading] = useState(false);

  const load = () => {
    setLoading(true);
    webApiFetch('/api/artifacts')
      .then((r) => r.json())
      .then((d: { artifacts?: ArtifactItem[] }) => {
        setItems(d.artifacts ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    webApiFetch('/api/artifacts')
      .then((r) => r.json())
      .then((d: { artifacts?: ArtifactItem[] }) => {
        if (!cancelled) setItems(d.artifacts ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = items.filter((a) =>
    `${a.title ?? ''} ${a.summary ?? ''} ${a.kind ?? ''} ${a.status ?? ''}`.toLowerCase().includes(q.toLowerCase()),
  );
  const removeArtifact = async () => {
    if (!pendingDelete) return;
    const localPath = artifactLocalPath(pendingDelete);
    await deleteJson('/api/artifacts', { path: localPath, contentUri: pendingDelete.contentUri });
    toast.success(t('common.deleted', { defaultValue: '已删除' }));
    setPendingDelete(null);
    load();
  };

  const previewLocalPath = previewArtifact ? artifactLocalPath(previewArtifact) : undefined;
  const previewCanOpen = Boolean(
    previewLocalPath || (previewArtifact?.contentUri && /^https?:\/\//i.test(previewArtifact.contentUri)),
  );
  const previewTy: ArtifactType = previewArtifact ? inferType(previewArtifact) : 'text';

  useEffect(() => {
    setPreviewContent(null);
    if (!previewArtifact) return;
    const localPath = artifactLocalPath(previewArtifact);
    if (!localPath || !artifactPreviewNeedsText(localPath)) return;
    let cancelled = false;
    setPreviewContentLoading(true);
    webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(localPath)}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { content?: unknown };
        if (!cancelled && typeof data.content === 'string') setPreviewContent(data.content);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPreviewContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewArtifact]);

  return (
    <PageShell
      icon={<ImageIcon className="size-4" />}
      title={t('artifact.title')}
      subtitle={t('artifact.subtitle')}
      onBack={onBack}
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('artifact.search')} />}
    >
      {filtered.length > 0 ? (
        <ManageList>
          {filtered.map((a) => {
            const ty = inferType(a);
            const localPath = artifactLocalPath(a);
            const canOpen = Boolean(localPath || (a.contentUri && /^https?:\/\//i.test(a.contentUri)));
            return (
              <ManageListRow
                key={a.id}
                leading={ty === 'image' ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
                title={a.title || a.summary || a.id}
                badges={a.status ? <ManageStatusBadge variant="secondary" size="sm">{a.status}</ManageStatusBadge> : null}
                meta={ty}
                onOpen={() => setPreviewArtifact(a)}
                actions={
                  <>
                    {canOpen ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => openGalleryArtifact(a)} title={t('common.open', { defaultValue: '打开' })} aria-label={t('common.open', { defaultValue: '打开' })}>
                        <FileText className="size-4" />
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(a)} title={t('common.delete')} aria-label={t('common.delete')}>
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                }
              />
            );
          })}
        </ManageList>
      ) : (
        <EmptyState icon={<FileText className="size-5" />}>{loading ? t('common.loading') : t('artifact.empty')}</EmptyState>
      )}
      <ManageDrawer
        open={Boolean(previewArtifact)}
        onOpenChange={(open) => !open && setPreviewArtifact(null)}
        title={previewArtifact?.title || previewArtifact?.summary || previewArtifact?.id || ''}
        subtitle={previewLocalPath ?? previewArtifact?.summary}
        badge={
          previewArtifact?.status ? (
            <ManageStatusBadge variant="secondary" size="sm">{previewArtifact.status}</ManageStatusBadge>
          ) : null
        }
        footer={
          previewArtifact ? (
            <div className="flex w-full items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  const target = previewArtifact;
                  setPreviewArtifact(null);
                  setPendingDelete(target);
                }}
              >
                {t('common.delete')}
              </Button>
              {previewCanOpen ? (
                <Button size="sm" onClick={() => openGalleryArtifact(previewArtifact)}>
                  {t('common.open', { defaultValue: '打开' })}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {previewArtifact ? (
          <>
            <ManageDetailGrid>
              <ManageDetailItem label={t('artifact.type', { defaultValue: '类型' })} value={previewTy} />
              <ManageDetailItem label={t('artifact.status', { defaultValue: '状态' })} value={previewArtifact.status ?? '-'} />
              <ManageDetailItem label={t('artifact.path', { defaultValue: '路径' })} value={previewLocalPath ?? previewArtifact.contentUri ?? '-'} />
              <ManageDetailItem label={t('artifact.createdAt', { defaultValue: '创建时间' })} value={previewArtifact.createdAt ?? '-'} />
            </ManageDetailGrid>
            {previewLocalPath ? (
              previewContentLoading ? (
                <ManagePreviewBlock className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t('common.loading', { defaultValue: '加载中…' })}
                </ManagePreviewBlock>
              ) : (
                <ArtifactPreviewContent content={previewContent ?? ''} path={previewLocalPath} compact />
              )
            ) : previewArtifact.contentUri ? (
              <ManagePreviewBlock className="text-sm text-muted-foreground">
                {t('artifact.remoteHint', { defaultValue: '远程内容，点击下方「打开」在新标签中查看。' })}
              </ManagePreviewBlock>
            ) : null}
          </>
        ) : null}
      </ManageDrawer>
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.title ?? pendingDelete?.summary ?? '' })}
        onConfirm={async () => {
          try {
            await removeArtifact();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />
    </PageShell>
  );
}

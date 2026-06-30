'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Boxes, Pencil, Trash2 } from 'lucide-react';
import { deleteSpace } from '@/lib/services';
import { DEFAULT_SPACE_ACCENT, resolveSpaceIcon } from '@/lib/spaces';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import type { SpaceProfile } from '@/lib/useResources';
import { SpaceDialog } from './SpaceDialog';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageAddButton,
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

function SpaceLeading({ space }: { space: SpaceProfile }) {
  const Icon = resolveSpaceIcon(space.icon);
  return <Icon className="size-4 shrink-0" style={{ color: space.accent ?? DEFAULT_SPACE_ACCENT }} />;
}

export function SpacePage({ resources, avatarId, onChanged, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SpaceProfile | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SpaceProfile | null>(null);

  const filtered = resources.spaces.filter((s) => `${s.label} ${s.id}`.toLowerCase().includes(q.toLowerCase()));
  const preview = previewId ? resources.spaces.find((s) => s.id === previewId) : undefined;

  const removeSpace = async () => {
    if (!pendingDelete) return;
    await deleteSpace(pendingDelete.id);
    toast.success(t('common.deleted', { defaultValue: '已删除' }));
    setPendingDelete(null);
    onChanged();
  };

  const kindLabel = (kind: SpaceProfile['kind']) =>
    kind === 'main' ? t('space.kindMain', { defaultValue: '主空间' }) : t('space.kindWork', { defaultValue: '工作空间' });
  const openCreate = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };
  const openEdit = (space: SpaceProfile) => {
    setEditTarget(space);
    setDialogOpen(true);
  };

  return (
    <PageShell
      icon={<Boxes className="size-4" />}
      title={t('nav.space', { defaultValue: '空间' })}
      subtitle={t('space.subtitle', { defaultValue: '挂载工具与技能的工作环境；助手可绑定多个空间。' })}
      onBack={onBack}
      actions={<ManageAddButton label={t('space.new', { defaultValue: '新建空间' })} onClick={openCreate} />}
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('space.search', { defaultValue: '搜索空间…' })} />}
    >
      {filtered.length > 0 ? (
        <ManageList>
          {filtered.map((s) => (
            <ManageListRow
              key={s.id}
              leading={<SpaceLeading space={s} />}
              title={s.label}
              badges={
                <ManageStatusBadge variant={s.kind === 'main' ? 'secondary' : 'outline'} size="sm">
                  {kindLabel(s.kind)}
                </ManageStatusBadge>
              }
              meta={`${s.toolIds.length} ${t('tool.items')}`}
              onOpen={() => setPreviewId(s.id)}
              actions={
                <>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)} title={t('common.edit')} aria-label={t('common.edit')}>
                    <Pencil className="size-4" />
                  </Button>
                  {s.kind !== 'main' ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(s)} title={t('common.delete')} aria-label={t('common.delete')} className="text-destructive hover:text-destructive">
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </>
              }
            />
          ))}
        </ManageList>
      ) : (
        <EmptyState icon={<Boxes className="size-5" />}>{resources.loading ? t('common.loading') : t('space.empty', { defaultValue: '还没有空间。' })}</EmptyState>
      )}

      <ManageDrawer
        open={Boolean(preview)}
        onOpenChange={(open) => !open && setPreviewId(null)}
        title={preview?.label ?? ''}
        badge={preview ? <SpaceLeading space={preview} /> : null}
        footer={
          preview ? (
            <div className="flex w-full items-center justify-between gap-2">
              {preview.kind !== 'main' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    const target = preview;
                    setPreviewId(null);
                    setPendingDelete(target);
                  }}
                >
                  {t('common.delete')}
                </Button>
              ) : (
                <span />
              )}
              <Button
                size="sm"
                onClick={() => {
                  const target = preview;
                  setPreviewId(null);
                  openEdit(target);
                }}
              >
                {t('common.edit')}
              </Button>
            </div>
          ) : null
        }
      >
        {preview ? (
          <>
            {preview.description || preview.instructions ? (
              <ManagePreviewBlock className="text-sm leading-relaxed text-foreground">
                {preview.description || preview.instructions}
              </ManagePreviewBlock>
            ) : null}
            <ManageDetailGrid>
              <ManageDetailItem label={t('space.idLabel', { defaultValue: '标识' })} value={preview.id} />
              <ManageDetailItem label={t('space.kind', { defaultValue: '类型' })} value={kindLabel(preview.kind)} />
              <ManageDetailItem label={t('space.toolCount', { defaultValue: '工具' })} value={String(preview.toolIds.length)} />
              <ManageDetailItem label={t('space.skillCount', { defaultValue: '技能' })} value={String(preview.skillIds?.length ?? 0)} />
            </ManageDetailGrid>
          </>
        ) : null}
      </ManageDrawer>

      <SpaceDialog open={dialogOpen} onOpenChange={setDialogOpen} avatarId={avatarId} resources={resources} editTarget={editTarget} onSaved={onChanged} />
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.label ?? '' })}
        onConfirm={async () => {
          try {
            await removeSpace();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />
    </PageShell>
  );
}

'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Bot, Pencil, Trash2 } from 'lucide-react';
import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { deleteAvatar } from '@/lib/services';
import { parseAvatarTheme } from '@/lib/avatars';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { AvatarBadge } from '@/components/AvatarBadge';
import type { AvatarView } from '@/lib/useResources';
import { AvatarDialog } from './AvatarDialog';
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

export function AvatarPage({ resources, onChanged, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AvatarView | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AvatarView | null>(null);

  const filtered = resources.avatars.filter((a) => `${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase()));
  const preview = previewId ? resources.avatars.find((a) => a.id === previewId) : undefined;
  const previewTheme = preview ? parseAvatarTheme(preview.metadata) : null;
  const boundSpaces = preview?.metadata?.boundSpaceIds?.length ?? 0;
  const openCreate = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };
  const openEdit = (avatar: AvatarView) => {
    setEditTarget(avatar);
    setDialogOpen(true);
  };

  const removeAvatar = async () => {
    if (!pendingDelete) return;
    await deleteAvatar(pendingDelete.id);
    toast.success(t('common.deleted', { defaultValue: '已删除' }));
    setPendingDelete(null);
    onChanged();
  };

  return (
    <PageShell
      icon={<Bot className="size-4" />}
      title={t('nav.avatar')}
      subtitle={t('avatar.subtitle', { defaultValue: '人格面具：覆盖系统提示词的身份段，可绑定空间。' })}
      onBack={onBack}
      actions={<ManageAddButton label={t('avatar.new')} onClick={openCreate} />}
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('avatar.search', { defaultValue: '搜索助手…' })} />}
    >
      {filtered.length > 0 ? (
        <ManageList>
          {filtered.map((a) => {
            const theme = parseAvatarTheme(a.metadata);
            const isDefault = a.id === DEFAULT_AVATAR_ID;
            return (
              <ManageListRow
                key={a.id}
                leading={<AvatarBadge name={a.name} emoji={theme.emoji} accent={theme.accent} className="size-5" letterClassName="text-2xs" emojiClassName="text-sm leading-none" />}
                title={a.name}
                badges={isDefault ? <ManageStatusBadge variant="secondary" size="sm">{t('common.default', { defaultValue: '默认' })}</ManageStatusBadge> : null}
                onOpen={() => setPreviewId(a.id)}
                actions={
                  <>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(a)} title={t('common.edit')} aria-label={t('common.edit')}>
                      <Pencil className="size-4" />
                    </Button>
                    {!isDefault ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(a)} title={t('common.delete')} aria-label={t('common.delete')} className="text-destructive hover:text-destructive">
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </ManageList>
      ) : (
        <EmptyState icon={<Bot className="size-5" />}>{resources.loading ? t('common.loading') : t('avatar.empty', { defaultValue: '还没有助手。' })}</EmptyState>
      )}

      <ManageDrawer
        open={Boolean(preview)}
        onOpenChange={(open) => !open && setPreviewId(null)}
        title={preview?.name ?? ''}
        badge={preview ? <AvatarBadge name={preview.name} emoji={previewTheme?.emoji} accent={previewTheme?.accent ?? ''} className="size-5" letterClassName="text-2xs" emojiClassName="text-sm leading-none" /> : null}
        footer={
          preview ? (
            <div className="flex w-full items-center justify-between gap-2">
              {preview.id !== DEFAULT_AVATAR_ID ? (
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
            {preview.persona ? (
              <ManagePreviewBlock className="text-sm leading-relaxed text-foreground">{preview.persona}</ManagePreviewBlock>
            ) : null}
            <ManageDetailGrid>
              <ManageDetailItem label={t('avatar.idLabel', { defaultValue: '标识' })} value={preview.id} />
              <ManageDetailItem label={t('common.status', { defaultValue: '状态' })} value={preview.status ?? 'active'} />
              <ManageDetailItem label={t('avatar.boundSpaces', { defaultValue: '绑定空间' })} value={String(boundSpaces)} />
              <ManageDetailItem label={t('avatar.version', { defaultValue: '版本' })} value={preview.currentVersion != null ? `v${preview.currentVersion}` : '-'} />
            </ManageDetailGrid>
          </>
        ) : null}
      </ManageDrawer>

      <AvatarDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editTarget={editTarget}
        resources={resources}
        onSaved={() => {
          onChanged();
        }}
      />
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        onConfirm={async () => {
          try {
            await removeAvatar();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />
    </PageShell>
  );
}

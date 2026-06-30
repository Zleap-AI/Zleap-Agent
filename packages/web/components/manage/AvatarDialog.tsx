'use client';

import { useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { patchJson, postJson } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_AVATAR_ACCENT, parseAvatarTheme } from '@/lib/avatars';
import { boundSpaceIdsFromMetadata, boundSpaceIdsMetadataPatch } from '@/lib/avatarSpaceBindings';
import type { AvatarView, Resources } from '@/lib/useResources';
import { useEntityFormDialog } from '@/hooks/useEntityFormDialog';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm } from './manage-ui';
import { AvatarThemePicker } from './AvatarThemePicker';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

type AvatarDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTarget?: AvatarView | null;
  resources?: Resources;
  onSaved: (avatarId?: string) => void;
};

type AvatarForm = { name: string; emoji?: string; accent: string; persona: string; boundSpaceIds: string[] };

/** Create a new Avatar — a persona mask. It only overrides the identity segment
 *  of the system prompt; it owns no spaces, tools, or memory. The id is derived
 *  from the name (store-owned), never hand-typed. */
export function AvatarDialog({ open, onOpenChange, editTarget, resources, onSaved }: AvatarDialogProps) {
  const { t } = useTranslation();
  const editing = Boolean(editTarget);
  const spaceOptions: MultiSelectOption[] = useMemo(
    () =>
      (resources?.spaces ?? []).map((space) => ({
        value: space.id,
        label: space.label,
        hint: space.kind === 'main' ? 'Main' : space.id,
      })),
    [resources?.spaces],
  );
  const { values, patch, busy, submit } = useEntityFormDialog<AvatarForm>({
    open,
    initial: () => {
      const theme = parseAvatarTheme(editTarget?.metadata);
      return {
        name: editTarget?.name ?? '',
        emoji: theme.emoji,
        accent: theme.accent ?? DEFAULT_AVATAR_ACCENT,
        persona: editTarget?.persona ?? '',
        boundSpaceIds: boundSpaceIdsFromMetadata(editTarget?.metadata) ?? [],
      };
    },
    onSubmit: async (form) => {
      const trimmedName = form.name.trim();
      if (!trimmedName) throw new Error(t('common.required'));
      if (editTarget) {
        await patchJson('/api/avatar', {
          id: editTarget.id,
          name: trimmedName,
          persona: form.persona.trim() || undefined,
          metadata: { emoji: form.emoji ?? '', accent: form.accent, ...boundSpaceIdsMetadataPatch(form.boundSpaceIds) },
        });
        toast.success(`${trimmedName} ✓`);
        onSaved(editTarget.id);
        return;
      }
      const id = slugify(trimmedName);
      if (!id) throw new Error(t('common.required'));
      const data = (await postJson('/api/avatar', {
        id,
        name: trimmedName,
        persona: form.persona.trim() || undefined,
        metadata: { emoji: form.emoji ?? '', accent: form.accent, ...boundSpaceIdsMetadataPatch(form.boundSpaceIds) },
      })) as { profile?: { id: string } };
      toast.success(`${form.name} ✓`);
      onSaved(data.profile?.id);
    },
    onSuccess: () => onOpenChange(false),
  });

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      expandable
      title={editing ? t('avatar.editTitle') : t('avatar.new')}
      description={editing ? t('avatar.editDesc', { defaultValue: '更新助手的人格、图标和空间绑定。' }) : t('avatar.newDesc')}
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={() => void submit()}
          confirmLabel={editing ? t('common.saveChanges') : t('common.create')}
          busy={busy}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('common.name')} htmlFor="avatar-name">
          <Input
            id="avatar-name"
            value={values.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Researcher"
            autoFocus
          />
        </ManageField>

        <AvatarThemePicker
          emoji={values.emoji}
          accent={values.accent}
          onEmojiChange={(emoji) => patch({ emoji })}
          onAccentChange={(accent) => patch({ accent })}
        />

        {resources ? (
          <ManageField label={t('avatar.spaces', { defaultValue: '绑定空间' })} description={t('avatar.spacesHint')}>
            <MultiSelect
              options={spaceOptions}
              selected={values.boundSpaceIds}
              onChange={(boundSpaceIds) => patch({ boundSpaceIds })}
              placeholder={t('avatar.mountSpaces')}
              emptyText={t('avatar.noSpaces')}
            />
          </ManageField>
        ) : null}

        <ManageField label={t('avatar.persona')} htmlFor="avatar-persona" description={t('avatar.personaHint')}>
          <Textarea
            id="avatar-persona"
            value={values.persona}
            onChange={(e) => patch({ persona: e.target.value })}
            rows={6}
            placeholder={t('avatar.personaPlaceholder')}
          />
        </ManageField>
      </ManageForm>
    </ManageDialog>
  );
}

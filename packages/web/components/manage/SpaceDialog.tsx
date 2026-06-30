'use client';

import { useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { patchJson, postJson } from '@/lib/api';
import { DEFAULT_SPACE_ACCENT, DEFAULT_SPACE_ICON } from '@/lib/spaces';
import type { Resources, SpaceProfile } from '@/lib/useResources';
import { llmModels, modelDisplayLabel } from '@/lib/models';
import { useEntityFormDialog } from '@/hooks/useEntityFormDialog';
import { SpaceThemePicker } from './SpaceThemePicker';
import { ToolTreeSelect } from './ToolTreeSelect';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm } from './manage-ui';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type SpaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  resources: Resources;
  editTarget?: SpaceProfile | null;
  onSaved: () => void;
};

type SpaceForm = {
  label: string;
  icon: string;
  accent: string;
  routingCard: string;
  instructions: string;
  modelConfigId: string;
  toolSetIds: string[];
  toolIds: string[];
  skillIds: string[];
  autoMountSkills: boolean;
};

const DEFAULT_SPACE_MODEL_VALUE = '__zleap_default_space_model__';

/** Create or edit a Space: its identity + instructions, and the global Tools /
 *  Skills it mounts (picked from the resource catalog). The id is derived from
 *  the name on create, and the store owns it. */
export function SpaceDialog({ open, onOpenChange, avatarId, resources, editTarget, onSaved }: SpaceDialogProps) {
  const { t } = useTranslation();
  const editing = Boolean(editTarget);

  const skillOptions: MultiSelectOption[] = useMemo(
    () => resources.skills.map((s) => ({ value: s.id, label: s.label })),
    [resources.skills],
  );
  const modelOptions = useMemo(() => llmModels(resources.models), [resources.models]);

  const { values, patch, busy, submit } = useEntityFormDialog<SpaceForm>({
    open,
    initial: () => {
      const selectedToolIds = [
        ...(editTarget?.directToolIds ?? editTarget?.toolIds ?? []),
        ...(editTarget?.mcpToolIds ?? []),
      ];
      return {
        label: editTarget?.label ?? '',
        icon: editTarget?.icon ?? DEFAULT_SPACE_ICON,
        accent: editTarget?.accent ?? DEFAULT_SPACE_ACCENT,
        routingCard: editTarget?.routingCard ?? editTarget?.description ?? '',
        instructions: editTarget?.instructions ?? '',
        modelConfigId: editTarget?.modelConfigId ?? '',
        toolSetIds: editTarget?.toolSetIds ?? [],
        toolIds: selectedToolIds,
        skillIds: editTarget?.skillIds ?? [],
        autoMountSkills: editTarget?.autoMountSkills !== false,
      };
    },
    onSubmit: async (form) => {
      const trimmedLabel = form.label.trim();
      if (!trimmedLabel) throw new Error(t('common.required'));
      const mcpToolSet = new Set(resources.tools.filter((tool) => tool.origin === 'mcp').map((tool) => tool.id));
      const builtinToolIds = form.toolIds.filter((id) => !mcpToolSet.has(id));
      const mcpToolIds = form.toolIds.filter((id) => mcpToolSet.has(id));
      const capabilities = [
        ...form.skillIds.map((sid) => ({ type: 'skill', id: sid })),
        ...mcpToolIds.map((id) => ({ type: 'mcp_tool', id })),
      ];
      if (editTarget) {
        const id = editTarget.storageId ?? editTarget.id;
        await patchJson('/api/spaces', {
          id,
          label: editTarget.kind === 'main' ? undefined : trimmedLabel,
          icon: form.icon,
          accent: form.accent,
          modelConfigId: form.modelConfigId || null,
          routingCard: form.routingCard.trim() || undefined,
          description: form.routingCard.trim() || undefined,
          instructions: form.instructions.trim() || undefined,
          autoMountSkills: form.autoMountSkills,
        });
        if (editTarget.kind !== 'main') {
          await postJson('/api/spaces/capabilities', {
            avatarId,
            spaceId: id,
            toolSetIds: form.toolSetIds,
            toolIds: builtinToolIds,
            capabilities,
          });
        }
      } else {
        const id = slugify(trimmedLabel);
        if (!id) throw new Error(t('common.required'));
        await postJson('/api/spaces', {
          avatarId,
          id,
          label: trimmedLabel,
          icon: form.icon,
          accent: form.accent,
          modelConfigId: form.modelConfigId || null,
          routingCard: form.routingCard.trim() || undefined,
          description: form.routingCard.trim() || undefined,
          instructions: form.instructions.trim() || undefined,
          toolSetIds: form.toolSetIds,
          toolIds: builtinToolIds,
          autoMountSkills: form.autoMountSkills,
          capabilities,
        });
      }
      toast.success(`${form.label} ✓`);
      onSaved();
    },
    onSuccess: () => onOpenChange(false),
  });

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      expandable
      title={editing ? t('space.editTitle') : t('space.new')}
      description={editing ? t('space.editDesc', { defaultValue: '更新空间的说明、工具和技能挂载。' }) : t('space.newDesc')}
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
        <ManageField label={t('common.name')} htmlFor="space-label">
          <Input
            id="space-label"
            value={values.label}
            onChange={(e) => patch({ label: e.target.value })}
            disabled={editTarget?.kind === 'main'}
            placeholder="Research"
            autoFocus
          />
        </ManageField>

        <SpaceThemePicker
          icon={values.icon}
          accent={values.accent}
          onIconChange={(icon) => patch({ icon })}
          onAccentChange={(accent) => patch({ accent })}
        />

        <ManageField label={t('space.routing')} htmlFor="space-routing">
          <Input
            id="space-routing"
            value={values.routingCard}
            onChange={(e) => patch({ routingCard: e.target.value })}
            placeholder={t('space.routingPlaceholder')}
          />
        </ManageField>

        <ManageField label={t('space.model')} description={t('space.modelHint')}>
          <Select
            value={values.modelConfigId || DEFAULT_SPACE_MODEL_VALUE}
            onValueChange={(value) => patch({ modelConfigId: value === DEFAULT_SPACE_MODEL_VALUE ? '' : value })}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder={t('space.modelDefault')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_SPACE_MODEL_VALUE}>{t('space.modelDefault')}</SelectItem>
              {modelOptions.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {modelDisplayLabel(model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ManageField>

        {editTarget?.kind === 'main' ? null : (
          <>
            <ManageField label={t('space.tools')}>
              <ToolTreeSelect
                toolSets={resources.toolSets}
                tools={resources.tools}
                mcpServers={resources.mcpServers}
                selectedToolSetIds={values.toolSetIds}
                selectedToolIds={values.toolIds}
                onChange={({ toolSetIds: nextSets, toolIds: nextTools }) =>
                  patch({ toolSetIds: nextSets, toolIds: nextTools })
                }
              />
            </ManageField>

            <ManageField label={t('space.skills')}>
              <MultiSelect
                options={skillOptions}
                selected={values.skillIds}
                onChange={(skillIds) => patch({ skillIds })}
                placeholder={t('space.mountSkills')}
                emptyText={t('space.noSkills')}
              />
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t('space.autoMountSkills')}</div>
                  <div className="text-xs text-muted-foreground">{t('space.autoMountSkillsHint')}</div>
                </div>
                <Switch checked={values.autoMountSkills} onCheckedChange={(autoMountSkills) => patch({ autoMountSkills })} />
              </div>
            </ManageField>
          </>
        )}

        <ManageField label={t('space.instructions')} htmlFor="space-instructions">
          <Textarea
            id="space-instructions"
            value={values.instructions}
            onChange={(e) => patch({ instructions: e.target.value })}
            rows={6}
            placeholder={t('space.instructionsPlaceholder')}
          />
        </ManageField>
      </ManageForm>
    </ManageDialog>
  );
}

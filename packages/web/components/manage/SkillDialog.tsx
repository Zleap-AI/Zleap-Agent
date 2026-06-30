'use client';

import { useEffect, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson } from '@/lib/api';
import type { Resources } from '@/lib/useResources';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { ToolTreeSelect } from './ToolTreeSelect';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm } from './manage-ui';

type SkillDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  resources: Resources;
  onSaved: () => void;
};

/** Create a Skill — procedural "how-to" knowledge that can orchestrate Tools.
 *  The id is derived from the name (store-owned), never hand-typed. */
export function SkillDialog({ open, onOpenChange, avatarId, resources, onSaved }: SkillDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'manual' | 'package'>('manual');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [packageRoot, setPackageRoot] = useState('');
  const [skillMd, setSkillMd] = useState('');
  const [openaiYaml, setOpenaiYaml] = useState('');
  const [bindToSpaceId, setBindToSpaceId] = useState('__none__');
  const [toolSetIds, setToolSetIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('manual');
    setLabel('');
    setDescription('');
    setInstructions('');
    setPackageRoot('');
    setSkillMd('');
    setOpenaiYaml('');
    setBindToSpaceId('__none__');
    setToolSetIds([]);
    setToolIds([]);
  }, [open]);

  const toolById = useMemo(() => new Map(resources.tools.map((tool) => [tool.id, tool])), [resources.tools]);
  const expandedToolIds = useMemo(
    () => [
      ...new Set([
        ...toolIds,
        ...toolSetIds.flatMap((id) =>
          (resources.toolSets.find((set) => set.id === id)?.toolIds ?? []).filter((toolId) => {
            const tool = toolById.get(toolId);
            return tool && tool.enabled !== false;
          }),
        ),
      ]),
    ],
    [resources.toolSets, toolById, toolIds, toolSetIds],
  );

  const submit = async () => {
    const bindTarget = bindToSpaceId === '__none__' ? undefined : bindToSpaceId;
    if (mode === 'package') {
      if (!packageRoot.trim() && !skillMd.trim()) {
        toast.error(t('common.required'));
        return;
      }
      setBusy(true);
      try {
        const res = (await postJson('/api/skills/import', {
          avatarId,
          root: packageRoot.trim() || undefined,
          skillMd: skillMd.trim() || undefined,
          openaiYaml: openaiYaml.trim() || undefined,
          sourceType: 'imported',
          trustStatus: 'review_required',
          bindToSpaceId: bindTarget,
        })) as { skill?: { label?: string } };
        toast.success(`${res.skill?.label ?? t('skill.new')} ✓`);
        onSaved();
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    const id = slugify(label);
    if (!label.trim() || !id) {
      toast.error(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await postJson('/api/skills', {
        avatarId,
        id,
        label: label.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim() || undefined,
        toolIds: expandedToolIds,
        bindToSpaceId: bindTarget,
      });
      toast.success(`${label} ✓`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const spaceBindingField = (
    <ManageField label={t('space.title', { defaultValue: '空间' })}>
      <Select value={bindToSpaceId} onValueChange={setBindToSpaceId}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="__none__">{t('skill.noSpaceBinding', { defaultValue: '不绑定空间' })}</SelectItem>
            {resources.spaces.map((space) => (
              <SelectItem key={space.storageId} value={space.storageId}>
                {space.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </ManageField>
  );

  return (
    <>
      <ManageDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('skill.new')}
        description={t('skill.newDesc')}
        expandable
        footer={
          <ManageDialogFooterActions
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            confirmLabel={t('common.create')}
            busy={busy}
          />
        }
      >
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as 'manual' | 'package')}
          className="flex min-h-[480px] w-full flex-col gap-3"
        >
          <TabsList className="grid h-8 w-full shrink-0 grid-cols-2">
            <TabsTrigger value="manual">{t('skill.manual', { defaultValue: '自建' })}</TabsTrigger>
            <TabsTrigger value="package">{t('skill.package', { defaultValue: '上传' })}</TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="mt-0 outline-none">
            <ManageForm>
              <ManageField label={t('common.name')} htmlFor="skill-label">
                <Input id="skill-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Repo review" autoFocus />
              </ManageField>

              <ManageField label={t('common.description')} htmlFor="skill-desc">
                <Input id="skill-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('skill.descPlaceholder')} />
              </ManageField>

              <ManageField label={t('skill.toolsUsed')}>
                <ToolTreeSelect
                  toolSets={resources.toolSets}
                  tools={resources.tools}
                  mcpServers={resources.mcpServers}
                  selectedToolSetIds={toolSetIds}
                  selectedToolIds={toolIds}
                  onChange={(next) => {
                    setToolSetIds(next.toolSetIds);
                    setToolIds(next.toolIds);
                  }}
                />
              </ManageField>

              <ManageField label={t('skill.instructions')} htmlFor="skill-instructions">
                <Textarea
                  id="skill-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={8}
                  placeholder={t('skill.instructionsPlaceholder')}
                />
              </ManageField>
              {spaceBindingField}
            </ManageForm>
          </TabsContent>

          <TabsContent value="package" className="mt-0 outline-none">
            <ManageForm>
              <ManageField
                label={t('skill.packageRoot', { defaultValue: '本地技能目录路径' })}
                htmlFor="skill-root"
                description={t('skill.packageRootHint', { defaultValue: '填写目录时会读取其中的 SKILL.md、references、scripts、assets。' })}
              >
                <InputGroup className="h-9 font-mono text-xs">
                  <InputGroupInput
                    id="skill-root"
                    value={packageRoot}
                    onChange={(e) => setPackageRoot(e.target.value)}
                    placeholder="~/Documents/Zleap/skills/repo-review"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      title={t('skill.chooseLocalRoot', { defaultValue: '选择本地技能目录' })}
                      aria-label={t('skill.chooseLocalRoot', { defaultValue: '选择本地技能目录' })}
                      onClick={() => setPickerOpen(true)}
                    >
                      <FolderOpen />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </ManageField>

              <ManageField label="SKILL.md" htmlFor="skill-md">
                <Textarea
                  id="skill-md"
                  value={skillMd}
                  onChange={(e) => setSkillMd(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                  placeholder={'---\nname: repo-review\ndescription: Review a repository and produce actionable findings.\n---\n\n# Repo review\n\n...'}
                />
              </ManageField>

              <ManageField label="agents/openai.yaml" htmlFor="skill-openai-yaml">
                <Textarea
                  id="skill-openai-yaml"
                  value={openaiYaml}
                  onChange={(e) => setOpenaiYaml(e.target.value)}
                  rows={4}
                  className="font-mono text-xs"
                  placeholder={t('skill.openaiYamlOptional', { defaultValue: '可选：OpenAI/Codex 兼容配置' })}
                />
              </ManageField>
              {spaceBindingField}
            </ManageForm>
          </TabsContent>

        </Tabs>
      </ManageDialog>
      <ProjectFolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={packageRoot.trim() || undefined}
        defaultPreset="skills"
        onSelect={setPackageRoot}
      />
    </>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bot, Boxes, Folder, Save, Trash2 } from 'lucide-react';
import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { postJson, patchJson, deleteJson } from '@/lib/api';
import { llmModels, modelDisplayLabel } from '@/lib/models';
import type { Resources } from '@/lib/useResources';
import { DEFAULT_SPACE_ACCENT, DEFAULT_SPACE_ICON, resolveSpaceIcon } from '@/lib/spaces';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';
import { AvatarBadge } from '@/components/AvatarBadge';
import { DEFAULT_AVATAR_ACCENT, parseAvatarTheme } from '@/lib/avatars';
import { boundSpaceIdsFromMetadata, boundSpaceIdsMetadataPatch } from '@/lib/avatarSpaceBindings';
import { parseProjectTheme } from '@/lib/projects';

function normalizeEmojiDraft(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return [...trimmed].slice(0, 1).join('');
}
import { AvatarThemePicker, type AvatarThemePickerHandle } from './AvatarThemePicker';
import { SpaceThemePicker } from './SpaceThemePicker';
import { ToolTreeSelect } from './ToolTreeSelect';
import { ManageField } from './manage-ui';

export type EditKind = 'space' | 'avatar' | 'project';

type EditProps = {
  id: string;
  resources: Resources;
  avatarId: string;
  onChanged: () => void;
  onBack: () => void;
  onOpenToolPage?: () => void;
};

/* ── shared edit chrome ──────────────────────────────────────────────── */

function EditShell({
  icon,
  title,
  subtitle,
  onBack,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="soft-scroll h-full overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/85 px-5 py-3 backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title={t('common.back')} aria-label={t('common.back')}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      <div className="mx-auto max-w-2xl px-6 py-8">{children}</div>
    </div>
  );
}

/** Order-insensitive set equality, for diffing mount lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((item) => set.has(item));
}

function SaveAction({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button size="icon-lg" onClick={onClick} disabled={disabled} title={t('common.saveChanges')} aria-label={t('common.saveChanges')}>
      <Save className="size-4" />
    </Button>
  );
}

/* ── Space edit ──────────────────────────────────────────────────────── */

const DEFAULT_SPACE_MODEL_VALUE = '__zleap_default_space_model__';

export function SpaceEditPage({ id, resources, avatarId, onChanged, onBack, onOpenToolPage }: EditProps) {
  const { t } = useTranslation();
  const space = resources.spaces.find((s) => s.id === id || s.storageId === id);
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState(DEFAULT_SPACE_ICON);
  const [accent, setAccent] = useState(DEFAULT_SPACE_ACCENT);
  const [modelConfigId, setModelConfigId] = useState('');
  const [routing, setRouting] = useState('');
  const [instructions, setInstructions] = useState('');
  const [toolSetIds, setToolSetIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [autoMountSkills, setAutoMountSkills] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setLabel(space?.label ?? '');
    setIcon(space?.icon ?? DEFAULT_SPACE_ICON);
    setAccent(space?.accent ?? DEFAULT_SPACE_ACCENT);
    setModelConfigId(space?.modelConfigId ?? '');
    setRouting(space?.routingCard ?? '');
    setInstructions(space?.instructions ?? '');
    setToolSetIds(space?.toolSetIds ?? []);
    // Builtin direct tools + mounted MCP tools share one picker; combine both so
    // MCP mounts survive a reload (they are stored as mcp_tool capabilities).
    setToolIds([...(space?.directToolIds ?? space?.toolIds ?? []), ...(space?.mcpToolIds ?? [])]);
    setSkillIds(space?.skillIds ?? []);
    setAutoMountSkills(space?.autoMountSkills !== false);
  }, [space?.id]);

  const skillOptions: MultiSelectOption[] = useMemo(() => resources.skills.map((s) => ({ value: s.id, label: s.label })), [resources.skills]);
  const modelOptions = useMemo(() => llmModels(resources.models), [resources.models]);

  if (!space) {
    return (
      <EditShell icon={<Boxes className="size-4" />} title={id} onBack={onBack}>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </EditShell>
    );
  }

  const save = async () => {
    setBusy(true);
    try {
      // Sequential, not parallel: each call writes a new space version off the
      // current one. Running them together races two bumps onto the same base
      // version and the loser's changes vanish. PATCH writes the metadata/theme
      // first; the capabilities rebind then layers on top, preserving it.
      await patchJson('/api/spaces', {
        id: space.storageId ?? space.id,
        label: label.trim() || undefined,
        icon,
        accent,
        modelConfigId: modelConfigId || null,
        routingCard: routing.trim() || undefined,
        instructions: instructions.trim() || undefined,
        autoMountSkills,
      });
      if (space.kind !== 'main') {
        // The picker mixes builtin tools and MCP tools. Split on save: builtin go
        // in toolIds; MCP tools are bound as `mcp_tool` capabilities (their real
        // type) alongside skills — otherwise the backend's builtin-only filter
        // would drop them.
        const mcpToolSet = new Set(resources.tools.filter((tool) => tool.origin === 'mcp').map((tool) => tool.id));
        const builtinToolIds = toolIds.filter((id) => !mcpToolSet.has(id));
        const mcpToolIds = toolIds.filter((id) => mcpToolSet.has(id));
        await postJson('/api/spaces/capabilities', {
          avatarId,
          spaceId: space.id,
          toolSetIds,
          toolIds: builtinToolIds,
          capabilities: [
            ...skillIds.map((sid) => ({ type: 'skill', id: sid })),
            ...mcpToolIds.map((id) => ({ type: 'mcp_tool', id })),
          ],
        });
      }
      toast.success(`${label || space.label} ✓`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The main space is seed-managed and backend-protected; it cannot be removed.
  const canDelete = space.kind !== 'main';
  const remove = async () => {
    setBusy(true);
    try {
      await deleteJson('/api/spaces', { id: space.storageId ?? space.id });
      toast.success(t('common.delete'));
      onChanged();
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const SpaceIcon = resolveSpaceIcon(icon);

  // Save is enabled only when the form actually diverges from the stored space.
  const dirty =
    label !== (space.label ?? '') ||
    icon !== (space.icon ?? DEFAULT_SPACE_ICON) ||
    accent !== (space.accent ?? DEFAULT_SPACE_ACCENT) ||
    modelConfigId !== (space.modelConfigId ?? '') ||
    routing !== (space.routingCard ?? '') ||
    instructions !== (space.instructions ?? '') ||
    !sameSet(toolSetIds, space.toolSetIds ?? []) ||
    !sameSet(toolIds, [...(space.directToolIds ?? space.toolIds ?? []), ...(space.mcpToolIds ?? [])]) ||
    !sameSet(skillIds, space.skillIds ?? []) ||
    autoMountSkills !== (space.autoMountSkills !== false);

  return (
    <EditShell
      icon={<SpaceIcon className="size-4" style={{ color: accent }} />}
      title={space.label}
      subtitle={space.id}
      onBack={onBack}
      actions={
        <div className="flex gap-2">
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteOpen(true)}
              disabled={busy}
              title={t('common.delete')}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
          <SaveAction onClick={save} disabled={busy || !dirty} />
        </div>
      }
    >
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: space.label })}
        onConfirm={remove}
      />
      <div className="space-y-6">
        <ManageField label={t('common.name')}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} disabled={space.kind === 'main'} />
        </ManageField>
        <SpaceThemePicker icon={icon} accent={accent} onIconChange={setIcon} onAccentChange={setAccent} />
        <ManageField label={t('space.model')} description={t('space.modelHint')}>
          <Select
            value={modelConfigId || DEFAULT_SPACE_MODEL_VALUE}
            onValueChange={(value) => setModelConfigId(value === DEFAULT_SPACE_MODEL_VALUE ? '' : value)}
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
        <ManageField label={t('space.routing')}>
          <Input value={routing} onChange={(e) => setRouting(e.target.value)} placeholder={t('space.routingPlaceholder')} />
        </ManageField>
        {space.kind === 'main' ? null : (
          <>
            <ManageField label={t('space.tools')}>
              <ToolTreeSelect
                toolSets={resources.toolSets}
                tools={resources.tools}
                mcpServers={resources.mcpServers}
                selectedToolSetIds={toolSetIds}
                selectedToolIds={toolIds}
                onOpenToolPage={onOpenToolPage}
                onChange={({ toolSetIds: nextSets, toolIds: nextTools }) => {
                  setToolSetIds(nextSets);
                  setToolIds(nextTools);
                }}
              />
            </ManageField>
            <ManageField label={t('space.skills')}>
              <MultiSelect options={skillOptions} selected={skillIds} onChange={setSkillIds} placeholder={t('space.mountSkills')} emptyText={t('space.noSkills')} />
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{t('space.autoMountSkills')}</div>
                  <div className="text-xs text-muted-foreground">{t('space.autoMountSkillsHint')}</div>
                </div>
                <Switch checked={autoMountSkills} onCheckedChange={setAutoMountSkills} />
              </div>
            </ManageField>
          </>
        )}
        <ManageField label={t('space.instructions')}>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-[300px]"
            placeholder={t('space.instructionsPlaceholder')}
          />
        </ManageField>
      </div>
    </EditShell>
  );
}

/* ── Avatar edit ─────────────────────────────────────────────────────── */

export function AvatarEditPage({ id, resources, onChanged, onBack }: EditProps) {
  const { t } = useTranslation();
  const avatar = resources.avatars.find((a) => a.id === id);
  const meta = avatar?.metadata;
  const persona = avatar?.persona;

  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>();
  const [emojiDraft, setEmojiDraft] = useState('');
  const [accent, setAccent] = useState(DEFAULT_AVATAR_ACCENT);
  const [personaText, setPersonaText] = useState('');
  const [boundSpaceIds, setBoundSpaceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const themePickerRef = useRef<AvatarThemePickerHandle>(null);

  useEffect(() => {
    if (!avatar) return;
    const theme = parseAvatarTheme(avatar.metadata);
    setName(avatar.name ?? '');
    setEmoji(theme.emoji);
    setEmojiDraft(theme.emoji ?? '');
    setAccent(theme.accent);
    setPersonaText(avatar.persona ?? '');
    setBoundSpaceIds(boundSpaceIdsFromMetadata(avatar.metadata) ?? []);
  }, [avatar?.id, avatar?.currentVersion]);

  const spaceOptions: MultiSelectOption[] = useMemo(
    () =>
      resources.spaces.map((space) => ({
        value: space.id,
        label: space.label,
        hint: space.kind === 'main' ? 'Main' : space.id,
      })),
    [resources.spaces],
  );

  if (!avatar) {
    return (
      <EditShell icon={<Bot className="size-4" />} title={id} onBack={onBack}>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </EditShell>
    );
  }

  const save = async () => {
    const committedEmoji = themePickerRef.current?.commitEmoji() ?? emoji;
    setBusy(true);
    try {
      await patchJson('/api/avatar', {
        id,
        name: name.trim() || undefined,
        persona: personaText.trim() || undefined,
        metadata: { emoji: committedEmoji ?? '', accent, ...boundSpaceIdsMetadataPatch(boundSpaceIds) },
      });
      toast.success(`${name} ✓`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The default avatar is seed-managed and backend-protected; it cannot be removed.
  const canDelete = avatar.id !== DEFAULT_AVATAR_ID;
  const remove = async () => {
    setBusy(true);
    try {
      await deleteJson('/api/avatar', { id });
      toast.success(t('common.delete'));
      onChanged();
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const storedTheme = parseAvatarTheme(meta);
  const dirty =
    name !== (avatar.name ?? '') ||
    normalizeEmojiDraft(emojiDraft) !== storedTheme.emoji ||
    accent !== storedTheme.accent ||
    personaText !== (persona ?? '') ||
    !sameSet(boundSpaceIds, boundSpaceIdsFromMetadata(meta) ?? []);

  return (
    <EditShell
      icon={
        <AvatarBadge
          name={name || avatar.name}
          emoji={emoji}
          accent={accent}
          className="size-8"
          letterClassName="text-sm"
          emojiClassName="text-lg"
        />
      }
      title={name || avatar.name}
      subtitle={avatar.id}
      onBack={onBack}
      actions={
        <div className="flex gap-2">
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteOpen(true)}
              disabled={busy}
              title={t('common.delete')}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
          <SaveAction onClick={save} disabled={busy || !dirty} />
        </div>
      }
    >
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: avatar.name })}
        onConfirm={remove}
      />
      <div className="space-y-6">
        <ManageField label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </ManageField>
        <AvatarThemePicker
          commitRef={themePickerRef}
          emoji={emoji}
          accent={accent}
          onEmojiChange={setEmoji}
          onEmojiDraftChange={setEmojiDraft}
          onAccentChange={setAccent}
        />
        <ManageField label={t('avatar.spaces')} description={t('avatar.spacesHint')}>
          <MultiSelect
            options={spaceOptions}
            selected={boundSpaceIds}
            onChange={setBoundSpaceIds}
            placeholder={t('avatar.mountSpaces')}
            emptyText={t('avatar.noSpaces')}
          />
        </ManageField>
        <ManageField label={t('avatar.persona')} description={t('avatar.personaHint')}>
          <Textarea
            value={personaText}
            onChange={(e) => setPersonaText(e.target.value)}
            className="min-h-[300px]"
            placeholder={t('avatar.personaPlaceholder')}
          />
        </ManageField>
      </div>
    </EditShell>
  );
}

/* ── Project edit ────────────────────────────────────────────────────── */

export function ProjectEditPage({ id, resources, onChanged, onBack }: EditProps) {
  const { t } = useTranslation();
  const project = resources.projects.find((p) => p.id === id);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [spec, setSpec] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>();
  const [emojiDraft, setEmojiDraft] = useState('');
  const [accent, setAccent] = useState(DEFAULT_AVATAR_ACCENT);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const themePickerRef = useRef<AvatarThemePickerHandle>(null);

  useEffect(() => {
    if (!project) return;
    const theme = parseProjectTheme(project);
    setName(project.name ?? '');
    setPath(project.path ?? '');
    setNote(project.note ?? '');
    setSpec(project.spec ?? '');
    setEmoji(theme.emoji);
    setEmojiDraft(theme.emoji ?? '');
    setAccent(theme.accent);
  }, [project?.id, project?.updatedAt]);

  if (!project) {
    return (
      <EditShell icon={<Folder className="size-4" />} title={id} onBack={onBack}>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </EditShell>
    );
  }

  const save = async () => {
    const committedEmoji = themePickerRef.current?.commitEmoji() ?? emoji;
    setBusy(true);
    try {
      await patchJson('/api/projects', {
        id,
        name: name.trim(),
        path: path.trim(),
        note,
        spec,
        emoji: committedEmoji ?? '',
        accent,
      });
      toast.success(`${name} ✓`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const storedTheme = parseProjectTheme(project);
  const dirty =
    name !== (project.name ?? '') ||
    path !== (project.path ?? '') ||
    note !== (project.note ?? '') ||
    spec !== (project.spec ?? '') ||
    normalizeEmojiDraft(emojiDraft) !== storedTheme.emoji ||
    accent !== storedTheme.accent;

  const remove = async () => {
    setBusy(true);
    try {
      await deleteJson('/api/projects', { id });
      toast.success(t('common.delete'));
      onChanged();
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditShell
      icon={
        <AvatarBadge
          name={name || project.name}
          emoji={emoji}
          accent={accent}
          className="size-8"
          letterClassName="text-sm"
          emojiClassName="text-lg"
        />
      }
      title={name || project.name}
      subtitle={path || project.path}
      onBack={onBack}
      actions={
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDeleteOpen(true)}
            disabled={busy}
            title={t('common.delete')}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
          <SaveAction onClick={save} disabled={busy || !dirty} />
        </div>
      }
    >
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: project.name })}
        onConfirm={remove}
      />
      <div className="space-y-6">
        <ManageField label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </ManageField>
        <AvatarThemePicker
          commitRef={themePickerRef}
          emoji={emoji}
          accent={accent}
          onEmojiChange={setEmoji}
          onEmojiDraftChange={setEmojiDraft}
          onAccentChange={setAccent}
        />
        <ManageField label={t('project.path')}>
          <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" />
        </ManageField>
        <ManageField label={t('project.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('project.notePlaceholder')} />
        </ManageField>
        <ManageField label={t('project.spec')} description={t('project.specHint')}>
          <Textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            className="min-h-[300px] font-mono text-xs leading-relaxed"
            placeholder={t('project.specPlaceholder')}
          />
        </ManageField>
      </div>
    </EditShell>
  );
}

export const EDIT_PAGES: Record<EditKind, (props: EditProps) => ReactNode> = {
  space: SpaceEditPage,
  avatar: AvatarEditPage,
  project: ProjectEditPage,
};

'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson } from '@/lib/api';
import { DEFAULT_SPACE_ACCENT, DEFAULT_SPACE_ICON } from '@/lib/spaces';
import type { Resources } from '@/lib/useResources';
import { SpaceThemePicker } from './SpaceThemePicker';
import { ToolTreeSelect } from './ToolTreeSelect';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';

type SpaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  resources: Resources;
  onSaved: () => void;
};

/** Create a Space: its identity + instructions, and the global Tools / Skills it
 *  mounts (picked from the resource catalog). The id is derived from the name —
 *  the store owns it, so it is never hand-typed. Editing happens on the edit page. */
export function SpaceDialog({ open, onOpenChange, avatarId, resources, onSaved }: SpaceDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState(DEFAULT_SPACE_ICON);
  const [accent, setAccent] = useState(DEFAULT_SPACE_ACCENT);
  const [routingCard, setRoutingCard] = useState('');
  const [instructions, setInstructions] = useState('');
  const [toolSetIds, setToolSetIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [autoMountSkills, setAutoMountSkills] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel('');
    setIcon(DEFAULT_SPACE_ICON);
    setAccent(DEFAULT_SPACE_ACCENT);
    setRoutingCard('');
    setInstructions('');
    setToolSetIds([]);
    setToolIds([]);
    setSkillIds([]);
    setAutoMountSkills(true);
  }, [open]);

  const skillOptions: MultiSelectOption[] = useMemo(
    () => resources.skills.map((s) => ({ value: s.id, label: s.label })),
    [resources.skills],
  );

  const submit = async () => {
    const id = slugify(label);
    if (!label.trim() || !id) {
      toast.error(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      await postJson('/api/spaces', {
        avatarId,
        id,
        label: label.trim(),
        icon,
        accent,
        routingCard: routingCard.trim() || undefined,
        description: routingCard.trim() || undefined,
        instructions: instructions.trim() || undefined,
        toolSetIds,
        toolIds,
        autoMountSkills,
        capabilities: skillIds.map((sid) => ({ type: 'skill', id: sid })),
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('space.new')}</DialogTitle>
          <DialogDescription>{t('space.newDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="space-label">{t('common.name')}</Label>
            <Input id="space-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Research" autoFocus />
          </div>

          <SpaceThemePicker icon={icon} accent={accent} onIconChange={setIcon} onAccentChange={setAccent} />

          <div className="space-y-1.5">
            <Label htmlFor="space-routing">{t('space.routing')}</Label>
            <Input
              id="space-routing"
              value={routingCard}
              onChange={(e) => setRoutingCard(e.target.value)}
              placeholder={t('space.routingPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('space.tools')}</Label>
            <ToolTreeSelect
              toolSets={resources.toolSets}
              tools={resources.tools}
              mcpServers={resources.mcpServers}
              selectedToolSetIds={toolSetIds}
              selectedToolIds={toolIds}
              onChange={({ toolSetIds: nextSets, toolIds: nextTools }) => {
                setToolSetIds(nextSets);
                setToolIds(nextTools);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('space.skills')}</Label>
            <MultiSelect
              options={skillOptions}
              selected={skillIds}
              onChange={setSkillIds}
              placeholder={t('space.mountSkills')}
              emptyText={t('space.noSkills')}
            />
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{t('space.autoMountSkills')}</div>
                <div className="text-xs text-muted-foreground">{t('space.autoMountSkillsHint')}</div>
              </div>
              <Switch checked={autoMountSkills} onCheckedChange={setAutoMountSkills} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="space-instructions">{t('space.instructions')}</Label>
            <Textarea
              id="space-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder={t('space.instructionsPlaceholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

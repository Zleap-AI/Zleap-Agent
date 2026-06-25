'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson } from '@/lib/api';
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
import { DEFAULT_AVATAR_ACCENT } from '@/lib/avatars';
import { AvatarThemePicker } from './AvatarThemePicker';

type AvatarDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (avatarId?: string) => void;
};

/** Create a new Avatar — a persona mask. It only overrides the identity segment
 *  of the system prompt; it owns no spaces, tools, or memory. The id is derived
 *  from the name (store-owned), never hand-typed. */
export function AvatarDialog({ open, onOpenChange, onSaved }: AvatarDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>();
  const [accent, setAccent] = useState(DEFAULT_AVATAR_ACCENT);
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmoji(undefined);
    setAccent(DEFAULT_AVATAR_ACCENT);
    setPersona('');
  }, [open]);

  const submit = async () => {
    const id = slugify(name);
    if (!name.trim() || !id) {
      toast.error(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      const data = (await postJson('/api/avatar', {
        id,
        name: name.trim(),
        persona: persona.trim() || undefined,
        metadata: { emoji: emoji ?? '', accent },
      })) as { profile?: { id: string } };
      toast.success(`${name} ✓`);
      onSaved(data.profile?.id);
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
          <DialogTitle>{t('avatar.new')}</DialogTitle>
          <DialogDescription>{t('avatar.newDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="avatar-name">{t('common.name')}</Label>
            <Input id="avatar-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" autoFocus />
          </div>

          <AvatarThemePicker emoji={emoji} accent={accent} onEmojiChange={setEmoji} onAccentChange={setAccent} />

          <div className="space-y-1.5">
            <Label htmlFor="avatar-persona">{t('avatar.persona')}</Label>
            <Textarea
              id="avatar-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={6}
              placeholder={t('avatar.personaPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('avatar.personaHint')}</p>
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

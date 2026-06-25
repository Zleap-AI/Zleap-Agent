'use client';

import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson, webApiFetch } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { ProjectFolderPicker } from './ProjectFolderPicker';

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (project: { id: string; name: string }) => void;
};

/** Register a project folder. The displayed project name is derived from the folder name. */
export function ProjectDialog({ open, onOpenChange, onSaved }: ProjectDialogProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [projectsRoot, setProjectsRoot] = useState('');
  const [homeDir, setHomeDir] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath('');
    void webApiFetch('/api/projects/defaults')
      .then((res) => res.json())
      .then((body: { root?: string; home?: string }) => {
        if (body.root) setProjectsRoot(body.root);
        if (body.home) setHomeDir(body.home);
      })
      .catch(() => {});
  }, [open]);

  const applyFolder = (selected: string) => {
    setPath(selected);
  };

  const submit = async () => {
    const trimmedPath = path.trim();
    const name = projectNameFromPath(trimmedPath);
    if (!trimmedPath || !name) {
      toast.error(t('common.required'));
      return;
    }
    setBusy(true);
    try {
      const body = (await postJson('/api/projects', {
        id: projectIdFromPath(name, trimmedPath),
        name,
        path: trimmedPath,
        createPath: true,
      })) as { project?: { id: string; name: string } };
      const project = body.project;
      if (!project?.id) throw new Error('project_create_failed');
      toast.success(`${name} ✓`);
      onSaved(project);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('project.new')}</DialogTitle>
            <DialogDescription>{t('project.newDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-path">{t('project.path')}</Label>
              <InputGroup className="h-9 font-mono text-xs">
                <InputGroupInput
                  id="project-path"
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                  }}
                  placeholder={projectsRoot ? `${projectsRoot}/my-project` : t('project.pathPlaceholder')}
                  autoFocus
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    title={t('project.browse')}
                    aria-label={t('project.browse')}
                    onClick={() => setPickerOpen(true)}
                  >
                    <FolderOpen className="size-4" />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <p className="text-xs text-muted-foreground">{t('project.pathHint')}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={busy}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectFolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={path.trim() || homeDir || projectsRoot}
        onSelect={applyFolder}
      />
    </>
  );
}

function projectNameFromPath(path: string): string {
  return path.replace(/[\\/]+$/g, '').split(/[\\/]/).filter(Boolean).pop()?.trim() ?? '';
}

function projectIdFromPath(name: string, path: string): string {
  const slug = slugify(name);
  if (slug) return slug;
  let hash = 0;
  for (const char of path) {
    hash = Math.imul(hash, 31) + char.codePointAt(0)!;
    hash >>>= 0;
  }
  return `project-${hash.toString(36)}`;
}

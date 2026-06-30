'use client';

import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { createProject, fetchProjectDefaults } from '@/lib/services';
import { useEntityFormDialog } from '@/hooks/useEntityFormDialog';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm } from './manage-ui';
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
  const [projectsRoot, setProjectsRoot] = useState('');
  const [homeDir, setHomeDir] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const { values, patch, busy, submit } = useEntityFormDialog<{ path: string }>({
    open,
    initial: { path: '' },
    onSubmit: async (form) => {
      const trimmedPath = form.path.trim();
      const name = projectNameFromPath(trimmedPath);
      if (!trimmedPath || !name) throw new Error(t('common.required'));
      const body = await createProject({
        id: projectIdFromPath(name, trimmedPath),
        name,
        path: trimmedPath,
        createPath: true,
      });
      const project = body.project;
      if (!project?.id) throw new Error('project_create_failed');
      toast.success(`${name} ✓`);
      onSaved(project);
    },
    onSuccess: () => onOpenChange(false),
  });

  useEffect(() => {
    if (!open) return;
    void fetchProjectDefaults().then((body) => {
      if (body.root) setProjectsRoot(body.root);
      if (body.home) setHomeDir(body.home);
    });
  }, [open]);

  return (
    <>
      <ManageDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('project.new')}
        description={t('project.newDesc')}
        footer={
          <ManageDialogFooterActions
            onCancel={() => onOpenChange(false)}
            onConfirm={() => void submit()}
            confirmLabel={t('common.create')}
            busy={busy}
          />
        }
      >
        <ManageForm>
          <ManageField label={t('project.path')} htmlFor="project-path" description={t('project.pathHint')}>
            <InputGroup className="h-9 font-mono text-xs">
              <InputGroupInput
                id="project-path"
                value={values.path}
                onChange={(e) => patch({ path: e.target.value })}
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
          </ManageField>
        </ManageForm>
      </ManageDialog>

      <ProjectFolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={values.path.trim() || homeDir || projectsRoot}
        onSelect={(selected) => patch({ path: selected })}
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

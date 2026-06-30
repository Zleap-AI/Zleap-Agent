'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { webApiFetch } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type BrowseEntry = { name: string; path: string };

type BrowseResult = {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
};

type ProjectFolderPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath?: string;
  defaultPreset?: 'skills';
  onSelect: (path: string) => void;
};

/** Server-backed directory browser — Codex-style folder picker for local paths. */
export function ProjectFolderPicker({ open, onOpenChange, initialPath, defaultPreset, onSelect }: ProjectFolderPickerProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (path) {
        params.set('path', path);
      } else if (defaultPreset) {
        params.set('preset', defaultPreset);
      }
      const suffix = params.size ? `?${params.toString()}` : '';
      const res = await webApiFetch(`/api/projects/browse${suffix}`);
      const body = (await res.json()) as BrowseResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setBrowse(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [defaultPreset]);

  useEffect(() => {
    if (!open) return;
    void load(initialPath);
  }, [open, initialPath, load]);

  const confirm = () => {
    if (!browse?.path) return;
    onSelect(browse.path);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('project.selectFolder')}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{browse?.path ?? '…'}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={!browse?.parent || loading}
            onClick={() => browse?.parent && load(browse.parent)}
            title={t('common.back')}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="truncate text-xs text-muted-foreground">{browse?.path}</span>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : error ? (
            <div className="px-3 py-6 text-center text-sm text-destructive">{error}</div>
          ) : browse?.entries.length ? (
            browse.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => load(entry.path)}
                className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-muted"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('project.emptyFolder')}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={confirm} disabled={!browse?.path || loading}>{t('project.useFolder')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

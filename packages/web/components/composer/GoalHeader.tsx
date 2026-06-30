'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PauseCircle, Pencil, PlayCircle, Target, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import type { GoalComposerState } from './types';

export function GoalHeader({
  goal,
  onChange,
  onPause,
  onResume,
  onDelete,
}: {
  goal: GoalComposerState;
  onChange?: (text: string) => void;
  onPause?: () => void;
  onResume?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal.text);
  const elapsedLabel = useGoalElapsedLabel(goal, t);

  useEffect(() => {
    if (!editing) setDraft(goal.text);
  }, [editing, goal.text]);

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next) {
      onDelete?.();
      return;
    }
    if (next !== goal.text) onChange?.(next);
  };

  const cancel = () => {
    setDraft(goal.text);
    setEditing(false);
  };

  return (
    <div className="mb-2 rounded-xl border border-border bg-card px-3 py-2 shadow-xs">
      <div className="flex min-h-7 items-center gap-2">
        <Target className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {goal.status === 'paused'
            ? t('goal.paused', { defaultValue: '已暂停的目标' })
            : t('goal.active', { defaultValue: '进行中的目标' })}
        </span>
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
            className="h-7 min-w-0 flex-1 px-2 py-1 text-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground transition hover:text-foreground"
            title={goal.text}
          >
            {goal.text}
          </button>
        )}
        {!editing ? <span className="shrink-0 text-xs text-muted-foreground">· {elapsedLabel}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton
            onClick={() => setEditing(true)}
            title={t('goal.edit', { defaultValue: '编辑目标' })}
            aria-label={t('goal.edit', { defaultValue: '编辑目标' })}
          >
            <Pencil className="size-3.5" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            onClick={goal.status === 'paused' ? onResume : onPause}
            title={goal.status === 'paused' ? t('goal.resume', { defaultValue: '继续执行目标' }) : t('goal.pause', { defaultValue: '暂停执行目标' })}
            aria-label={goal.status === 'paused' ? t('goal.resume', { defaultValue: '继续执行目标' }) : t('goal.pause', { defaultValue: '暂停执行目标' })}
          >
            {goal.status === 'paused' ? (
              <PlayCircle className="size-3.5" strokeWidth={1.75} />
            ) : (
              <PauseCircle className="size-3.5" strokeWidth={1.75} />
            )}
          </IconButton>
          <IconButton
            variant="ghost"
            onClick={onDelete}
            title={t('goal.remove', { defaultValue: '删除目标' })}
            aria-label={t('goal.remove', { defaultValue: '删除目标' })}
            className="hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function useGoalElapsedLabel(goal: GoalComposerState, t: ReturnType<typeof useTranslation>['t']): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (goal.status !== 'active') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goal.status, goal.startedAt]);

  if (goal.status === 'paused') return t('goal.statusPaused', { defaultValue: '已暂停' });
  return formatElapsed(now - goal.startedAt);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

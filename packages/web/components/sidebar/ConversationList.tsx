'use client';

import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT } from '@/lib/motion';
import { Archive, ChevronDown, Folder, Loader2, MessageSquarePlus, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Conversation } from '@/lib/useConversations';
import { Input } from '../ui/input';
import { RowAction } from './primitives';

export function ProjectConversationGroup({
  projectId,
  projectName,
  compact,
  open,
  active,
  dragging,
  dragActive,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onToggle,
  onOpen,
  onNewChat,
  children,
}: {
  projectId: string;
  projectName: string;
  compact: boolean;
  open: boolean;
  active: boolean;
  dragging?: boolean;
  dragActive?: boolean;
  onPointerDown?: (projectId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerEnd?: (event: ReactPointerEvent<HTMLElement>) => void;
  onToggle: () => void;
  onOpen: () => void;
  onNewChat?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={projectName}
        className={clsx(
          'mx-auto flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Folder className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div data-sidebar-project-id={projectId} className={clsx('rounded-md', dragging && 'relative z-10')}>
      <div
        role="button"
        tabIndex={0}
        onPointerDown={(event) => onPointerDown?.(projectId, event)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        className={clsx(
          'group relative flex h-7 w-full select-none items-center gap-1.5 rounded-md px-1.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          dragActive ? 'cursor-grabbing' : 'cursor-grab',
          'text-foreground/85 hover:bg-muted hover:text-foreground',
          dragging && 'bg-muted text-foreground shadow-xs ring-1 ring-ring/30',
        )}
        title={projectName}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{projectName}</span>
        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 opacity-0 text-muted-foreground/70 transition-[opacity,transform] group-hover:opacity-100',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
        <div className="pointer-events-none ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition hover:bg-background hover:text-foreground"
            aria-label={t('project.editTitle')}
            title={t('project.editTitle')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {onNewChat ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNewChat();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition hover:bg-background hover:text-foreground"
              aria-label={t('chat.newInProject')}
              title={t('chat.newInProject')}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="ml-4 flex flex-col gap-0.5 py-0.5">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function ConversationRow({
  conv,
  active,
  compact,
  running = false,
  onSelect,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  conv: Conversation;
  active: boolean;
  compact: boolean;
  nested?: boolean;
  running?: boolean;
  onSelect: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const sourceLabel = conversationSourceLabel(conv.source, t);

  if (compact) {
    return (
      <button
        type="button"
        onClick={onSelect}
        title={sourceLabel ? `${conv.title} · ${sourceLabel}` : conv.title}
        className={clsx(
          'relative mx-auto flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <span className="text-2xs font-semibold">{conv.title.trim().charAt(0) || '·'}</span>
        {sourceLabel ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary/70" /> : null}
      </button>
    );
  }

  if (renaming) {
    const commit = () => {
      setRenaming(false);
      if (draft.trim() && draft.trim() !== conv.title) onRename?.(draft);
      else setDraft(conv.title);
    };
    return (
      <div className="flex h-7 items-center rounded-md bg-muted px-2">
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setDraft(conv.title);
              setRenaming(false);
            }
          }}
          onBlur={commit}
          size="xs"
          className="h-6 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
        />
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'group/nav relative flex h-7 items-center rounded-md pr-1 text-xs transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={sourceLabel ? `${conv.title} · ${sourceLabel}` : conv.title}
        className={clsx(
          'flex min-w-0 flex-1 items-center gap-1 px-1.5 outline-none transition-colors',
          active ? 'font-medium text-foreground' : 'font-normal text-foreground/85 group-hover/nav:text-foreground',
        )}
      >
        <span className="truncate">{conv.title}</span>
        {sourceLabel ? (
          <span className="inline-flex h-4 shrink-0 items-center rounded border border-border/70 bg-background px-1 text-2xs font-medium leading-none text-muted-foreground">
            {sourceLabel}
          </span>
        ) : null}
      </button>
      {running ? (
        <Loader2 className="mr-1 size-3 shrink-0 animate-spin text-primary group-hover/nav:hidden" aria-label={t('chat.running', { defaultValue: '运行中' })} />
      ) : (
        <span className="shrink-0 pr-1 text-2xs tabular-nums text-muted-foreground/70 group-hover/nav:hidden">
          {relativeTime(conv.updatedAt, t)}
        </span>
      )}
      <div className="hidden shrink-0 items-center gap-0.5 pr-0.5 group-hover/nav:flex">
        {onRename ? (
          <RowAction
            icon={<Pencil className="h-3 w-3" />}
            title={t('chat.rename')}
            onClick={() => {
              setDraft(conv.title);
              setRenaming(true);
            }}
          />
        ) : null}
        {onArchive ? <RowAction icon={<Archive className="h-3 w-3" />} title={t('chat.archive')} onClick={onArchive} /> : null}
        {onUnarchive ? <RowAction icon={<RotateCcw className="h-3 w-3" />} title={t('chat.unarchive')} onClick={onUnarchive} /> : null}
        {onDelete ? <RowAction icon={<Trash2 className="h-3 w-3" />} title={t('common.delete')} onClick={onDelete} /> : null}
      </div>
    </div>
  );
}

function conversationSourceLabel(source: string | undefined, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  if (source === 'wechat') return t('chat.source.wechat', { defaultValue: '微信' });
  if (source === 'feishu') return t('chat.source.feishu', { defaultValue: '飞书' });
  if (source === 'feishu-cli') return t('chat.source.feishuCli', { defaultValue: '飞书CLI' });
  return undefined;
}

/** Compact relative time for the conversation list. */
function relativeTime(ts: number, t: ReturnType<typeof useTranslation>['t']): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return t('time.justNow', { defaultValue: '刚刚' });
  if (min < 60) return t('time.minutes', { defaultValue: '{{count}} 分', count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hours', { defaultValue: '{{count}} 小时', count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('time.days', { defaultValue: '{{count}} 天', count: day });
  return t('time.weeks', { defaultValue: '{{count}} 周', count: Math.floor(day / 7) });
}

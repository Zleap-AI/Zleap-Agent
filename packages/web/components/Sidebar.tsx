'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  BookOpen,
  Boxes,
  ChevronDown,
  Clock,
  Folder,
  Info,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Server,
  Settings,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { deleteJson } from '../lib/api';
import { DeleteConfirmDialog } from './ui/delete-confirm-dialog';
import { AvatarBadge } from './AvatarBadge';
import { parseAvatarTheme } from '../lib/avatars';
import { DEFAULT_SPACE_ACCENT, resolveSpaceIcon } from '../lib/spaces';
import type { AvatarView, Resources, SpaceProfile } from '../lib/useResources';
import type { Conversation } from '../lib/useConversations';
import type { PageKey } from './manage/pages';
import type { EditKind } from './manage/edit';
import { AvatarDialog } from './manage/AvatarDialog';
import { SpaceDialog } from './manage/SpaceDialog';
import { Input } from './ui/input';

type MainView = 'chat' | 'settings' | PageKey;

type SidebarProps = {
  model: string;
  resources: Resources;
  activeAvatarId: string;
  /** Which main-area view is showing: chat, settings, or a resource page. */
  activeView: MainView;
  onAvatarSelected: (id: string) => void;
  /** Navigate the main area to a resource page, settings, or back to chat. */
  onNavigate: (view: MainView) => void;
  /** Open the full edit page for an entity. */
  onEdit: (kind: EditKind, id: string) => void;
  /** The entity whose edit page is currently open, for sidebar highlighting. */
  activeEdit?: { kind: EditKind; id: string } | null;
  onNewChat: () => void;
  onNewProjectChat?: (projectId: string) => void;
  onOpenSettings?: () => void;
  /** The user's conversations (most-recent-first), shown grouped by project. */
  conversations?: Conversation[];
  activeConversationId?: string | null;
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
  onRenameConversation?: (id: string, title: string) => void;
  /** Bumped after any create/edit so the page can refresh chat-side spaces. */
  onResourcesChanged?: () => void;
  /** Clear edit view when the open entity was removed from the sidebar. */
  onEntityDeleted?: (kind: EditKind, id: string) => void;
  forceExpanded?: boolean;
};

const STORAGE_KEY = 'zleap-sidebar-collapsed';
const PROJECT_FOLDERS_KEY = 'zleap-sidebar-project-folders';
const PROJECT_ORDER_KEY = 'zleap-sidebar-project-order';
const PROJECT_DRAG_LONG_PRESS_MS = 220;
const PROJECT_DRAG_MOVE_CANCEL_PX = 8;
const ABOUT_URL = 'https://github.com/Zleap-AI/Zleap-Agent/';
type ManagerPanel = 'avatar' | 'space';
type ProjectDragSession = {
  projectId: string;
  pointerId: number;
  originX: number;
  originY: number;
  source: HTMLElement;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export function Sidebar({
  model,
  resources,
  activeAvatarId,
  activeView,
  onNavigate,
  onEdit,
  activeEdit,
  onNewChat,
  onNewProjectChat,
  onOpenSettings,
  conversations = [],
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onResourcesChanged,
  onEntityDeleted,
  forceExpanded = false,
}: SidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [projectOrderReady, setProjectOrderReady] = useState(false);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState<ManagerPanel | null>(null);
  const [avatarDialog, setAvatarDialog] = useState(false);
  const [spaceDialog, setSpaceDialog] = useState(false);
  const [deletingSpace, setDeletingSpace] = useState<SpaceProfile | null>(null);
  const [deletingAvatar, setDeletingAvatar] = useState<AvatarView | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<Conversation | null>(null);
  const projectDragRef = useRef<ProjectDragSession | null>(null);
  const ignoreNextProjectClickRef = useRef(false);

  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1') {
      setCollapsed(true);
    }
    try {
      const raw = localStorage.getItem(PROJECT_FOLDERS_KEY);
      if (raw) setFolderOpen(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(PROJECT_ORDER_KEY);
      setProjectOrder(readStoredStringList(raw));
    } catch {
      setProjectOrder([]);
    } finally {
      setProjectOrderReady(true);
    }
  }, []);

  const compact = forceExpanded ? false : collapsed;
  const orderedProjects = orderProjects(resources.projects, projectOrder);
  const projectIds = new Set(orderedProjects.map((project) => project.id));
  const projectGroups = orderedProjects.map((project) => ({
    project,
    conversations: conversations.filter((conversation) => conversation.projectId === project.id),
  }));
  const looseConversations = conversations.filter(
    (conversation) => !conversation.projectId || !projectIds.has(conversation.projectId),
  );
  const spaceItems: SpaceProfile[] = [...resources.spaces].sort(
    (a, b) => Number(b.kind === 'main') - Number(a.kind === 'main'),
  );

  useEffect(() => {
    if (!projectOrderReady) return;
    setProjectOrder((current) => {
      const next = normalizeProjectOrder(resources.projects.map((project) => project.id), current);
      if (sameStringList(current, next)) return current;
      writeProjectOrder(next);
      return next;
    });
  }, [projectOrderReady, resources.projects]);

  const clearProjectDrag = (releasePointer = true) => {
    const session = projectDragRef.current;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    if (releasePointer && session.source.hasPointerCapture?.(session.pointerId)) {
      try {
        session.source.releasePointerCapture(session.pointerId);
      } catch {
        /* ignore */
      }
    }
    projectDragRef.current = null;
  };

  useEffect(() => {
    return () => {
      clearProjectDrag(false);
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const toggleProjectFolderFromClick = (projectId: string) => {
    if (ignoreNextProjectClickRef.current) {
      ignoreNextProjectClickRef.current = false;
      return;
    }
    toggleProjectFolder(projectId);
  };

  const toggleProjectFolder = (projectId: string) => {
    setFolderOpen((current) => {
      const next = { ...current, [projectId]: !(current[projectId] ?? true) };
      try {
        localStorage.setItem(PROJECT_FOLDERS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const openActiveAvatar = () => {
    onEdit('avatar', activeAvatarId || DEFAULT_AVATAR_ID);
  };

  const openPrimarySpace = () => {
    const space = primarySpace(resources.spaces);
    if (space) {
      onEdit('space', space.id);
      return;
    }
    setSpaceDialog(true);
  };

  const toggleManager = (panel: ManagerPanel) => {
    if (compact) {
      if (panel === 'avatar') openActiveAvatar();
      else openPrimarySpace();
      return;
    }
    setManagerOpen((current) => (current === panel ? null : panel));
  };

  const reorderProject = (dragProjectId: string, overProjectId: string, insertAfter: boolean) => {
    setProjectOrder((current) => {
      const ids = normalizeProjectOrder(resources.projects.map((project) => project.id), current);
      const from = ids.indexOf(dragProjectId);
      const over = ids.indexOf(overProjectId);
      if (from < 0 || over < 0) return current;
      const next = moveStringItem(ids, from, over + (insertAfter ? 1 : 0));
      if (sameStringList(ids, next)) return current;
      writeProjectOrder(next);
      return next;
    });
  };

  const handleProjectPointerDown = (projectId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (compact) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    clearProjectDrag();
    const source = event.currentTarget as HTMLElement;
    try {
      source.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    const session: ProjectDragSession = {
      projectId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      source,
      started: false,
      timer: null,
    };
    session.timer = setTimeout(() => {
      const current = projectDragRef.current;
      if (!current || current.pointerId !== session.pointerId) return;
      current.started = true;
      ignoreNextProjectClickRef.current = true;
      setDraggingProjectId(projectId);
    }, PROJECT_DRAG_LONG_PRESS_MS);
    projectDragRef.current = session;
  };

  const handleProjectPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const session = projectDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    if (!session.started) {
      const distance = Math.hypot(event.clientX - session.originX, event.clientY - session.originY);
      if (distance > PROJECT_DRAG_MOVE_CANCEL_PX) clearProjectDrag();
      return;
    }

    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const over = target?.closest('[data-sidebar-project-id]') as HTMLElement | null;
    const overProjectId = over?.dataset.sidebarProjectId;
    if (!overProjectId || overProjectId === session.projectId) return;
    const rect = over.getBoundingClientRect();
    reorderProject(session.projectId, overProjectId, event.clientY > rect.top + rect.height / 2);
  };

  const handleProjectPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const session = projectDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const started = session.started;
    clearProjectDrag();
    setDraggingProjectId(null);
    if (started) {
      event.preventDefault();
      ignoreNextProjectClickRef.current = true;
    }
  };

  const afterAvatarSaved = (avatarId?: string) => {
    void resources.reload();
    onResourcesChanged?.();
    if (avatarId) onEdit('avatar', avatarId);
  };

  const afterSpaceSaved = () => {
    void resources.reload();
    onResourcesChanged?.();
  };

  const removeSpace = async (space: SpaceProfile) => {
    try {
      await deleteJson('/api/spaces', { id: space.storageId ?? space.id });
      toast.success(t('common.delete'));
      void resources.reload();
      onResourcesChanged?.();
      onEntityDeleted?.('space', space.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const removeAvatar = async (avatar: AvatarView) => {
    try {
      await deleteJson('/api/avatar', { id: avatar.id });
      toast.success(t('common.delete'));
      void resources.reload();
      onResourcesChanged?.();
      onEntityDeleted?.('avatar', avatar.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  return (
    <aside
      className={clsx(
        'flex h-full shrink-0 flex-col border-r border-border bg-sidebar text-[14px] transition-[width] duration-300 ease-out',
        compact ? 'w-[60px]' : 'w-72',
      )}
    >
      <div className={clsx('flex h-12 shrink-0 items-center px-3', compact ? 'justify-center' : 'justify-between')}>
        {!compact ? (
          <button type="button" onClick={() => onNavigate('chat')} className="flex min-w-0 items-center gap-2" title="Home">
            <BrandMark />
            <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-foreground">Zleap-Agent</span>
            <span className="shrink-0 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
              Preview
            </span>
          </button>
        ) : null}
        {forceExpanded ? null : (
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label="Toggle sidebar"
          >
            {compact ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div className="px-2.5">
        <div className="flex flex-col gap-0.5">
          <PrimaryAction
            compact={compact}
            icon={<MessageSquarePlus className="h-4 w-4" />}
            label={t('common.newChat')}
            onClick={onNewChat}
          />
          <PrimaryAction
            compact={compact}
            icon={<Bot className="h-4 w-4" />}
            label={t('nav.avatar')}
            active={activeEdit?.kind === 'avatar' || managerOpen === 'avatar'}
            expanded={managerOpen === 'avatar'}
            onClick={() => toggleManager('avatar')}
          />
          <ManagerPanelList open={!compact && managerOpen === 'avatar'}>
            {resources.avatars.map((avatar) => (
              <AvatarManagerRow
                key={avatar.id}
                avatar={avatar}
                active={activeEdit?.kind === 'avatar' && activeEdit.id === avatar.id}
                onClick={() => onEdit('avatar', avatar.id)}
                onDelete={avatar.id === DEFAULT_AVATAR_ID ? undefined : () => setDeletingAvatar(avatar)}
                deleteTitle={t('common.delete')}
              />
            ))}
            {resources.avatars.length === 0 ? <Empty>{resources.loading ? t('common.loading') : t('common.none')}</Empty> : null}
            <ManagerAddRow label={t('avatar.new')} onClick={() => setAvatarDialog(true)} />
          </ManagerPanelList>
          <PrimaryAction
            compact={compact}
            icon={<Boxes className="h-4 w-4" />}
            label={t('nav.space')}
            active={activeEdit?.kind === 'space' || managerOpen === 'space'}
            expanded={managerOpen === 'space'}
            onClick={() => toggleManager('space')}
          />
          <ManagerPanelList open={!compact && managerOpen === 'space'}>
            {spaceItems.map((space) => (
              <SpaceManagerRow
                key={space.storageId ?? space.id}
                space={space}
                active={activeEdit?.kind === 'space' && activeEdit.id === space.id}
                onClick={() => onEdit('space', space.id)}
                onDelete={space.kind === 'main' ? undefined : () => setDeletingSpace(space)}
                deleteTitle={t('common.delete')}
              />
            ))}
            {spaceItems.length === 0 ? <Empty>{resources.loading ? t('common.loading') : t('common.none')}</Empty> : null}
            <ManagerAddRow label={t('space.new')} onClick={() => setSpaceDialog(true)} />
          </ManagerPanelList>
          <PrimaryAction
            compact={compact}
            icon={<BookOpen className="h-4 w-4" />}
            label={t('nav.skill')}
            active={!activeEdit && activeView === 'skill'}
            onClick={() => onNavigate('skill')}
          />
          <PrimaryAction
            compact={compact}
            icon={<Server className="h-4 w-4" />}
            label={t('nav.gateway', { defaultValue: '网关' })}
            active={!activeEdit && activeView === 'gateway'}
            onClick={() => onNavigate('gateway')}
          />
          <PrimaryAction
            compact={compact}
            icon={<Clock className="h-4 w-4" />}
            label={t('nav.task')}
            active={!activeEdit && activeView === 'task'}
            onClick={() => onNavigate('task')}
          />
        </div>
      </div>

      <div className="no-scrollbar mt-3 flex-1 overflow-y-auto px-2.5 pb-3">
        {!compact ? <SidebarLabel>{t('nav.project')}</SidebarLabel> : null}
        <div className="flex flex-col gap-1">
          {projectGroups.map(({ project, conversations: projectConversations }) => {
            const open = folderOpen[project.id] ?? true;
            const active = projectConversations.some((conversation) => conversation.id === activeConversationId);
            return (
              <ProjectConversationGroup
                key={project.id}
                projectId={project.id}
                projectName={project.name}
                compact={compact}
                open={open}
                active={active}
                dragging={draggingProjectId === project.id}
                dragActive={draggingProjectId !== null}
                onPointerDown={handleProjectPointerDown}
                onPointerMove={handleProjectPointerMove}
                onPointerEnd={handleProjectPointerEnd}
                onToggle={() => toggleProjectFolderFromClick(project.id)}
                onOpen={() => onEdit('project', project.id)}
                onNewChat={onNewProjectChat ? () => onNewProjectChat(project.id) : undefined}
              >
                {projectConversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conv={conversation}
                    active={conversation.id === activeConversationId}
                    compact={compact}
                    nested
                    onSelect={() => onSelectConversation?.(conversation.id)}
                    onRename={(title) => onRenameConversation?.(conversation.id, title)}
                    onDelete={onDeleteConversation ? () => setDeletingConversation(conversation) : undefined}
                  />
                ))}
              </ProjectConversationGroup>
            );
          })}
        </div>

        {!compact ? <SidebarLabel className="mt-5">{t('nav.conversation')}</SidebarLabel> : null}
        <div className="flex flex-col gap-0.5">
          {looseConversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conv={conversation}
              active={conversation.id === activeConversationId}
              compact={compact}
              onSelect={() => onSelectConversation?.(conversation.id)}
              onRename={(title) => onRenameConversation?.(conversation.id, title)}
              onDelete={onDeleteConversation ? () => setDeletingConversation(conversation) : undefined}
            />
          ))}
          {!compact && looseConversations.length === 0 && projectGroups.length === 0 ? (
            <Empty>{t('chat.emptyConversations')}</Empty>
          ) : null}
        </div>
      </div>

      <AccountMenu compact={compact} model={model} onOpenSettings={onOpenSettings} active={activeView === 'settings'} />

      <AvatarDialog open={avatarDialog} onOpenChange={setAvatarDialog} onSaved={afterAvatarSaved} />
      <SpaceDialog open={spaceDialog} onOpenChange={setSpaceDialog} avatarId={activeAvatarId} resources={resources} onSaved={afterSpaceSaved} />
      <DeleteConfirmDialog
        open={deletingSpace !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingSpace(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: deletingSpace?.label ?? '' })}
        onConfirm={async () => {
          if (deletingSpace) await removeSpace(deletingSpace);
        }}
      />
      <DeleteConfirmDialog
        open={deletingAvatar !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingAvatar(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: deletingAvatar?.name ?? '' })}
        onConfirm={async () => {
          if (deletingAvatar) await removeAvatar(deletingAvatar);
        }}
      />
      <DeleteConfirmDialog
        open={deletingConversation !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingConversation(null);
        }}
        title={t('common.delete')}
        description={t('chat.deleteConfirm', { name: deletingConversation?.title ?? '' })}
        onConfirm={() => {
          if (deletingConversation) onDeleteConversation?.(deletingConversation.id);
        }}
      />
    </aside>
  );
}

function BrandMark() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent-grad text-xs font-bold leading-none text-white shadow-xs ring-1 ring-black/5">
      Z
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-xs text-muted-foreground/70">{children}</div>;
}

function SidebarLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('mb-1.5 px-1.5 text-[12px] font-medium text-muted-foreground/75', className)}>{children}</div>;
}

function readStoredStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function writeProjectOrder(order: string[]): void {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
}

function normalizeProjectOrder(projectIds: string[], order: string[]): string[] {
  const available = new Set(projectIds);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of order) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of projectIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

function orderProjects<T extends { id: string }>(projects: T[], order: string[]): T[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const orderedIds = normalizeProjectOrder(projects.map((project) => project.id), order);
  return orderedIds.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
}

function moveStringItem(items: string[], from: number, to: number): string[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  const target = Math.max(0, Math.min(from < to ? to - 1 : to, next.length));
  next.splice(target, 0, item);
  return next;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function PrimaryAction({
  compact,
  icon,
  label,
  active,
  expanded,
  onClick,
}: {
  compact: boolean;
  icon: ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={clsx(
        'flex h-8 items-center rounded-md transition-colors outline-none',
        compact ? 'w-8 justify-center' : 'w-full gap-2 px-2',
        active ? 'bg-muted font-medium text-foreground' : 'text-foreground/85 hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      {!compact ? <span className="truncate">{label}</span> : null}
      {!compact && expanded !== undefined ? (
        <ChevronDown
          className={clsx(
            'ml-auto h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform',
            expanded ? 'rotate-0' : '-rotate-90',
          )}
        />
      ) : null}
    </button>
  );
}

function ManagerPanelList({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="ml-5 flex flex-col gap-0.5 border-l border-border py-1 pl-2">{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function AvatarManagerRow({
  avatar,
  active,
  onClick,
  onDelete,
  deleteTitle,
}: {
  avatar: AvatarView;
  active?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  const theme = parseAvatarTheme(avatar.metadata);
  return (
    <ManagerRow
      title={avatar.name}
      active={active}
      icon={
        <AvatarBadge
          name={avatar.name}
          emoji={theme.emoji}
          accent={theme.accent}
          className="size-4"
          letterClassName="text-[9px]"
          emojiClassName="text-sm leading-none"
        />
      }
      onClick={onClick}
      onDelete={onDelete}
      deleteTitle={deleteTitle}
    />
  );
}

function SpaceManagerRow({
  space,
  active,
  onClick,
  onDelete,
  deleteTitle,
}: {
  space: SpaceProfile;
  active?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  const Icon = resolveSpaceIcon(space.icon);
  return (
    <ManagerRow
      title={space.label}
      active={active}
      icon={<Icon className="h-4 w-4 shrink-0" style={{ color: space.accent ?? DEFAULT_SPACE_ACCENT }} />}
      onClick={onClick}
      onDelete={onDelete}
      deleteTitle={deleteTitle}
    />
  );
}

function ManagerRow({
  title,
  icon,
  active,
  onClick,
  onDelete,
  deleteTitle,
}: {
  title: string;
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}) {
  return (
    <div
      className={clsx(
        'group/managed relative flex h-7 w-full min-w-0 items-center rounded-md pr-1 text-[13px] transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={clsx(
          'flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none transition-colors',
          active ? 'font-medium text-foreground' : 'text-foreground/85 group-hover/managed:text-foreground',
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        <span className="truncate">{title}</span>
      </button>
      {onDelete ? (
        <div className="hidden shrink-0 items-center pr-0.5 group-hover/managed:flex">
          <RowAction
            icon={<Trash2 className="h-3 w-3" />}
            title={deleteTitle ?? ''}
            onClick={onDelete}
          />
        </div>
      ) : null}
    </div>
  );
}

function ManagerAddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <Plus className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function ProjectConversationGroup({
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
          'group flex h-7 w-full select-none items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          dragActive ? 'cursor-grabbing' : 'cursor-grab',
          active ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted',
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
            <MoreHorizontal className="h-3.5 w-3.5" />
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
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-5 flex flex-col gap-0.5 py-0.5">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ConversationRow({
  conv,
  active,
  compact,
  nested = false,
  onSelect,
  onRename,
  onDelete,
}: {
  conv: Conversation;
  active: boolean;
  compact: boolean;
  nested?: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
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
        <span className="text-[11px] font-semibold">{conv.title.trim().charAt(0) || '·'}</span>
        {sourceLabel ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary/70" /> : null}
      </button>
    );
  }

  if (renaming) {
    const commit = () => {
      setRenaming(false);
      if (draft.trim() && draft.trim() !== conv.title) onRename(draft);
      else setDraft(conv.title);
    };
    return (
      <div className={clsx('flex h-7 items-center rounded-md bg-muted px-2', nested && 'ml-1')}>
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
        'group/nav relative flex h-7 items-center rounded-md pr-1 text-[13px] transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted',
        nested && 'ml-1',
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
          <span className="inline-flex h-4 shrink-0 items-center rounded border border-border/70 bg-background px-1 text-[10px] font-medium leading-none text-muted-foreground">
            {sourceLabel}
          </span>
        ) : null}
      </button>
      <span className="shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground/70 group-hover/nav:hidden">
        {relativeTime(conv.updatedAt)}
      </span>
      <div className="hidden shrink-0 items-center gap-0.5 pr-0.5 group-hover/nav:flex">
        <RowAction
          icon={<Pencil className="h-3 w-3" />}
          title={t('chat.rename')}
          onClick={() => {
            setDraft(conv.title);
            setRenaming(true);
          }}
        />
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

function RowAction({
  icon,
  title,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      title={title}
      className="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground/70 transition hover:bg-background hover:text-foreground"
    >
      {icon}
    </button>
  );
}

function AccountMenu({
  compact,
  model,
  active,
  onOpenSettings,
}: {
  compact: boolean;
  model: string;
  active?: boolean;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openAbout = () => {
    window.open(ABOUT_URL, '_blank', 'noopener,noreferrer');
    setMenuOpen(false);
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenuOpen(false), 140);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="relative shrink-0 border-t border-border p-2.5"
      onMouseEnter={() => {
        cancelClose();
        setMenuOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={clsx(
              'absolute z-50 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1.5 shadow-lg',
              compact ? 'bottom-2 left-full ml-2' : 'bottom-full left-2.5 right-2.5 mb-2',
            )}
          >
            <MenuItem icon={<Settings className="h-4 w-4" />} label={t('account.settings')} active={active} onClick={onOpenSettings} />
            <MenuItem icon={<Info className="h-4 w-4" />} label={t('account.about')} onClick={openAbout} />
            <div className="px-2 pt-1 font-mono text-[10px] text-muted-foreground/70">{model}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={clsx(
          'flex w-full items-center rounded-sm text-sm transition',
          compact ? 'h-9 justify-center' : 'gap-2.5 px-2 py-1.5',
          menuOpen || active ? 'bg-muted' : 'hover:bg-muted',
        )}
        title={t('account.settings')}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Settings className="h-4 w-4" />
        </span>
        {!compact ? (
          <>
            <span className="truncate font-medium text-foreground">{t('account.settings')}</span>
            <MoreHorizontal className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/70" />
          </>
        ) : null}
      </button>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function primarySpace(spaces: SpaceProfile[]): SpaceProfile | undefined {
  return spaces.find((space) => space.kind === 'main') ?? spaces[0];
}

/** Compact relative time for the conversation list. */
function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天`;
  return `${Math.floor(day / 7)} 周`;
}

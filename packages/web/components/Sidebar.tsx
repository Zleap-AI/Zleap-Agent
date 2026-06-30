'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  Bot,
  BookOpen,
  Boxes,
  ChevronDown,
  Clock,
  FolderPlus,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useProjectOrder, normalizeProjectOrder, orderProjects, moveStringItem, sameStringList } from '@/hooks/useProjectOrder';
import { DeleteConfirmDialog } from './ui/delete-confirm-dialog';
import type { Resources } from '../lib/useResources';
import type { Conversation } from '../lib/useConversations';
import type { PageKey } from './manage/pages';
import type { EditKind } from './manage/edit';
import { IconButton } from './ui/icon-button';
import { ConversationRow, ProjectConversationGroup } from './sidebar/ConversationList';
import { ConversationCommandPalette } from './sidebar/ConversationCommandPalette';
import { AccountMenu } from './sidebar/AccountMenu';

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
  /** Archived conversations, shown in a collapsible group at the bottom. */
  archivedConversations?: Conversation[];
  activeConversationId?: string | null;
  /** The conversation currently running — shows a spinner in its row. */
  runningConversationIds?: string[];
  onSelectConversation?: (id: string) => void;
  /** Permanently delete (used from the archive group). */
  onDeleteConversation?: (id: string) => void;
  /** Archive a conversation (soft, reversible). */
  onArchiveConversation?: (id: string) => void;
  /** Restore an archived conversation. */
  onUnarchiveConversation?: (id: string) => void;
  onRenameConversation?: (id: string, title: string) => void;
  onCreateProject?: () => void;
  /** Bumped after any create/edit so the page can refresh chat-side spaces. */
  onResourcesChanged?: () => void;
  /** Clear edit view when the open entity was removed from the sidebar. */
  onEntityDeleted?: (kind: EditKind, id: string) => void;
  forceExpanded?: boolean;
};

const STORAGE_KEY = 'zleap-sidebar-collapsed';
const PROJECT_FOLDERS_KEY = 'zleap-sidebar-project-folders';
const SECTIONS_KEY = 'zleap-sidebar-sections';
const PROJECT_DRAG_LONG_PRESS_MS = 220;
const PROJECT_DRAG_MOVE_CANCEL_PX = 8;
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
  archivedConversations = [],
  activeConversationId,
  runningConversationIds = [],
  onSelectConversation,
  onDeleteConversation,
  onArchiveConversation,
  onUnarchiveConversation,
  onRenameConversation,
  onCreateProject,
  onResourcesChanged,
  onEntityDeleted,
  forceExpanded = false,
}: SidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [sectionsCollapsed, setSectionsCollapsed] = useState<{ projects?: boolean; conversations?: boolean; archived?: boolean }>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [clearArchivedOpen, setClearArchivedOpen] = useState(false);
  const { projectOrder, setProjectOrder } = useProjectOrder(resources.projects.map((project) => project.id));
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
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
      const rawSections = localStorage.getItem(SECTIONS_KEY);
      if (rawSections) setSectionsCollapsed(JSON.parse(rawSections) as { projects?: boolean; conversations?: boolean });
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSection = (key: 'projects' | 'conversations' | 'archived', defaultCollapsed = false) => {
    setSectionsCollapsed((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? defaultCollapsed) };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      return next;
    });
  };

  const compact = forceExpanded ? false : collapsed;
  const orderedProjects = orderProjects(resources.projects, projectOrder);
  const projectIds = new Set(orderedProjects.map((project) => project.id));
  const runningConversationSet = useMemo(() => new Set(runningConversationIds), [runningConversationIds]);
  const projectGroups = orderedProjects.map((project) => ({
    project,
    conversations: conversations.filter((conversation) => conversation.projectId === project.id),
  }));
  const looseConversations = conversations.filter(
    (conversation) => !conversation.projectId || !projectIds.has(conversation.projectId),
  );
  // Conversation search now lives in the ⌘K command palette; the sidebar lists show everything.
  const filteredProjectGroups = projectGroups;
  const filteredLooseConversations = looseConversations;
  const filteredArchivedConversations = archivedConversations;

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

  useEffect(() => {
    if (forceExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [forceExpanded]);

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

  const reorderProject = (dragProjectId: string, overProjectId: string, insertAfter: boolean) => {
    setProjectOrder((current) => {
      const ids = normalizeProjectOrder(resources.projects.map((project) => project.id), current);
      const from = ids.indexOf(dragProjectId);
      const over = ids.indexOf(overProjectId);
      if (from < 0 || over < 0) return current;
      const next = moveStringItem(ids, from, over + (insertAfter ? 1 : 0));
      if (sameStringList(ids, next)) return current;
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

  return (
    <aside
      className={clsx(
        'flex h-full shrink-0 flex-col border-r border-border bg-sidebar text-sm transition-[width] duration-[var(--duration-base)] ease-out',
        compact ? 'w-[60px]' : 'w-72',
      )}
    >
      <div className={clsx('flex h-12 shrink-0 items-center px-3', compact ? 'justify-center' : 'justify-between')}>
        {!compact ? (
          <button type="button" onClick={() => onNavigate('chat')} className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" title="Home">
            <BrandMark />
            <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">Zleap-Agent</span>
            <span className="shrink-0 rounded-sm border border-border bg-card px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground">
              Preview
            </span>
          </button>
        ) : null}
        {forceExpanded ? null : (
          <IconButton
            size="icon-sm"
            onClick={toggleCollapsed}
            className="shrink-0 text-muted-foreground"
            title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label="Toggle sidebar"
          >
            {compact ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </IconButton>
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
            icon={<Search className="h-4 w-4" />}
            label={t('common.search', { defaultValue: '搜索' })}
            shortcut="⌘K"
            active={paletteOpen}
            onClick={() => setPaletteOpen(true)}
          />
          <PrimaryAction
            compact={compact}
            icon={<Bot className="h-4 w-4" />}
            label={t('nav.avatar')}
            active={activeEdit?.kind === 'avatar' || (!activeEdit && activeView === 'avatar')}
            onClick={() => onNavigate('avatar')}
          />
          <PrimaryAction
            compact={compact}
            icon={<Boxes className="h-4 w-4" />}
            label={t('nav.space')}
            active={activeEdit?.kind === 'space' || (!activeEdit && activeView === 'space')}
            onClick={() => onNavigate('space')}
          />
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
        {!compact ? (
          <SidebarLabel
            collapsed={sectionsCollapsed.projects}
            onToggle={() => toggleSection('projects')}
            count={filteredProjectGroups.length}
            onAdd={onCreateProject}
            addLabel={t('project.new')}
            addIcon={<FolderPlus className="h-3.5 w-3.5" />}
          >
            {t('nav.project')}
          </SidebarLabel>
        ) : null}
        <div className={clsx('flex flex-col gap-1', !compact && sectionsCollapsed.projects && 'hidden')}>
          {filteredProjectGroups.map(({ project, conversations: projectConversations }) => {
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
                    running={conversation.id !== activeConversationId && runningConversationSet.has(conversation.id)}
                    onSelect={() => onSelectConversation?.(conversation.id)}
                    onRename={(title) => onRenameConversation?.(conversation.id, title)}
                    onArchive={onArchiveConversation ? () => onArchiveConversation(conversation.id) : undefined}
                  />
                ))}
              </ProjectConversationGroup>
            );
          })}
        </div>

        {!compact ? (
          <SidebarLabel
            className="mt-5"
            collapsed={sectionsCollapsed.conversations}
            onToggle={() => toggleSection('conversations')}
            count={filteredLooseConversations.length}
            onAdd={onNewChat}
            addLabel={t('common.newChat')}
            addIcon={<MessageSquarePlus className="h-3.5 w-3.5" />}
          >
            {t('nav.conversation')}
          </SidebarLabel>
        ) : null}
        <div className={clsx('flex flex-col gap-0.5', !compact && sectionsCollapsed.conversations && 'hidden')}>
          {filteredLooseConversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conv={conversation}
              active={conversation.id === activeConversationId}
              compact={compact}
              running={conversation.id !== activeConversationId && runningConversationSet.has(conversation.id)}
              onSelect={() => onSelectConversation?.(conversation.id)}
              onRename={(title) => onRenameConversation?.(conversation.id, title)}
              onArchive={onArchiveConversation ? () => onArchiveConversation(conversation.id) : undefined}
            />
          ))}
          {!compact && filteredLooseConversations.length === 0 && filteredProjectGroups.length === 0 && filteredArchivedConversations.length === 0 ? (
            <Empty>{t('chat.emptyConversations')}</Empty>
          ) : null}
        </div>

        {!compact && filteredArchivedConversations.length > 0 ? (
          <>
            <SidebarLabel
              className="mt-5"
              collapsed={sectionsCollapsed.archived ?? true}
              onToggle={() => toggleSection('archived', true)}
              count={filteredArchivedConversations.length}
              onAction={onDeleteConversation ? () => setClearArchivedOpen(true) : undefined}
              actionLabel={t('chat.clearArchived', { defaultValue: '清空归档' })}
              actionIcon={<Trash2 className="h-3.5 w-3.5" />}
              actionClassName="text-destructive/70 hover:text-destructive"
            >
              {t('chat.archived', { defaultValue: '归档' })}
            </SidebarLabel>
            <div className={clsx('flex flex-col gap-0.5', (sectionsCollapsed.archived ?? true) && 'hidden')}>
              {filteredArchivedConversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conv={conversation}
                  active={conversation.id === activeConversationId}
                  compact={false}
                  onSelect={() => onSelectConversation?.(conversation.id)}
                  onUnarchive={() => onUnarchiveConversation?.(conversation.id)}
                  onDelete={() => setDeletingConversation(conversation)}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      <AccountMenu compact={compact} model={model} onOpenSettings={onOpenSettings} active={activeView === 'settings'} />

      <ConversationCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        conversations={conversations}
        archivedConversations={archivedConversations}
        onSelectConversation={(id) => onSelectConversation?.(id)}
        onNewChat={onNewChat}
        onOpenSettings={onOpenSettings}
        onNavigate={onNavigate}
        onCreateProject={onCreateProject}
      />

      {/* 助手/空间的新建·删除已迁移到各自列表页（pages-avatar / pages-space） */}
      <DeleteConfirmDialog
        open={deletingConversation !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingConversation(null);
        }}
        title={t('chat.deletePermanently', { defaultValue: '彻底删除' })}
        description={t('chat.deletePermanentlyConfirm', { defaultValue: '将永久删除「{{name}}」，无法恢复。', name: deletingConversation?.title ?? '' })}
        confirmLabel={t('chat.deletePermanently', { defaultValue: '彻底删除' })}
        onConfirm={() => {
          if (deletingConversation) onDeleteConversation?.(deletingConversation.id);
        }}
      />
      <DeleteConfirmDialog
        open={clearArchivedOpen}
        onOpenChange={setClearArchivedOpen}
        title={t('chat.clearArchived', { defaultValue: '清空归档' })}
        description={t('chat.clearArchivedConfirm', {
          defaultValue: '将永久删除 {{count}} 个已归档对话，无法恢复。',
          count: archivedConversations.length,
        })}
        confirmLabel={t('chat.clearArchived', { defaultValue: '清空归档' })}
        onConfirm={() => {
          archivedConversations.forEach((conversation) => onDeleteConversation?.(conversation.id));
        }}
      />
    </aside>
  );
}

function BrandMark() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent-grad text-xs font-bold leading-none text-primary-foreground shadow-xs ring-1 ring-border/50">
      Z
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-xs text-muted-foreground/70">{children}</div>;
}

function SidebarLabel({
  children,
  className,
  collapsed,
  onToggle,
  count,
  onAdd,
  addLabel,
  addIcon,
  onAction,
  actionLabel,
  actionIcon,
  actionClassName,
}: {
  children: ReactNode;
  className?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  count?: number;
  onAdd?: () => void;
  addLabel?: string;
  addIcon?: ReactNode;
  onAction?: () => void;
  actionLabel?: string;
  actionIcon?: ReactNode;
  actionClassName?: string;
}) {
  if (onToggle) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        className={clsx(
          'group/sec mb-1.5 flex h-7 w-full items-center rounded-md px-1.5 text-left text-xs font-medium text-muted-foreground/75 outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate">{children}</span>
          <ChevronDown
            className={clsx(
              'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform group-hover/sec:text-muted-foreground',
              collapsed ? '-rotate-90' : 'rotate-0',
            )}
          />
        </span>
        <div className="ml-auto flex items-center gap-1">
          {count != null ? (
            <span className="text-2xs tabular-nums text-muted-foreground/55 opacity-0 transition-opacity group-hover/sec:opacity-100 group-focus-within/sec:opacity-100">
              {count}
            </span>
          ) : null}
          {onAction ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onAction();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onAction();
              }}
              title={actionLabel}
              aria-label={actionLabel}
              className={clsx(
                'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/65 opacity-0 transition hover:bg-muted hover:text-foreground group-hover/sec:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40',
                actionClassName,
              )}
            >
              {actionIcon}
            </button>
          ) : null}
          {onAdd ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onAdd();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onAdd();
              }}
              title={addLabel}
              aria-label={addLabel}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/65 opacity-0 transition hover:bg-muted hover:text-foreground group-hover/sec:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {addIcon}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className={clsx('mb-1.5 flex h-6 items-center px-1.5 text-xs font-medium text-muted-foreground/75', className)}>
      <span className="truncate">{children}</span>
      {onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          title={addLabel}
          aria-label={addLabel}
          className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/65 transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {addIcon}
        </button>
      ) : null}
    </div>
  );
}

function PrimaryAction({
  compact,
  icon,
  label,
  active,
  expanded,
  shortcut,
  onClick,
}: {
  compact: boolean;
  icon: ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={clsx(
        'group/primary relative flex h-8 items-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        compact ? 'w-8 justify-center' : 'w-full gap-2 px-2',
        active ? 'bg-muted font-medium text-foreground' : 'text-foreground/85 hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      {!compact ? <span className="truncate">{label}</span> : null}
      {!compact && shortcut ? (
        <span className="ml-auto font-mono text-2xs tracking-wide text-muted-foreground/50 opacity-0 transition-opacity group-hover/primary:opacity-100">
          {shortcut}
        </span>
      ) : null}
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

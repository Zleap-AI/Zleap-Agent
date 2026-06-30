'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { SPRING_PANEL } from "@/lib/motion";
import {
  FolderOpen,
  PanelRight,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tree, type NodeApi, type TreeApi } from 'react-arborist';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fetchLocalArtifact, listWorkspaceFiles, type WorkspaceEntry, type WorkspaceListing } from '@/lib/services';
import {
  ancestorDirectoryPaths,
  basenamePath,
  isPathInsideRoot,
  relativePathFromRoot,
  resolveTargetPathForRoot,
} from '@/lib/workspacePathUtils';
import type { ProjectView } from '@/lib/useResources';
import { cn } from '@/lib/utils';
import type { WorkspaceFileTarget } from '@/lib/workspaceFiles';
import type { DirectoryState, FileViewMode, PreviewState, WorkspaceTreeNode } from './workspace/types';
import { buildTreeNodes, WorkspaceTreeRow } from './workspace/tree';
import { defaultFileViewMode, EmptyState, LoadingState, PreviewPane } from './workspace/PreviewPane';
import { useElementSize } from './workspace/useElementSize';

type WorkspaceFilesDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  conversationTitle?: string;
  projectId?: string;
  projects: ProjectView[];
  presentation?: 'inline' | 'overlay';
  wide?: boolean;
  target?: WorkspaceFileTarget | null;
  refreshToken?: number;
  /** Render only the body (no header / overlay) for use inside a shared tabbed panel. */
  embedded?: boolean;
};

const MAX_PREVIEW_CHARS = 120_000;

export function WorkspaceFilesDrawer({
  open,
  onOpenChange,
  conversationId,
  conversationTitle,
  projectId,
  projects,
  presentation = 'overlay',
  wide = false,
  target,
  refreshToken = 0,
  embedded = false,
}: WorkspaceFilesDrawerProps) {
  const { t } = useTranslation();
  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : undefined;
  const [root, setRoot] = useState<WorkspaceListing | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [fileViewMode, setFileViewMode] = useState<FileViewMode>('source');
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const treeRef = useRef<TreeApi<WorkspaceTreeNode> | null>(null);
  const rootRef = useRef<WorkspaceListing | null>(null);
  const directoriesRef = useRef<Record<string, DirectoryState>>({});
  const expandedRef = useRef<Set<string>>(new Set());
  const syncingExpandedRef = useRef(false);
  const handledTargetRef = useRef<string>('');
  const [treeViewportRef, treeViewportSize] = useElementSize<HTMLDivElement>();

  const fetchDirectory = useCallback(
    (path?: string): Promise<WorkspaceListing> => listWorkspaceFiles({ conversationId, projectId, path }),
    [conversationId, projectId],
  );

  useEffect(() => {
    rootRef.current = root;
  }, [root]);

  useEffect(() => {
    directoriesRef.current = directories;
  }, [directories]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const loadRoot = useCallback(async (): Promise<WorkspaceListing | null> => {
    setRoot(null);
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    try {
      const data = await fetchDirectory();
      setRoot(data);
      setDirectories({ [data.root]: { loading: false, entries: data.entries, truncated: data.truncated } });
      setExpanded(new Set([data.root]));
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRoot({
        mode: projectId ? 'project' : 'conversation',
        root: '',
        path: '',
        parent: null,
        title: selectedProject?.name ?? conversationTitle ?? t('workspace.currentConversation'),
        entries: [],
      });
      setDirectories({ '': { loading: false, entries: [], error: message } });
      return null;
    }
  }, [conversationTitle, fetchDirectory, projectId, selectedProject?.name, t]);

  useEffect(() => {
    handledTargetRef.current = '';
    setRoot(null);
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setQuery('');
    setPreview({ status: 'idle' });
    setFileViewMode('source');
    setTreeCollapsed(false);
  }, [conversationId, projectId]);

  useEffect(() => {
    if (open && !target?.path) void loadRoot();
  }, [loadRoot, open, refreshToken, target?.path]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setPreview({ status: 'idle' });
      setSelectedPath(null);
      setTreeCollapsed(false);
    }
  }, [open]);

  const loadChildren = useCallback(
    async (path: string) => {
      setDirectories((current) => ({
        ...current,
        [path]: { loading: true, entries: current[path]?.entries ?? [] },
      }));
      try {
        const data = await fetchDirectory(path);
        setDirectories((current) => ({
          ...current,
          [path]: { loading: false, entries: data.entries, truncated: data.truncated },
        }));
      } catch (err) {
        setDirectories((current) => ({
          ...current,
          [path]: {
            loading: false,
            entries: current[path]?.entries ?? [],
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [fetchDirectory],
  );

  const openFile = useCallback(async (entry: { path: string; relativePath: string; name: string }) => {
    setSelectedPath(entry.path);
    setFileViewMode(defaultFileViewMode(entry.name));
    setPreview({ status: 'loading', path: entry.path, relativePath: entry.relativePath, name: entry.name });
    try {
      const data = await fetchLocalArtifact(entry.path);
      setPreview({
        status: 'ready',
        path: entry.path,
        relativePath: entry.relativePath,
        name: entry.name,
        content: (data.content ?? '').slice(0, MAX_PREVIEW_CHARS),
        size: data.size,
      });
    } catch (err) {
      setPreview({
        status: 'error',
        path: entry.path,
        relativePath: entry.relativePath,
        name: entry.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!open || !target?.path) return;
    const key = `${conversationId}:${projectId ?? ''}:${target.requestId ?? 0}:${target.path}`;
    if (handledTargetRef.current === key) return;
    let cancelled = false;

    const revealTarget = async () => {
      const listing = await loadRoot();
      if (cancelled || !listing?.root) return;
      const targetPath = resolveTargetPathForRoot(listing.root, target.path);
      if (!isPathInsideRoot(targetPath, listing.root)) {
        const name = basenamePath(target.path);
        setPreview({
          status: 'error',
          path: target.path,
          relativePath: target.path,
          name,
          message: t('workspace.fileOutsideRoot'),
        });
        handledTargetRef.current = key;
        return;
      }
      const parentDirs = ancestorDirectoryPaths(listing.root, targetPath);
      setExpanded((current) => {
        const next = new Set(current);
        next.add(listing.root);
        for (const dir of parentDirs) next.add(dir);
        return next;
      });
      for (const dir of parentDirs) {
        if (cancelled) return;
        if (directoriesRef.current[dir]?.entries.length) continue;
        try {
          const data = await fetchDirectory(dir);
          setDirectories((current) => ({
            ...current,
            [dir]: { loading: false, entries: data.entries, truncated: data.truncated },
          }));
        } catch (err) {
          setDirectories((current) => ({
            ...current,
            [dir]: {
              loading: false,
              entries: current[dir]?.entries ?? [],
              error: err instanceof Error ? err.message : String(err),
            },
          }));
          return;
        }
      }
      if (cancelled) return;
      const name = basenamePath(targetPath);
      void openFile({
        path: targetPath,
        relativePath: relativePathFromRoot(listing.root, targetPath) ?? name,
        name,
      });
      handledTargetRef.current = key;
    };

    void revealTarget();
    return () => {
      cancelled = true;
    };
  }, [conversationId, fetchDirectory, loadRoot, open, openFile, projectId, t, target?.path, target?.requestId]);

  const toggleDirectoryNode = useCallback(
    (node: NodeApi<WorkspaceTreeNode>) => {
      const entry = node.data;
      if (entry.kind !== 'directory') return;
      const willOpen = !expandedRef.current.has(entry.path);
      const next = new Set(expandedRef.current);
      if (willOpen) next.add(entry.path);
      else next.delete(entry.path);
      expandedRef.current = next;
      setExpanded(next);

      syncingExpandedRef.current = true;
      try {
        if (willOpen) treeRef.current?.open(entry.path, false);
        else treeRef.current?.close(entry.path, false);
      } finally {
        syncingExpandedRef.current = false;
      }
      if (willOpen && !directoriesRef.current[entry.path]) void loadChildren(entry.path);
    },
    [loadChildren],
  );

  const activateTreeNode = useCallback(
    (node: NodeApi<WorkspaceTreeNode>) => {
      const entry = node.data;
      if (entry.kind === 'directory') {
        toggleDirectoryNode(node);
        return;
      }
      void openFile({ path: entry.path, relativePath: entry.relativePath, name: entry.name });
    },
    [openFile, toggleDirectoryNode],
  );

  const treeData = useMemo(() => {
    if (!root) return [];
    return buildTreeNodes(directories[root.root]?.entries ?? [], directories);
  }, [directories, root]);

  // Restore lazily-loaded / programmatically-expanded folders. Runs on tree
  // rebuilds (e.g. after a lazy load); a user-collapsed folder is no longer in
  // `expanded`, so it is never force-reopened here.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !root?.root) return;
    syncingExpandedRef.current = true;
    try {
      for (const id of expanded) {
        if (id !== root.root) tree.open(id, false);
      }
    } finally {
      syncingExpandedRef.current = false;
    }
  }, [expanded, root?.root, treeData]);

  // Reveal the selected file only when the selection itself changes — never on
  // an expand/collapse, otherwise selecting auto-reopens the folder the user
  // just collapsed.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !selectedPath) return;
    tree.select(selectedPath, { align: 'smart', focus: false });
    void tree.scrollTo(selectedPath, 'smart');
  }, [selectedPath]);

  const title = selectedProject?.name ?? root?.title ?? conversationTitle ?? t('workspace.currentConversation');
  const rootState = root ? directories[root.root] : undefined;
  const inline = presentation === 'inline';
  const treeHeight = Math.max(160, treeViewportSize.height || 360);
  const treeWidth = treeViewportSize.width || 240;

  const treePane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <InputGroup className="h-7 rounded-md bg-background">
          <InputGroupAddon align="inline-start" className="pl-2 pr-0">
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('workspace.filter')}
            size="sm"
            className="h-7 text-2xs placeholder:text-2xs placeholder:text-muted-foreground/55"
          />
        </InputGroup>
      </div>
      <div ref={treeViewportRef} className="soft-scroll min-h-0 flex-1 overflow-auto px-1 pb-1.5">
        {rootState?.error ? (
          <EmptyState title={t('workspace.treeError')} detail={rootState.error} />
        ) : !root ? (
          <LoadingState label={t('workspace.loadingTree')} />
        ) : treeData.length ? (
          <Tree<WorkspaceTreeNode>
            ref={treeRef}
            data={treeData}
            idAccessor={(node) => node.id}
            childrenAccessor={(node) => node.children ?? null}
            width={treeWidth}
            height={treeHeight}
            rowHeight={24}
            indent={14}
            overscanCount={12}
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            openByDefault={false}
            selection={selectedPath ?? undefined}
            searchTerm={query.trim()}
            searchMatch={(node, term) => {
              const needle = term.trim().toLowerCase();
              if (!needle) return true;
              return node.data.name.toLowerCase().includes(needle) || node.data.relativePath.toLowerCase().includes(needle);
            }}
            onActivate={activateTreeNode}
            onToggle={(id) => {
              if (syncingExpandedRef.current || !id) return;
              const next = new Set(expandedRef.current);
              const willOpen = !next.has(id);
              if (willOpen) next.add(id);
              else next.delete(id);
              expandedRef.current = next;
              setExpanded(next);
              if (willOpen && !directoriesRef.current[id]) void loadChildren(id);
            }}
            className="soft-scroll outline-none"
            rowClassName="outline-none"
          >
            {WorkspaceTreeRow}
          </Tree>
        ) : (
          <EmptyState
            title={query ? t('workspace.emptyFilterTitle') : root?.mode === 'project' ? t('workspace.emptyDirTitle') : t('workspace.emptyArtifactTitle')}
            detail={query ? t('workspace.emptyFilterDetail') : root?.mode === 'project' ? t('workspace.emptyDirDetail') : t('workspace.emptyArtifactDetail')}
          />
        )}
        {rootState?.truncated ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">{t('workspace.truncated', { count: 500 })}</div>
        ) : null}
      </div>
    </div>
  );

  const body = inline ? (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <PreviewPane
          preview={preview}
          fileViewMode={fileViewMode}
          onFileViewModeChange={setFileViewMode}
          rootTitle={title}
          treeCollapsed={treeCollapsed}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
          onBack={() => setPreview({ status: 'idle' })}
        />
      </section>
      {!treeCollapsed ? (
        <section className="flex min-h-0 w-[248px] shrink-0 flex-col border-l border-border">{treePane}</section>
      ) : null}
    </div>
  ) : preview.status === 'idle' ? (
    <div className="flex min-h-0 flex-1">{treePane}</div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewPane
        preview={preview}
        fileViewMode={fileViewMode}
        onFileViewModeChange={setFileViewMode}
        rootTitle={title}
        singlePane
        onBack={() => setPreview({ status: 'idle' })}
      />
    </div>
  );

  if (embedded) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">{body}</div>
      </TooltipProvider>
    );
  }

  const content = (
    <TooltipProvider delayDuration={300}>
      <aside className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2 pl-2.5">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          <IconAction icon={inline ? PanelRight : X} label={t('workspace.close')} onClick={() => onOpenChange(false)} />
        </div>
        {body}
      </aside>
    </TooltipProvider>
  );

  if (inline) {
    return open ? content : null;
  }

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/30 backdrop-blur-xs"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={SPRING_PANEL}
            className="absolute inset-y-0 right-0 w-full max-w-md overflow-hidden border-l border-border bg-background shadow-xl"
          >
            {content}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  iconClassName,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  iconClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
        >
          <Icon className={cn('size-4', iconClassName)} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

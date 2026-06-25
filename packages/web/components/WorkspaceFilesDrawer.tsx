'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PanelRight,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist';
import { ArtifactPreviewContent } from '@/components/ArtifactPreviewContent';
import { CodeView, langFromPath } from '@/components/CodeView';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { webApiFetch } from '@/lib/api';
import { artifactPreviewKind } from '@/lib/artifactPreview';
import type { ProjectView } from '@/lib/useResources';
import { cn } from '@/lib/utils';
import type { WorkspaceFileTarget } from '@/lib/workspaceFiles';

type WorkspaceEntry = {
  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'other';
  size?: number;
  modifiedAt?: string;
};

type WorkspaceTreeNode = WorkspaceEntry & {
  id: string;
  children?: WorkspaceTreeNode[];
  directoryState?: 'loading' | 'error';
};

type WorkspaceListing = {
  mode: 'project' | 'conversation';
  root: string;
  path: string;
  parent: string | null;
  title: string;
  entries: WorkspaceEntry[];
  truncated?: boolean;
};

type DirectoryState = {
  loading: boolean;
  entries: WorkspaceEntry[];
  error?: string;
  truncated?: boolean;
};

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string; relativePath: string; name: string }
  | { status: 'ready'; path: string; relativePath: string; name: string; content: string; size?: number }
  | { status: 'error'; path: string; relativePath: string; name: string; message: string };

type FileViewMode = 'preview' | 'source';

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
    async (path?: string): Promise<WorkspaceListing> => {
      const params = new URLSearchParams({ conversationId, source: 'web' });
      if (projectId) params.set('projectId', projectId);
      if (path) params.set('path', path);
      const response = await webApiFetch(`/api/workspace/files?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as WorkspaceListing & { error?: string };
      if (!response.ok) throw new Error(data.error || `workspace_files_http_${response.status}`);
      return data;
    },
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
      const response = await webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(entry.path)}`);
      const data = (await response.json().catch(() => ({}))) as { content?: string; size?: number; error?: string };
      if (!response.ok) throw new Error(data.error || `file_preview_http_${response.status}`);
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
  const treeWidth = Math.max(treeViewportSize.width || 240, estimateTreeWidth(treeData));

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
            className="h-7 text-[10.5px] placeholder:text-[10.5px] placeholder:text-muted-foreground/55"
          />
        </InputGroup>
      </div>
      <div ref={treeViewportRef} className="soft-scroll min-h-0 flex-1 overflow-x-auto px-1.5 pb-1.5">
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
            rowHeight={22}
            indent={12}
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
        <div className="flex h-full min-h-0 flex-col bg-background text-ink">{body}</div>
      </TooltipProvider>
    );
  }

  const content = (
    <TooltipProvider delayDuration={300}>
      <aside className="flex h-full min-h-0 flex-col bg-background text-ink">
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
            transition={{ type: 'spring', stiffness: 280, damping: 32 }}
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
          className="shrink-0 text-muted-foreground hover:text-ink"
          aria-label={label}
        >
          <Icon className={cn('size-4', iconClassName)} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function WorkspaceTreeRow({ node, style }: NodeRendererProps<WorkspaceTreeNode>) {
  const entry = node.data;
  const isDirectory = entry.kind === 'directory';
  const state = isDirectory ? node.data.directoryState : undefined;
  const loading = isDirectory && state === 'loading';
  const hasError = isDirectory && state === 'error';
  return (
    <div style={style} className="px-1">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          node.activate();
        }}
        className={cn(
          'group relative flex h-5 w-full items-center gap-1 rounded-md pr-2 text-left text-[10.5px] leading-5 tracking-tight outline-none transition-colors',
          'hover:bg-muted/60 focus-visible:bg-muted',
          node.isSelected &&
            'bg-muted font-medium text-ink before:absolute before:left-0 before:top-1/2 before:h-3 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary',
          hasError && 'text-rose-500',
        )}
        style={{ paddingLeft: 6 + node.level * 12 }}
        title={entry.relativePath}
      >
        <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : isDirectory ? (
            <ChevronRight className={cn('size-3 transition-transform duration-150', node.isOpen && 'rotate-90')} />
          ) : null}
        </span>
        <FileIcon entry={entry} expanded={node.isOpen} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
    </div>
  );
}

function FileIcon({ entry, expanded }: { entry: WorkspaceEntry; expanded: boolean }) {
  if (entry.kind === 'directory') {
    return expanded ? <FolderOpen className="size-3 shrink-0 text-muted-foreground" /> : <Folder className="size-3 shrink-0 text-muted-foreground" />;
  }
  const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : '';
  if (entry.name === 'package.json' || ext === 'json') {
    return <Braces className="size-3 shrink-0 text-orange-500" />;
  }
  if (ext === 'md' || ext === 'mdx') {
    return <span className="w-3 shrink-0 text-center text-[8px] font-bold tracking-tight text-emerald-600">M↓</span>;
  }
  if (ext === 'yml' || ext === 'yaml') {
    return <Code2 className="size-3 shrink-0 text-rose-500" />;
  }
  if (entry.name.startsWith('Dockerfile') || entry.name === 'docker-compose.yml') {
    return <Code2 className="size-3 shrink-0 text-sky-500" />;
  }
  if (langFromPath(entry.name)) {
    return <FileCode2 className="size-3 shrink-0 text-blue-500" />;
  }
  return <FileText className="size-3 shrink-0 text-muted-foreground" />;
}

function PreviewPane({
  preview,
  fileViewMode,
  onFileViewModeChange,
  rootTitle,
  singlePane = false,
  treeCollapsed,
  onToggleTree,
  onBack,
}: {
  preview: PreviewState;
  fileViewMode: FileViewMode;
  onFileViewModeChange: (mode: FileViewMode) => void;
  rootTitle: string;
  singlePane?: boolean;
  treeCollapsed?: boolean;
  onToggleTree?: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const headerProps = { fileViewMode, onFileViewModeChange, rootTitle, singlePane, treeCollapsed, onToggleTree, onBack };
  if (preview.status === 'idle') {
    return <EmptyState title={t('workspace.openFileTitle')} detail={t('workspace.openFileDetail')} />;
  }
  if (preview.status === 'loading') {
    return (
      <>
        <PreviewHeader preview={preview} {...headerProps} />
        <LoadingState label={t('workspace.openingFile')} />
      </>
    );
  }
  if (preview.status === 'error') {
    return (
      <>
        <PreviewHeader preview={preview} {...headerProps} />
        <EmptyState title={t('workspace.previewErrorTitle')} detail={preview.message} />
      </>
    );
  }
  return (
    <>
      <PreviewHeader preview={preview} {...headerProps} />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {fileViewMode === 'preview' && canPreviewFile(preview.name) ? (
          <ArtifactPreviewContent
            content={preview.content}
            path={preview.path}
            compact
            fullHeight
            className="h-full rounded-none border-0"
          />
        ) : (
          <CodeView
            code={preview.content}
            lang={langFromPath(preview.name)}
            lineNumbers
            className="h-full rounded-none border-0 bg-background text-[12px] leading-6"
          />
        )}
      </div>
    </>
  );
}

function PreviewHeader({
  preview,
  fileViewMode,
  onFileViewModeChange,
  rootTitle,
  singlePane,
  treeCollapsed,
  onToggleTree,
  onBack,
}: {
  preview: Exclude<PreviewState, { status: 'idle' }>;
  fileViewMode: FileViewMode;
  onFileViewModeChange: (mode: FileViewMode) => void;
  rootTitle: string;
  singlePane?: boolean;
  treeCollapsed?: boolean;
  onToggleTree?: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const toggleLabel = treeCollapsed ? t('workspace.expandTree') : t('workspace.collapseTree');
  const showModeToggle = preview.status === 'ready' && canPreviewFile(preview.name);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2 pl-2.5 text-sm">
      {singlePane ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onBack}
              className="shrink-0 text-muted-foreground hover:text-ink"
              aria-label={t('workspace.back')}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('workspace.back')}</TooltipContent>
        </Tooltip>
      ) : null}
      <Breadcrumb parts={[rootTitle, ...preview.relativePath.split('/').filter(Boolean)]} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {showModeToggle ? (
          <div className="flex h-7 items-center rounded-md bg-surface-2 p-0.5">
            <button
              type="button"
              onClick={() => onFileViewModeChange('preview')}
              className={cn(
                'h-6 rounded-sm px-2 text-xs transition-colors',
                fileViewMode === 'preview' ? 'bg-background font-medium text-ink shadow-xs' : 'text-muted-foreground hover:text-ink',
              )}
            >
              {t('workspace.previewMode')}
            </button>
            <button
              type="button"
              onClick={() => onFileViewModeChange('source')}
              className={cn(
                'h-6 rounded-sm px-2 text-xs transition-colors',
                fileViewMode === 'source' ? 'bg-background font-medium text-ink shadow-xs' : 'text-muted-foreground hover:text-ink',
              )}
            >
              {t('workspace.sourceMode')}
            </button>
          </div>
        ) : null}
        {onToggleTree ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onToggleTree}
                className="shrink-0 text-muted-foreground hover:text-ink"
                aria-label={toggleLabel}
              >
                {treeCollapsed ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{toggleLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

function canPreviewFile(path: string): boolean {
  return artifactPreviewKind(path) !== 'code';
}

function defaultFileViewMode(path: string): FileViewMode {
  return canPreviewFile(path) ? 'preview' : 'source';
}

function Breadcrumb({ parts }: { parts: string[] }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <FragmentPart key={`${part}-${index}`} muted={index < parts.length - 1}>
          {part}
        </FragmentPart>
      ))}
    </div>
  );
}

function FragmentPart({ children, muted }: { children: ReactNode; muted: boolean }) {
  return (
    <>
      <span className={cn('min-w-0 truncate', muted ? 'text-muted-foreground' : 'font-medium text-ink')}>{children}</span>
      {muted ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
    </>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <FolderOpen className="mb-3 h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  );
}

function buildTreeNodes(entries: WorkspaceEntry[], directories: Record<string, DirectoryState>): WorkspaceTreeNode[] {
  return entries.map((entry) => {
    const node: WorkspaceTreeNode = { ...entry, id: entry.path };
    if (entry.kind !== 'directory') {
      return node;
    }
    const state = directories[entry.path];
    if (!state) {
      node.children = [];
      return node;
    }
    if (state.error) {
      node.directoryState = 'error';
      node.children = [];
      return node;
    }
    if (state.loading) {
      node.directoryState = 'loading';
    }
    node.children = buildTreeNodes(state.entries, directories);
    return node;
  });
}

function estimateTreeWidth(nodes: WorkspaceTreeNode[], level = 0): number {
  let width = 240;
  for (const node of nodes) {
    width = Math.max(width, 70 + level * 14 + node.name.length * 10);
    if (node.children?.length) {
      width = Math.max(width, estimateTreeWidth(node.children, level + 1));
    }
  }
  return width;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function resolveTargetPathForRoot(root: string, path: string): string {
  if (isAbsolutePath(path)) {
    return normalizePath(path);
  }
  return normalizePathWithDotSegments(`${normalizePath(root)}/${path}`);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function ancestorDirectoryPaths(root: string, path: string): string[] {
  const relative = relativePathFromRoot(root, path);
  if (!relative) return [];
  const parts = relative.split('/').filter(Boolean);
  parts.pop();
  const ancestors: string[] = [];
  let current = normalizePath(root);
  for (const part of parts) {
    current = `${current}/${part}`;
    ancestors.push(current);
  }
  return ancestors;
}

function relativePathFromRoot(root: string, path: string): string | undefined {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function basenamePath(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function normalizePathWithDotSegments(path: string): string {
  const normalized = normalizePath(path);
  const absolute = normalized.startsWith('/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

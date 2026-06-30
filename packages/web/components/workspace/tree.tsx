'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import { Icon, addCollection } from '@iconify/react';
import vscodeIcons from '@iconify-json/vscode-icons/icons.json';
import type { NodeRendererProps } from 'react-arborist';
import { cn } from '@/lib/utils';

// VS Code 风格的彩色文件类型图标（codex 同款），整套离线加载，不依赖外网。
addCollection(vscodeIcons);

const FILE_ICON_BY_NAME: Record<string, string> = {
  'package.json': 'file-type-npm',
  'tsconfig.json': 'file-type-tsconfig',
  'tsconfig.base.json': 'file-type-tsconfig',
  'docker-compose.yml': 'file-type-docker2',
  'docker-compose.yaml': 'file-type-docker2',
  dockerfile: 'file-type-docker2',
  'pnpm-lock.yaml': 'file-type-pnpm',
  'pnpm-workspace.yaml': 'file-type-pnpm',
  '.gitignore': 'file-type-git',
  '.npmrc': 'file-type-npm',
};

const FILE_ICON_BY_EXT: Record<string, string> = {
  ts: 'file-type-typescript',
  tsx: 'file-type-reactts',
  js: 'file-type-js',
  mjs: 'file-type-js',
  cjs: 'file-type-js',
  jsx: 'file-type-reactjs',
  json: 'file-type-json',
  jsonc: 'file-type-json',
  md: 'file-type-markdown',
  mdx: 'file-type-markdown',
  markdown: 'file-type-markdown',
  yml: 'file-type-yaml',
  yaml: 'file-type-yaml',
  sh: 'file-type-shell',
  bash: 'file-type-shell',
  zsh: 'file-type-shell',
  css: 'file-type-css',
  scss: 'file-type-scss',
  less: 'file-type-less',
  html: 'file-type-html',
  htm: 'file-type-html',
  py: 'file-type-python',
  go: 'file-type-go',
  rs: 'file-type-rust',
  toml: 'file-type-toml',
  xml: 'file-type-xml',
  svg: 'file-type-svg',
  png: 'file-type-image',
  jpg: 'file-type-image',
  jpeg: 'file-type-image',
  gif: 'file-type-image',
  webp: 'file-type-image',
  lock: 'file-type-lock',
  env: 'file-type-dotenv',
  txt: 'file-type-text',
};
import type { WorkspaceEntry } from '@/lib/services';
import type { DirectoryState, WorkspaceTreeNode } from './types';

export function WorkspaceTreeRow({ node, style }: NodeRendererProps<WorkspaceTreeNode>) {
  const entry = node.data;
  const isDirectory = entry.kind === 'directory';
  const state = isDirectory ? node.data.directoryState : undefined;
  const loading = isDirectory && state === 'loading';
  const hasError = isDirectory && state === 'error';
  const depth = Math.max(0, node.level);
  return (
    <div style={style} className="px-1.5">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          node.activate();
        }}
        className={cn(
          'group relative flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs leading-6 outline-none transition-colors',
          'hover:bg-muted/55 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45',
          node.isSelected &&
            'bg-muted font-medium text-foreground shadow-xs before:absolute before:left-0 before:top-1/2 before:h-3.5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary',
          hasError && 'text-destructive',
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={entry.relativePath}
      >
        {depth > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-1.5 w-px bg-border/70"
            style={{ left: 10 + (depth - 1) * 14 }}
          />
        ) : null}
        <span className="relative z-10 flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isDirectory ? (
            <ChevronRight className={cn('size-3.5 transition-transform duration-[var(--duration-fast)]', node.isOpen && 'rotate-90')} />
          ) : null}
        </span>
        <FileIcon entry={entry} expanded={node.isOpen} />
        <span className="relative z-10 min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
    </div>
  );
}

function FileIcon({ entry, expanded }: { entry: WorkspaceEntry; expanded: boolean }) {
  const cls = 'relative z-10 size-3.5 shrink-0';
  if (entry.kind === 'directory') {
    return <Icon icon={`vscode-icons:${expanded ? 'default-folder-opened' : 'default-folder'}`} className={cls} />;
  }
  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  const iconName = FILE_ICON_BY_NAME[name] ?? FILE_ICON_BY_EXT[ext] ?? 'default-file';
  return <Icon icon={`vscode-icons:${iconName}`} className={cls} />;
}

export function buildTreeNodes(entries: WorkspaceEntry[], directories: Record<string, DirectoryState>): WorkspaceTreeNode[] {
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

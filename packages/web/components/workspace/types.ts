import type { WorkspaceEntry } from '@/lib/services';

export type WorkspaceTreeNode = WorkspaceEntry & {
  id: string;
  children?: WorkspaceTreeNode[];
  directoryState?: 'loading' | 'error';
};

export type DirectoryState = {
  loading: boolean;
  entries: WorkspaceEntry[];
  error?: string;
  truncated?: boolean;
};

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string; relativePath: string; name: string }
  | { status: 'ready'; path: string; relativePath: string; name: string; content: string; size?: number }
  | { status: 'error'; path: string; relativePath: string; name: string; message: string };

export type FileViewMode = 'preview' | 'source';

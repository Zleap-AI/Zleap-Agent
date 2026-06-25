export type WorkspaceFileTarget = {
  path: string;
  source?: 'artifact' | 'workspace' | 'manual';
  requestId?: number;
};

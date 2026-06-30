/** Wire types shared by the service layer and the components that consume it. */

export type WorkspaceEntry = {
  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'other';
  size?: number;
  modifiedAt?: string;
};

export type WorkspaceListing = {
  mode: 'project' | 'conversation';
  root: string;
  path: string;
  parent: string | null;
  title: string;
  entries: WorkspaceEntry[];
  truncated?: boolean;
};

export type RuntimeContextView = {
  mode: 'local';
  availableModes?: ['local'];
  branch?: string;
};

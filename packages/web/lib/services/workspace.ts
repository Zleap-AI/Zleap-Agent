import { getJson } from '@/lib/api';
import type { WorkspaceListing } from './types';

/** List a workspace directory for a conversation/project (web source). */
export function listWorkspaceFiles(params: {
  conversationId: string;
  projectId?: string;
  path?: string;
  signal?: AbortSignal;
}): Promise<WorkspaceListing> {
  const search = new URLSearchParams({ conversationId: params.conversationId, source: 'web' });
  if (params.projectId) search.set('projectId', params.projectId);
  if (params.path) search.set('path', params.path);
  return getJson<WorkspaceListing>(`/api/workspace/files?${search.toString()}`, { signal: params.signal });
}

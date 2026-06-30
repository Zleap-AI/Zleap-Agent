import { getJson } from '@/lib/api';

/** Read a locally-stored artifact (text content + optional size) by path. */
export function fetchLocalArtifact(path: string): Promise<{ content?: string; size?: number }> {
  return getJson<{ content?: string; size?: number }>(`/api/artifacts/local?path=${encodeURIComponent(path)}`);
}

/** Read a locally-stored artifact's text content by path. */
export async function fetchLocalArtifactContent(path: string): Promise<string> {
  const data = await fetchLocalArtifact(path);
  if (typeof data.content !== 'string') {
    throw new Error('artifact_content_missing');
  }
  return data.content;
}

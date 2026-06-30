import { getJson, postJson } from '@/lib/api';

export type ProjectDefaults = { root?: string; home?: string };

/** Default project root + home dir suggestions for the create-project flow. */
export async function fetchProjectDefaults(): Promise<ProjectDefaults> {
  try {
    return await getJson<ProjectDefaults>('/api/projects/defaults');
  } catch {
    return {};
  }
}

/** Register a project folder. */
export function createProject(input: {
  id: string;
  name: string;
  path: string;
  createPath?: boolean;
}): Promise<{ project?: { id: string; name: string } }> {
  return postJson('/api/projects', input) as Promise<{ project?: { id: string; name: string } }>;
}

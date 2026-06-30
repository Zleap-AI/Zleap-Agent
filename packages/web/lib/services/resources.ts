import { deleteJson } from '@/lib/api';

/** Delete a space by its storage/profile id. */
export function deleteSpace(id: string): Promise<unknown> {
  return deleteJson('/api/spaces', { id });
}

/** Delete an avatar by id. */
export function deleteAvatar(id: string): Promise<unknown> {
  return deleteJson('/api/avatar', { id });
}

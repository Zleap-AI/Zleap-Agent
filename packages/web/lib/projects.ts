import { parseAvatarTheme, type AvatarTheme } from '@/lib/avatars';
import { slugify } from '@/lib/utils';

/** Project sidebar theme uses the same emoji + accent scheme as avatars. */
export function parseProjectTheme(project?: { emoji?: string; accent?: string }): AvatarTheme {
  return parseAvatarTheme({ emoji: project?.emoji, accent: project?.accent });
}

/** Suggested path for a new project folder under the server default root. */
export function projectPathForName(root: string, name: string): string {
  const slug = slugify(name);
  if (!slug) return root;
  const trimmedRoot = root.replace(/\/+$/, '');
  return `${trimmedRoot}/${slug}`;
}

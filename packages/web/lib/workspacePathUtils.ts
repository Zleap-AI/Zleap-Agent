/** Pure path helpers for the workspace file tree (extracted from the drawer). */

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

export function normalizePathWithDotSegments(path: string): string {
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

export function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function resolveTargetPathForRoot(root: string, path: string): string {
  if (isAbsolutePath(path)) {
    return normalizePath(path);
  }
  return normalizePathWithDotSegments(`${normalizePath(root)}/${path}`);
}

export function relativePathFromRoot(root: string, path: string): string | undefined {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export function ancestorDirectoryPaths(root: string, path: string): string[] {
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

export function basenamePath(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

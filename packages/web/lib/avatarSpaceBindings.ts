export const AVATAR_BOUND_SPACE_IDS_KEY = 'boundSpaceIds';

/**
 * `undefined` means "all spaces". A non-empty array means "only these spaces".
 * Keeping this rule in one place avoids the UI and API drifting apart.
 */
export function normalizeBoundSpaceIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? ids : undefined;
}

export function boundSpaceIdsFromMetadata(metadata: Record<string, unknown> | undefined): string[] | undefined {
  return normalizeBoundSpaceIds(metadata?.[AVATAR_BOUND_SPACE_IDS_KEY]);
}

export function boundSpaceIdsMetadataPatch(spaceIds: string[]): Record<string, unknown> {
  return { [AVATAR_BOUND_SPACE_IDS_KEY]: normalizeBoundSpaceIds(spaceIds) ?? null };
}

export function filterSpacesForAvatarBinding<T extends { id?: string; storageId?: string; canonicalId?: string }>(
  spaces: T[],
  metadata: Record<string, unknown> | undefined,
): T[] {
  const boundSpaceIds = boundSpaceIdsFromMetadata(metadata);
  if (!boundSpaceIds) return spaces;
  const allowed = new Set(boundSpaceIds);
  return spaces.filter(
    (space) =>
      (space.id !== undefined && allowed.has(space.id)) ||
      (space.storageId !== undefined && allowed.has(space.storageId)) ||
      (space.canonicalId !== undefined && allowed.has(space.canonicalId)),
  );
}

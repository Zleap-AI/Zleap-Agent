export const DEFAULT_AVATAR_ID = 'zleap-default';

export const CANONICAL_MAIN_SPACE_ID = 'main';

export const LEGACY_SESSION_SPACE_ID = 'session';

export const DEFAULT_SPACE_IDS = ['main', 'cli', 'web-search'] as const;

export type DefaultSpaceId = (typeof DEFAULT_SPACE_IDS)[number];

/**
 * Runtime still registers the master space under the legacy id `session`; the
 * canonical/config/storage id is `main`. These two helpers translate at the
 * boundary so the rest of the system can speak a single canonical vocabulary.
 */
export function toRuntimeSpaceId(spaceId: string): string {
  return spaceId === CANONICAL_MAIN_SPACE_ID ? LEGACY_SESSION_SPACE_ID : spaceId;
}

export function toCanonicalSpaceId(spaceId: string): string {
  return spaceId === LEGACY_SESSION_SPACE_ID ? CANONICAL_MAIN_SPACE_ID : spaceId;
}

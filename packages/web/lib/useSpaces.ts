'use client';

import { useEffect, useState } from 'react';
import type { SpaceItem } from './spaces';
import { webApiFetch } from './api';

export function useSpaces(refreshKey?: unknown, avatarId?: string): SpaceItem[] {
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    webApiFetch(`/api/spaces${avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : ''}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: { spaces?: SpaceItem[] }) => {
        if (!cancelled && Array.isArray(body.spaces)) {
          setSpaces(body.spaces);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSpaces([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId, refreshKey]);

  return spaces;
}

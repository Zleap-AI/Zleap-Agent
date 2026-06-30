'use client';

import { useEffect, useRef, useState } from 'react';

const PROJECT_ORDER_KEY = 'zleap-sidebar-project-order';

function readStoredStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function normalizeProjectOrder(projectIds: string[], order: string[]): string[] {
  const available = new Set(projectIds);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of order) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of projectIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function orderProjects<T extends { id: string }>(projects: T[], order: string[]): T[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const orderedIds = normalizeProjectOrder(
    projects.map((project) => project.id),
    order,
  );
  return orderedIds.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
}

export function moveStringItem(items: string[], from: number, to: number): string[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  const target = Math.max(0, Math.min(from < to ? to - 1 : to, next.length));
  next.splice(target, 0, item);
  return next;
}

export function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * localStorage-backed sidebar project ordering. Loads on mount, keeps the order
 * normalized against the live project list, and persists on every change — so the
 * Sidebar no longer hand-rolls this persistence inline.
 */
export function useProjectOrder(projectIds: string[]) {
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setProjectOrder(readStoredStringList(localStorage.getItem(PROJECT_ORDER_KEY)));
    } catch {
      setProjectOrder([]);
    } finally {
      setReady(true);
    }
  }, []);

  // Keep order in sync with the available projects (drop removed, append new).
  const projectIdsKey = projectIds.join('\u0000');
  const projectIdsRef = useRef(projectIds);
  projectIdsRef.current = projectIds;
  useEffect(() => {
    if (!ready) return;
    setProjectOrder((current) => {
      const next = normalizeProjectOrder(projectIdsRef.current, current);
      return sameStringList(current, next) ? current : next;
    });
  }, [ready, projectIdsKey]);

  // Persist whenever the order changes (after the initial load).
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(projectOrder));
    } catch {
      /* ignore */
    }
  }, [ready, projectOrder]);

  return { projectOrder, setProjectOrder, ready };
}

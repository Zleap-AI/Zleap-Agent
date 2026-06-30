import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Defaults mirrored from hermes feish.py. */
export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEDUP_MAX_SIZE = 2048;

/**
 * File-backed message dedup with TTL. Survives restarts so a redelivered event
 * (platform retry) is not processed twice. Writes are debounced and best-effort:
 * a failed persist never blocks message handling.
 */
export class FileDedupStore {
  private readonly seen = new Map<string, number>();
  private persistTimer: NodeJS.Timeout | undefined;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly ttlMs: number = DEDUP_TTL_MS,
    private readonly maxSize: number = DEDUP_MAX_SIZE,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [id, ts] of Object.entries(parsed)) {
        if (typeof ts === 'number' && now - ts < this.ttlMs) {
          this.seen.set(id, ts);
        }
      }
      this.trim();
    } catch {
      // No prior file / unreadable: start clean.
    }
  }

  /** Returns true if the id was already seen (and refreshes its timestamp). */
  isDuplicate(id: string): boolean {
    this.prune();
    if (this.seen.has(id)) {
      return true;
    }
    this.seen.set(id, Date.now());
    this.trim();
    this.schedulePersist();
    return false;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts >= this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }

  private trim(): void {
    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 1000);
    this.persistTimer.unref?.();
  }

  async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(this.seen)), 'utf8');
    } catch {
      // Best-effort: dedup degrades to in-memory only.
    }
  }
}

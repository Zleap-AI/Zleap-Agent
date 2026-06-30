/**
 * Per-key serial lock. Guarantees that for a given key (a conversation id) the
 * critical section "load history -> run agent -> persist" runs atomically, so
 * concurrent messages on the same conversation never read stale history. Keys
 * are independent, so different conversations still run in parallel.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => current);
    this.tails.set(key, tail);
    await prev;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
      // Drop the entry only when no newer waiter has queued behind us.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
  }

  get size(): number {
    return this.tails.size;
  }
}

/**
 * Counting semaphore for a global concurrency cap across all conversations
 * (backpressure: prevents a flood of chats from exhausting model quota). A
 * non-positive limit disables the cap entirely.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.limit <= 0) {
      return () => {};
    }
    if (this.available > 0) {
      this.available -= 1;
      return () => this.releaseOne();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.releaseOne();
  }

  private releaseOne(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available = Math.min(this.limit, this.available + 1);
  }
}

export type SideEffectOptions = {
  queueKey: string;
  idempotencyKey?: string;
  rollback?: (error: unknown) => void | Promise<void>;
};

const MAX_IDEMPOTENCY_RESULTS = 500;
const SIDE_EFFECT_QUEUES = new Map<string, Promise<void>>();
const IDEMPOTENCY_RESULTS = new Map<string, unknown>();

export async function runSideEffect<T>(options: SideEffectOptions, operation: () => Promise<T>): Promise<T> {
  const previous = SIDE_EFFECT_QUEUES.get(options.queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const nextTail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => nextTail);
  SIDE_EFFECT_QUEUES.set(options.queueKey, queued);

  await previous.catch(() => undefined);
  try {
    if (options.idempotencyKey && IDEMPOTENCY_RESULTS.has(options.idempotencyKey)) {
      return IDEMPOTENCY_RESULTS.get(options.idempotencyKey) as T;
    }
    const result = await operation();
    if (options.idempotencyKey) {
      rememberIdempotencyResult(options.idempotencyKey, result);
    }
    return result;
  } catch (error) {
    await options.rollback?.(error);
    throw error;
  } finally {
    releaseQueue();
    if (SIDE_EFFECT_QUEUES.get(options.queueKey) === queued) {
      SIDE_EFFECT_QUEUES.delete(options.queueKey);
    }
  }
}

export function sideEffectIdempotencyKey(parts: readonly unknown[]): string {
  return `idem_${shortHash(stableStringify(parts))}`;
}

export function resetSideEffectStateForTests(): void {
  SIDE_EFFECT_QUEUES.clear();
  IDEMPOTENCY_RESULTS.clear();
}

function rememberIdempotencyResult(key: string, value: unknown): void {
  IDEMPOTENCY_RESULTS.set(key, value);
  if (IDEMPOTENCY_RESULTS.size <= MAX_IDEMPOTENCY_RESULTS) {
    return;
  }
  const oldest = IDEMPOTENCY_RESULTS.keys().next().value as string | undefined;
  if (oldest) {
    IDEMPOTENCY_RESULTS.delete(oldest);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(8, '0').slice(-8);
}

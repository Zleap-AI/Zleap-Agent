/** Zleap CLI visual theme — gold-forward, minimal accent noise. */
export const BRAND_GOLD = '#FFC93C';
export const GOLD_DIM = '#B8922E';
export const GOLD_MUTED = '#8A7344';
export const TEXT_PRIMARY = 'whiteBright';
export const TEXT_MUTED = 'gray';
export const TEXT_ERROR = 'redBright';

/** OK / connected / success — gold, not green. */
export const STATUS_OK = BRAND_GOLD;
/** Degraded but usable. */
export const STATUS_WARN = GOLD_DIM;
/** Hard failure only. */
export const STATUS_FAIL = TEXT_ERROR;

export function statusTone(ok: boolean | undefined, partial?: boolean): string {
  if (ok === undefined) return TEXT_MUTED;
  if (ok) return STATUS_OK;
  if (partial) return STATUS_WARN;
  return STATUS_FAIL;
}

/** Mini progress bar for context window (Hermes-style). */
export function renderProgressBar(ratio: number, width = 12): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filledCount = Math.round(clamped * width);
  return {
    filled: '▓'.repeat(filledCount),
    empty: '░'.repeat(Math.max(0, width - filledCount)),
  };
}

export function formatContextPercent(ratio: number): string {
  return `${Math.min(99, Math.round(ratio * 100))}%`;
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

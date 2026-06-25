/**
 * Clip `text` to at most `max` characters, marking the elision with an ellipsis
 * that counts toward `max` — so the result is never wider than `max`. This is
 * the single truncation helper shared by the engine, the turn loop, and the UI
 * (fixed-width terminal layout relies on the ellipsis being included in width).
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The first line of `text` carrying actual prose, sans markdown heading marks.
 * Structure-only lines (horizontal rules `---`, code fences, bare markers) are
 * skipped, so a one-line fallback reads as a sentence rather than a divider.
 */
export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => /[\p{L}\p{N}]/u.test(line)) ?? ''
  );
}

export function sanitizeDisplayText(text: string | undefined, fallback = ''): string {
  const value = (text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!value) {
    return fallback;
  }
  const lines = value.split(/\r?\n/);
  const kept = lines.filter((line) => !isMojibakeLine(line));
  const cleaned = kept.join('\n');
  return cleaned.trim() ? cleaned : fallback;
}

function isMojibakeLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  if (!compact) {
    return false;
  }
  const replacementCount = (compact.match(/\uFFFD/g) ?? []).length;
  if (replacementCount >= 3) {
    return true;
  }
  if (replacementCount > 0 && replacementCount / compact.length > 0.08) {
    return true;
  }
  const suspiciousRuns = compact.match(/[^\p{L}\p{N}\p{P}\p{S}\p{Zs}]{2,}/gu);
  return Boolean(suspiciousRuns?.length);
}

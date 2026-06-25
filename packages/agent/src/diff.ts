/**
 * Minimal line diff for the edit/write tools. It trims the common prefix and
 * suffix, shows the changed middle as removed-then-added lines, and keeps a few
 * lines of surrounding context — enough to render a Claude-Code-style change
 * card without pulling in a full diff library.
 *
 * Each emitted row is prefixed with a single marker column so the UI (and the
 * model) can colour it: '+' added, '-' removed, ' ' unchanged context. The
 * marker is followed by a 1-based line number and the line text.
 */

const CONTEXT_LINES = 3;
const MAX_ROWS = 80;

export type LineDiff = {
  added: number;
  removed: number;
  rows: string[];
};

function gutter(n: number): string {
  return String(n).padStart(4);
}

export function diffLines(before: string, after: string): LineDiff {
  const a = before.length > 0 ? before.split('\n') : [];
  const b = after.length > 0 ? after.split('\n') : [];

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const rows: string[] = [];

  const lead = Math.min(CONTEXT_LINES, prefix);
  for (let i = prefix - lead; i < prefix; i += 1) {
    rows.push(` ${gutter(i + 1)} ${b[i]}`);
  }
  removed.forEach((line, i) => {
    rows.push(`-${gutter(prefix + i + 1)} ${line}`);
  });
  added.forEach((line, i) => {
    rows.push(`+${gutter(prefix + i + 1)} ${line}`);
  });
  const trail = Math.min(CONTEXT_LINES, suffix);
  for (let i = 0; i < trail; i += 1) {
    const index = b.length - suffix + i;
    rows.push(` ${gutter(index + 1)} ${b[index]}`);
  }

  return { added: added.length, removed: removed.length, rows };
}

/**
 * Render a diff as a single string whose first line is a header the UI matches
 * to switch into diff mode: `<Verb> <path> (+A -R)`. Long diffs are capped.
 */
export function formatDiff(verb: 'Updated' | 'Created', path: string, before: string, after: string): string {
  const { added, removed, rows } = diffLines(before, after);
  const counts = removed > 0 ? `(+${added} -${removed})` : `(+${added})`;
  const header = `${verb} ${path} ${counts}`;
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length > MAX_ROWS) {
    shown.push(`   … ${rows.length - MAX_ROWS} more lines`);
  }
  return [header, ...shown].join('\n');
}

/** Whether a tool result is one of our diff blocks (first line is the header). */
export function isDiffResult(result: string): boolean {
  const head = result.split('\n', 1)[0] ?? '';
  return /^(Updated|Created) .+ \(\+\d+( -\d+)?\)$/.test(head);
}

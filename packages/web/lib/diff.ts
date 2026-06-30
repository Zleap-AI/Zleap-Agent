// Ported from the CLI's `packages/cli/src/diff.ts`. The edit/write tools return
// a result whose first line is a header like `Updated path (+3 -1)`; the UI
// matches that to switch a tool card into diff-rendering mode.

/** Whether a tool result is one of our diff blocks (first line is the header). */
export function isDiffResult(result: string): boolean {
  const head = result.split('\n', 1)[0] ?? '';
  return /^(Updated|Created) .+ \(\+\d+( -\d+)?\)$/.test(head);
}

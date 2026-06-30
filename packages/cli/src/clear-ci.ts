// Ink (via `is-in-ci`) disables interactive live rendering when `$CI` is set —
// it assumes a non-interactive CI log and only prints static output plus a final
// frame on exit. That blanks our input box in any environment that exports
// CI=true (some shells, tmux configs, dev tooling).
//
// `is-in-ci` computes its boolean at import time and caches it, so we must clear
// CI *before* Ink is imported. This module is imported first in index.tsx for
// exactly that reason (ESM evaluates dependencies in source order). We only do
// it when attached to a real terminal, so genuine non-TTY CI runs are untouched.
if (process.env.CI && process.stdout.isTTY) {
  delete process.env.CI;
}

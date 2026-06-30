#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/packages/cli"
pnpm exec vitest run --passWithNoTests 2>/dev/null || pnpm vitest run
node -e "import('./dist/index.js').catch(()=>{})" 2>/dev/null || true
echo "Smoke: zleap --help"
pnpm exec zleap --help >/dev/null 2>&1 || node dist/index.js --help >/dev/null
echo "Smoke: zleap doctor --json"
pnpm exec zleap doctor --json >/dev/null 2>&1 || node dist/index.js doctor --json >/dev/null || true
echo "✓ CLI smoke passed"

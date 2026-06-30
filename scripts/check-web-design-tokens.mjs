#!/usr/bin/env node
// Design-system guard for packages/web. Fails (exit 1) when component/app source
// reintroduces hardcoded styling that should go through the single-source tokens
// in app/globals.css. Wire into CI via `pnpm --filter @zleap/web check:design`.
import { readFileSync, globSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'packages/web');
const files = globSync('{components,app}/**/*.tsx', { cwd: ROOT });

// Each rule matches forbidden *className* token forms. HTML/template-literal CSS
// (e.g. sandbox iframe docs) does not use these class shapes, so it is unaffected.
// `skipUi` rules are not enforced inside `components/ui/*` — those are generated
// shadcn primitives whose Radix enter/exit animations legitimately use raw
// `duration-100` etc.; the motion-token rule applies to hand-written app code only.
const RULES = [
  // `[\d.]+px` (not just `\d+px`) so decimals like `text-[10.5px]` are caught too.
  { name: 'arbitrary font px (use text-2xs/xs/sm/base)', re: /text-\[[\d.]+px\]/g },
  { name: 'legacy alias token (use shadcn token)', re: /\b(?:text-ink|bg-surface(?:-[123])?|bg-console(?:-screen)?|border-border-strong|text-faint)\b/g },
  {
    name: 'raw tailwind palette color (use semantic/chart token)',
    re: /\b(?:bg|text|border|ring|from|to|via)-(?:orange|amber|sky|emerald|violet|red|green|blue|slate|gray|zinc|stone|neutral)-\d{2,3}\b/g,
  },
  { name: 'hardcoded hex in arbitrary class (use token)', re: /(?:bg|text|border|ring|shadow|fill|stroke)-\[#[0-9a-fA-F]{3,8}/g },
  // Motion must flow through the duration tokens. `duration-[var(--duration-*)]`
  // is allowed (the `[` after `duration-` dodges this `\d` match); raw Tailwind
  // steps like `duration-300` are not.
  {
    name: 'hardcoded transition duration (use duration-[var(--duration-fast|base|slow)])',
    re: /\bduration-\d+\b/g,
    skipUi: true,
  },
  // Use the `ease-out` / `ease-spring` token utilities, never an ad-hoc cubic-bezier.
  { name: 'arbitrary easing (use ease-out/ease-spring token)', re: /\bease-\[/g, skipUi: true },
];

let failures = 0;
for (const rel of files) {
  const inUi = rel.startsWith('components/ui/');
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.skipUi && inUi) continue;
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (m) {
        failures += 1;
        console.error(`${relative(process.cwd(), join(ROOT, rel))}:${i + 1}  ${rule.name}  →  ${m[0]}`);
      }
    }
  });
}

if (failures > 0) {
  console.error(`\n✖ ${failures} design-token violation(s). Use tokens from app/globals.css (see .cursor/rules/frontend.mdc).`);
  process.exit(1);
}
console.log('✓ web design-token guard passed');

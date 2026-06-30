'use client';

import { memo, useEffect, useRef } from 'react';
import clsx from 'clsx';
import hljs from 'highlight.js';

// File extension → highlight.js language id. Covers the languages bundled in
// `highlight.js/lib/common`; unknown extensions fall back to auto-detection.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  lua: 'lua',
  r: 'r',
};

/** Best-effort highlight.js language id from a file path (or fence info-string). */
export function langFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const clean = path.split(/[?#]/)[0]!.trim();
  const ext = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext];
}

type CodeViewProps = {
  code: string;
  /** A highlight.js language id; falls back to auto-detection when unknown. */
  lang?: string;
  /** Render a left gutter with 1-based line numbers (used by the file viewer). */
  lineNumbers?: boolean;
  /**
   * Run syntax highlighting. Turn this OFF while text is still streaming —
   * re-highlighting (and re-auto-detecting the language) on every token makes
   * the block flicker; we render plain, stable text live and colour on commit.
   */
  highlight?: boolean;
  className?: string;
};

/**
 * Syntax-highlighted code, coloured by the `.hljs-*` token palette in
 * globals.css (so it tracks light/dark). Shared by the assistant markdown
 * renderer (fenced blocks) and the workspace-console file viewer (`lineNumbers` on).
 */
function CodeViewImpl({ code, lang, lineNumbers = false, highlight = true, className }: CodeViewProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !highlight) return;
    try {
      el.innerHTML =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang }).value
          : hljs.highlightAuto(code).value;
    } catch {
      el.textContent = code;
    }
  }, [code, lang, highlight]);

  const count = lineNumbers ? code.split('\n').length : 0;

  return (
    <div
      className={clsx(
        'hljs soft-scroll w-full min-w-0 max-w-full overflow-x-auto rounded-sm border border-border bg-muted text-xs leading-6',
        className,
      )}
    >
      <div className="flex min-w-0">
        {lineNumbers ? (
          <div
            aria-hidden
            className="shrink-0 select-none border-r border-border px-3 py-3 text-right font-mono text-muted-foreground"
          >
            {Array.from({ length: count }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        ) : null}
        <pre className="min-w-0 flex-1 overflow-x-auto px-3 py-3 font-mono">
          <code ref={ref}>{code}</code>
        </pre>
      </div>
    </div>
  );
}

/** Memoized: highlight.js parsing runs on mount/update; props are all primitives. */
export const CodeView = memo(CodeViewImpl);

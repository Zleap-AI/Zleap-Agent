'use client';

import clsx from 'clsx';
import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { CodeView } from './CodeView';

type MarkdownViewProps = {
  text: string;
  /** Smaller typography for the dispatch console. */
  compact?: boolean;
  /** Disable syntax highlighting while content is still streaming. */
  streaming?: boolean;
  className?: string;
};

/**
 * Shared markdown renderer (GFM tables, fenced code with highlight.js).
 * Used by the main chat and the workspace console.
 */
function MarkdownViewImpl({ text, compact = false, streaming = false, className }: MarkdownViewProps) {
  const bodyClass = compact
    ? 'markdown-body w-full min-w-0 max-w-full wrap-break-word text-xs leading-6 text-foreground'
    : 'markdown-body w-full min-w-0 max-w-full wrap-break-word text-sm leading-7 text-foreground';

  return (
    <div className={clsx(bodyClass, streaming && 'md-streaming', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => <p className={compact ? 'my-1.5 first:mt-0 last:mb-0' : 'my-2 first:mt-0 last:mb-0'}>{children}</p>,
          h1: ({ children }) => (
            <h1 className={compact ? 'mb-1.5 mt-3 text-base font-semibold first:mt-0' : 'mb-2 mt-4 text-xl font-semibold first:mt-0'}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className={compact ? 'mb-1.5 mt-3 text-sm font-semibold first:mt-0' : 'mb-2 mt-4 text-lg font-semibold first:mt-0'}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className={compact ? 'mb-1 mt-2 text-sm font-semibold first:mt-0' : 'mb-1.5 mt-3 text-base font-semibold first:mt-0'}>
              {children}
            </h3>
          ),
          ul: ({ children }) => <ul className={compact ? 'my-1.5 list-disc space-y-0.5 pl-4' : 'my-2 list-disc space-y-1 pl-5'}>{children}</ul>,
          ol: ({ children }) => <ol className={compact ? 'my-1.5 list-decimal space-y-0.5 pl-4' : 'my-2 list-decimal space-y-1 pl-5'}>{children}</ol>,
          li: ({ children }) => <li className={compact ? 'leading-6' : 'leading-7'}>{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className={compact ? 'my-1.5 border-l-2 border-border pl-2.5 text-muted-foreground' : 'my-2 border-l-2 border-border pl-3 text-muted-foreground'}>
              {children}
            </blockquote>
          ),
          hr: () => <hr className={compact ? 'my-3 border-border' : 'my-4 border-border'} />,
          code: ({ className: codeClass, children }) => {
            const cls = codeClass ?? '';
            const code = String(children).replace(/\n$/, '');
            if (cls.includes('language-') || code.includes('\n')) {
              const lang = /language-(\w+)/.exec(cls)?.[1];
              return <CodeView className={compact ? 'my-1.5' : 'my-2'} code={code} lang={lang} highlight={!streaming} />;
            }
            return (
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className={compact ? 'my-1.5 w-full min-w-0 max-w-full overflow-x-auto' : 'my-2 w-full min-w-0 max-w-full overflow-x-auto'}>
              <table className={compact ? 'w-full min-w-max border-collapse text-xs' : 'w-full min-w-max border-collapse text-sm'}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className={compact ? 'border border-border bg-muted px-2 py-1 text-left font-medium' : 'border border-border bg-muted px-3 py-1.5 text-left font-medium'}>
              {children}
            </th>
          ),
          td: ({ children }) => <td className={compact ? 'border border-border px-2 py-1' : 'border border-border px-3 py-1.5'}>{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized: markdown + highlight parsing is expensive; props are all primitives. */
export const MarkdownView = memo(MarkdownViewImpl);

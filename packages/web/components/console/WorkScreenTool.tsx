'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { isDiffResult } from '../../lib/diff';
import { summarizeToolPayload } from '../../lib/toolPayload';
import type { ToolCallView } from '../../lib/types';
import { langFromPath } from '../CodeView';
import { DiffBlock } from '../DiffBlock';
import { ConsolePayloadView } from './ConsolePayloadView';

/** Tools whose result is file contents, rendered as syntax-highlighted code. */
const FILE_READ_TOOLS = /^(read|cat_file|open_file|view_file|get_file)$/;

/** Pull the file path out of a tool's arg string, e.g. `read(path='a/b.ts')`. */
function filePathFromArgs(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { path?: unknown; file?: unknown };
    const path = typeof parsed.path === 'string' ? parsed.path : parsed.file;
    if (typeof path === 'string') {
      return path;
    }
  } catch {
    /* fall through to legacy string formats */
  }
  return (/path\s*=\s*['"]([^'"]+)['"]/.exec(args) ?? /\(\s*['"]([^'"]+)['"]/.exec(args))?.[1];
}

function StatusIcon({ status }: { status: ToolCallView['status'] }) {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (status === 'error') {
    return <X className="h-3.5 w-3.5 text-destructive" />;
  }
  return <Check className="h-3.5 w-3.5 text-success" />;
}

/**
 * A single tool on the console "screen". Running tools expand while they are
 * active; completed tools collapse to a one-line header (click to expand).
 */
export function WorkScreenTool({
  tool,
  defaultOpen = false,
  onOpenChange,
}: {
  tool: ToolCallView;
  defaultOpen?: boolean;
  onOpenChange?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
    if (defaultOpen) {
      onOpenChange?.();
    }
  }, [defaultOpen, onOpenChange]);

  const showArgs = Boolean(tool.args) && tool.args !== '()';
  const argsSummary = showArgs ? summarizeToolPayload(tool.args) : '';
  const isExitWorkspace = tool.name === 'enterWorkspace' || tool.name === 'exitWorkspace';

  const diff = Boolean(tool.result) && isDiffResult(tool.result);
  const isFile = !diff && Boolean(tool.result) && FILE_READ_TOOLS.test(tool.name);
  const fileLang = langFromPath(filePathFromArgs(tool.args));

  const hasBody =
    diff ||
    showArgs ||
    Boolean(tool.result);
  const prominent = open || tool.status === 'running';

  return (
    <div
      className={clsx(
        'animate-msg-in overflow-hidden rounded-md border bg-card transition-colors',
        prominent ? 'border-border shadow-xs' : 'border-border shadow-none hover:border-border',
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (!hasBody) return;
          setOpen((v) => !v);
          onOpenChange?.();
        }}
        className={clsx(
          'flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
          prominent ? 'bg-card' : 'bg-card/40',
        )}
        aria-expanded={open}
      >
        <StatusIcon status={tool.status} />
        <span className="shrink-0 font-mono text-xs font-medium text-foreground">{tool.name}</span>
        {argsSummary ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={tool.args}>
            {argsSummary}
          </span>
        ) : null}
        {tool.status === 'running' ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">running…</span>
        ) : hasBody ? (
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
          />
        ) : null}
      </button>

      {open && diff ? (
        <div className="px-3 pb-3">
          <DiffBlock result={tool.result} />
        </div>
      ) : open && hasBody ? (
        <div className="space-y-3 border-t border-border px-3 py-2">
          {showArgs ? <ConsolePayloadView value={tool.args} label={t('console.args', { defaultValue: '参数' })} /> : null}
          {tool.result ? (
            <ConsolePayloadView
              value={tool.result}
              label={t('console.result', { defaultValue: '结果' })}
              codeLang={isFile ? fileLang : undefined}
              artifactSources={isExitWorkspace && showArgs ? [tool.args] : undefined}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

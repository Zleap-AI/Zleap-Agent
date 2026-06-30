'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { extractArtifactRefs, resolveConsolePayload, truncateLines } from '../../lib/toolPayload';
import { refToLocalPath } from '../../lib/workspaceArtifacts';
import { CodeView } from '../CodeView';
import { MarkdownView } from '../MarkdownView';

const MAX_JSON_LINES = 200;
const MAX_TEXT_LINES = 80;

type WorkspaceArtifactRef = {
  kind?: string;
  ref?: string;
  description?: string;
};

type ConsolePayloadViewProps = {
  value: string;
  label?: string;
  codeLang?: string;
  /** Extra payloads to scan for exitWorkspace-style artifact refs (e.g. tool args). */
  artifactSources?: string[];
};

export function ConsolePayloadView({ value, label, codeLang, artifactSources = [] }: ConsolePayloadViewProps) {
  const { t } = useTranslation();
  const resolved = useMemo(() => resolveConsolePayload(value), [value]);
  const artifactRefs = useMemo(() => {
    const seen = new Set<string>();
    const refs: WorkspaceArtifactRef[] = [];
    for (const source of [value, ...artifactSources]) {
      for (const item of extractArtifactRefs(source)) {
        const key = `${item.ref ?? ''}|${item.description ?? ''}|${item.kind ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(item);
      }
    }
    return refs;
  }, [artifactSources, value]);
  const [showRaw, setShowRaw] = useState(false);

  if (!value.trim()) return null;

  const maxLines = resolved.kind === 'markdown' ? MAX_TEXT_LINES : MAX_JSON_LINES;
  const truncated = truncateLines(resolved.body, maxLines);

  return (
    <div className="space-y-2">
      {label ? <div className="px-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div> : null}
      {artifactRefs.length ? (
        <div className="space-y-1.5">
          {artifactRefs.map((item, index) => (
            <ArtifactRefCard key={`${item.ref ?? item.description ?? index}`} item={item} />
          ))}
        </div>
      ) : null}
      {resolved.incomplete ? (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-warning">
          {t('console.payloadTruncated', { defaultValue: '数据不完整（可能是旧会话截断记录）。请开新对话重跑任务以查看完整内容。' })}
        </div>
      ) : null}
      <div className={clsx('soft-scroll overflow-auto', resolved.kind === 'markdown' ? 'max-h-128' : 'max-h-96')}>
        <PayloadBody kind={resolved.kind} body={truncated.text} codeLang={codeLang} json={truncated.text} />
      </div>
      {truncated.overflow > 0 ? <div className="px-0.5 text-xs text-muted-foreground">… +{truncated.overflow} more lines</div> : null}
      {resolved.rawJson && resolved.kind !== 'json' ? (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setShowRaw((open) => !open)}
            className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronDown className={clsx('size-3 transition-transform', showRaw ? '' : '-rotate-90')} />
            {showRaw ? t('console.hideRawJson', { defaultValue: '隐藏原始 JSON' }) : t('console.showRawJson', { defaultValue: '查看原始 JSON' })}
          </button>
          {showRaw ? (
            <div className="mt-1.5 max-h-96 soft-scroll overflow-auto">
              <CodeView code={truncateLines(resolved.rawJson, MAX_JSON_LINES).text} lang="json" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactRefCard({ item }: { item: WorkspaceArtifactRef }) {
  const { t } = useTranslation();
  const path = refToLocalPath(item.ref);
  const href = item.ref && /^https?:\/\//i.test(item.ref) ? item.ref : path ? `/api/artifacts/local?path=${encodeURIComponent(path)}&raw=1` : undefined;
  const title = item.description?.trim() || (path ? path.split(/[\\/]/).pop() : item.ref) || 'artifact';
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{title}</div>
        {item.kind ? <div className="mt-0.5 text-xs text-muted-foreground">{item.kind}</div> : null}
        {item.ref ? (
          <div className="mt-1 break-all font-mono text-2xs text-muted-foreground" title={item.ref}>
            {path ?? item.ref}
          </div>
        ) : null}
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground hover:text-primary"
          title={t('console.openArtifact', { defaultValue: '打开产物' })}
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function PayloadBody({
  kind,
  body,
  codeLang,
  json,
}: {
  kind: 'json' | 'markdown' | 'text';
  body: string;
  codeLang?: string;
  json: string;
}) {
  if (kind === 'markdown') {
    return <MarkdownView text={body} compact />;
  }
  if (kind === 'json') {
    return <CodeView code={json} lang="json" />;
  }
  if (codeLang) {
    return <CodeView code={body} lang={codeLang} lineNumbers />;
  }
  return (
    <div className="overflow-x-auto rounded-sm border border-border bg-muted px-3 py-2 font-mono text-xs leading-6 text-muted-foreground">
      {body.split('\n').map((line, index) => (
        <div key={index} className="whitespace-pre-wrap break-all">
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

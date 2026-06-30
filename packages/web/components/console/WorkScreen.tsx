'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, ChevronDown, Layers, Loader2, MessageSquareText } from 'lucide-react';
import { markdownPreview } from '../../lib/toolPayload';
import type { WorkPane } from '../../lib/types';
import { MarkdownView } from '../MarkdownView';
import { ArtifactList } from './ArtifactList';
import { WorkScreenTool } from './WorkScreenTool';

/** The active workspace's "screen": its prose + tool stream + artifacts. */
export function WorkScreen({ pane }: { pane: WorkPane | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);

  const toolCount = pane?.tools.length ?? 0;
  const lastResult = pane?.tools[toolCount - 1]?.result ?? '';
  const lastStatus = pane?.tools[toolCount - 1]?.status ?? '';

  const followBottom = useCallback(() => {
    if (!stickRef.current) {
      return;
    }
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }, []);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const top = container.scrollTop;
    const distance = container.scrollHeight - top - container.clientHeight;
    if (top < lastTopRef.current - 2) {
      stickRef.current = false;
    } else if (distance < 120) {
      stickRef.current = true;
    }
    lastTopRef.current = top;
  };

  const messageCount = pane?.messages?.length ?? 0;
  const transitionCount = pane?.transitions?.length ?? 0;
  useEffect(() => {
    if (!stickRef.current) {
      return;
    }
    followBottom();
  }, [followBottom, toolCount, messageCount, transitionCount, lastResult, lastStatus, pane?.artifacts.length]);

  if (!pane) {
    return <EmptyScreen title="Workspace idle" text="No active workspace yet." />;
  }
  if (!pane.tools.length && !messageCount && !transitionCount && !pane.artifacts.length) {
    return (
      <EmptyScreen
        title={pane.status === 'running' ? `${pane.label} is starting` : `${pane.label} finished`}
        text={
          pane.status === 'running'
            ? 'Waiting for the first event from this workspace.'
            : 'Answered in the session. No workspace tools were needed.'
        }
        running={pane.status === 'running'}
      />
    );
  }
  const tools = pane.tools;
  const messages = pane.messages ?? [];
  // Interleave the work space's prose with its tools by `after` (= tools that
  // preceded the message), so the console reads as the sub-space's real
  // transcript: narration → tool → … → final result carried back to main.
  return (
    <div ref={scrollRef} onScroll={onScroll} className="soft-scroll flex-1 overflow-y-auto bg-card px-3 py-3">
      <div className="flex flex-col gap-1.5">
        {pane.statusLine ? <WorkScreenStatus text={pane.statusLine} running={pane.status === 'running'} /> : null}
        <WorkspaceTransitions pane={pane} />
        {Array.from({ length: tools.length + 1 }).map((_, slot) => (
          <Fragment key={slot}>
            {messages
              .filter((message) => message.after === slot)
              .map((message, index) => (
                <WorkScreenMessage key={`m-${slot}-${index}`} text={message.text} />
              ))}
            {slot < tools.length ? (
              <WorkScreenTool key={`t-${slot}`} tool={tools[slot]!} defaultOpen={tools[slot]!.status === 'running'} onOpenChange={followBottom} />
            ) : null}
          </Fragment>
        ))}
      </div>
      <ArtifactList artifacts={pane.artifacts} />
      <div ref={bottomRef} />
    </div>
  );
}

function WorkspaceTransitions({ pane }: { pane: WorkPane }) {
  const transitions = pane.transitions ?? [];
  if (!transitions.length) {
    return null;
  }
  return (
    <div className="animate-msg-in overflow-hidden rounded-md border border-border bg-card/70">
      {transitions.map((transition, index) => (
        <div
          key={`${transition.fromSpace}:${transition.toSpace}:${transition.status}:${transition.createdAt}:${index}`}
          className="flex items-start gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0"
        >
          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 leading-5 text-foreground">
              <span className="font-medium">{transition.fromSpace}</span>
              <span className="text-muted-foreground">→</span>
              <span className="font-medium">{transition.toSpace}</span>
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs leading-4 text-muted-foreground">{transition.status}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{transition.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkScreenStatus({ text, running }: { text: string; running: boolean }) {
  return (
    <div className="animate-msg-in flex items-center gap-2 rounded-md border border-border bg-card/70 px-3 py-2 text-xs text-muted-foreground">
      {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

/** A prose message a work space emitted, shown in the console. Default collapsed
 *  (truncated preview); click to expand into rendered markdown. */
function WorkScreenMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = markdownPreview(text, 160);
  const expandable = text.length > 140 || text.includes('\n') || looksExpandable(text);
  return (
    <div className="animate-msg-in overflow-hidden rounded-md border border-border bg-card/60">
      <button
        type="button"
        onClick={() => expandable && setOpen((value) => !value)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        aria-expanded={open}
      >
        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {!open ? (
          <div className={clsx('min-w-0 flex-1 text-xs leading-6 text-muted-foreground', 'line-clamp-2')}>
            {preview || text}
          </div>
        ) : (
          <div className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground">{preview || text}</div>
        )}
        {expandable ? (
          <ChevronDown
            className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open ? '' : '-rotate-90')}
          />
        ) : null}
      </button>
      {open ? (
        <div className="max-h-[32rem] soft-scroll overflow-auto border-t border-border px-3 py-2">
          <MarkdownView text={text} compact />
        </div>
      ) : null}
    </div>
  );
}

function looksExpandable(text: string): boolean {
  return /^#{1,6}\s|^\|.+\||```/m.test(text);
}

function EmptyScreen({ title, text, running = false }: { title: string; text: string; running?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-card px-6 text-center">
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded border border-border bg-muted">
        {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Layers className="h-4 w-4 text-muted-foreground" />}
      </span>
      <div className="mb-1 text-sm font-medium text-foreground">{title}</div>
      <p className="max-w-xs text-xs leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy, RotateCcw, Trash2 } from 'lucide-react';
import type { DisplayMessage, RunStatus, ToolCallView, WorkPane } from '../lib/types';
import type { SpaceItem } from '../lib/spaces';
import type { WorkspaceFileTarget } from '../lib/workspaceFiles';
import { ArtifactAttachmentList } from './ArtifactAttachmentList';
import { AssistantMessage } from './AssistantMessage';
import { SpaceChip } from './SpaceChip';
import { UserMessage } from './UserMessage';
import { copyTextToClipboard } from '../lib/clipboard';
import { cn } from '@/lib/utils';

type MessageProps = {
  message: DisplayMessage;
  workspaces?: WorkPane[];
  spaces?: SpaceItem[];
  activeTool?: ToolCallView | null;
  status?: RunStatus;
  onOpenSpace?: (spaceId: string) => void;
  onOpenWorkspaceFile?: (target: WorkspaceFileTarget) => void;
  onDeleteMessage?: (id: number) => void;
  onResendMessage?: (id: number) => void;
  isLatest?: boolean;
};

/** Routes a committed message to its renderer. Tool calls are NOT shown here —
 *  the 调度台 (workspace) owns the full tool history; the conversation shows a
 *  progressive summary chip instead (count + currently-running tool). */
export function Message({
  message,
  workspaces,
  spaces = [],
  activeTool,
  status,
  onOpenSpace,
  onOpenWorkspaceFile,
  onDeleteMessage,
  onResendMessage,
  isLatest = false,
}: MessageProps) {
  // Tool calls are intentionally NOT shown in the conversation — the 调度台
  // (workspace) already renders the full tool history. Keep the data for the
  // console; just skip rendering a chip here.
  if (message.role === 'tool') {
    return null;
  }
  if (message.role === 'space' && message.space) {
    const pane = workspaces?.find((w) => w.id === message.space!.id);
    // This card's OWN result (frozen at dispatch return) takes priority over the
    // live pane, which a later dispatch to the same space resets/reuses.
    const cardEnvelope = message.envelope;
    const isLive = !cardEnvelope && pane?.status === 'running';
    const hasOwnArtifacts = Object.prototype.hasOwnProperty.call(message, 'artifacts');
    const artifacts = hasOwnArtifacts ? (message.artifacts ?? []) : cardEnvelope ? (pane?.artifacts ?? []) : [];
    return (
      <div>
        <SpaceChip
          space={message.space}
          pane={pane}
          envelope={cardEnvelope}
          spaces={spaces}
          activeTool={isLive ? activeTool ?? null : null}
          running={status === 'running' && isLive}
          onOpen={onOpenSpace}
        />
        <ArtifactAttachmentList artifacts={artifacts} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      </div>
    );
  }
  if (message.role === 'user') {
    const text = message.text ?? '';
    return (
      <MessageShell
        text={text}
        ts={message.ts}
        align="end"
        visible={isLatest}
        disabled={status === 'running'}
        onDelete={onDeleteMessage ? () => onDeleteMessage(message.id) : undefined}
        onResend={onResendMessage ? () => onResendMessage(message.id) : undefined}
      >
        <UserMessage text={text} attachments={message.attachments ?? []} />
      </MessageShell>
    );
  }
  if (message.role === 'system') {
    return (
      <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] leading-6 text-rose-500">
        {message.text}
      </div>
    );
  }
  const text = message.text ?? '';
  return (
    <MessageShell
      text={text}
      ts={message.ts}
      align="start"
      visible={isLatest}
      disabled={status === 'running'}
      onDelete={onDeleteMessage ? () => onDeleteMessage(message.id) : undefined}
    >
      <AssistantMessage text={text} />
      <ArtifactAttachmentList artifacts={message.artifacts ?? []} onOpenWorkspaceFile={onOpenWorkspaceFile} />
    </MessageShell>
  );
}

function MessageShell({
  align,
  children,
  text,
  ts,
  visible,
  disabled,
  onDelete,
  onResend,
}: {
  align: 'start' | 'end';
  children: ReactNode;
  text: string;
  ts?: number;
  visible: boolean;
  disabled?: boolean;
  onDelete?: () => void;
  onResend?: () => void;
}) {
  return (
    <div className="group/message">
      {children}
      <MessageActions align={align} text={text} ts={ts} visible={visible} disabled={disabled} onDelete={onDelete} onResend={onResend} />
    </div>
  );
}

function MessageActions({
  align,
  text,
  ts,
  visible,
  disabled,
  onDelete,
  onResend,
}: {
  align: 'start' | 'end';
  text: string;
  ts?: number;
  visible: boolean;
  disabled?: boolean;
  onDelete?: () => void;
  onResend?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const trimmed = text.trim();
  const time = formatMessageTime(ts);
  if (!trimmed && !time && !onDelete && !onResend) {
    return null;
  }
  return (
    <div
      onMouseLeave={() => setCopied(false)}
      className={cn(
        'mt-2 flex items-center gap-2 text-[11px] text-muted-foreground transition-opacity',
        align === 'end' ? 'justify-end pr-1' : 'justify-start pl-1',
        visible ? 'opacity-100' : 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
      )}
    >
      {onResend ? (
        <MessageActionButton disabled={disabled} title="重新发送" ariaLabel="重新发送消息" onClick={onResend}>
          <RotateCcw className="h-3.5 w-3.5" />
        </MessageActionButton>
      ) : null}
      {onDelete ? (
        <MessageActionButton disabled={disabled} title="删除" ariaLabel="删除消息" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </MessageActionButton>
      ) : null}
      {trimmed ? (
        <button
          type="button"
          onClick={() => {
            void copyTextToClipboard(trimmed).then((ok) => setCopied(ok));
          }}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded transition hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            copied ? 'bg-muted text-ink' : 'text-muted-foreground',
          )}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制消息'}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      {time ? <time className="tabular-nums">{time}</time> : null}
    </div>
  );
}

function MessageActionButton({
  children,
  disabled,
  title,
  ariaLabel,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-40"
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function formatMessageTime(ts?: number): string {
  if (!ts) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
}

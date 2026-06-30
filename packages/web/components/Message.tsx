'use client';

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
 *  the workspace console owns the full tool history; the conversation shows a
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
  // Tool calls are intentionally NOT shown in the conversation — the workspace
  // console already renders the full tool history. Keep the data for the
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
      <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-6 text-destructive">
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
  const { t } = useTranslation();
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
        'mt-2 flex items-center gap-2 text-2xs text-muted-foreground transition-opacity',
        align === 'end' ? 'justify-end pr-1' : 'justify-start pl-1',
        visible ? 'opacity-100' : 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
      )}
    >
      {onResend ? (
        <MessageActionButton disabled={disabled} title={t('common.resend')} ariaLabel={t('common.resend')} onClick={onResend}>
          <RotateCcw className="h-3.5 w-3.5" />
        </MessageActionButton>
      ) : null}
      {onDelete ? (
        <MessageActionButton disabled={disabled} title={t('common.delete')} ariaLabel={t('common.delete')} onClick={onDelete}>
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
            'inline-flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            copied ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title={copied ? t('common.copied') : t('common.copy')}
          aria-label={copied ? t('common.copied') : t('common.copy')}
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
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-40"
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

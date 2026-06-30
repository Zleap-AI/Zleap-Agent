'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ArtifactView, DisplayMessage, RunStatus, ToolCallView, WorkPane } from '../lib/types';
import type { SpaceItem } from '../lib/spaces';
import type { WorkspaceFileTarget } from '../lib/workspaceFiles';
import { stripPlanReplyMarkers } from '../lib/planOptions';
import { AssistantMessage } from './AssistantMessage';
import { Message } from './Message';
import { ThinkingDots } from './ThinkingDots';

type ConversationProps = {
  conversationId: string;
  messages: DisplayMessage[];
  live: string;
  activeTool: ToolCallView | null;
  activeSpaceId: string | null;
  workspaces: WorkPane[];
  spaces: SpaceItem[];
  status: RunStatus;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onOpenSpace: (spaceId: string) => void;
  onLoadOlderMessages?: () => void;
  onOpenWorkspaceFile?: (target: WorkspaceFileTarget) => void;
  onDeleteMessage?: (id: number) => void;
  onResendMessage?: (id: number) => void;
};

export function Conversation({
  conversationId,
  messages,
  live,
  activeTool,
  workspaces,
  spaces,
  status,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  onOpenSpace,
  onLoadOlderMessages,
  onOpenWorkspaceFile,
  onDeleteMessage,
  onResendMessage,
}: ConversationProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const workspaceRunning = workspaces.some((pane) => pane.status === 'running');
  // Whether to keep pinning to the bottom. Driven by the user's *intent* (their
  // last scroll position), NOT re-measured after content grows — otherwise a
  // single tall streamed chunk pushes the distance past the threshold and
  // auto-follow gives up halfway. Scrolling up releases the pin; scrolling back
  // down re-arms it.
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const snapToBottomRef = useRef(true);

  // Release the pin ONLY on a real upward scroll (scrollTop actually drops);
  // re-arm it once the user returns near the bottom. Measuring distance-from-
  // bottom alone is unreliable while streaming: a token that grows the content
  // between our scroll and this handler firing makes distance look large and
  // would wrongly unpin (which then never recovers).
  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    if (container.scrollTop < 48 && hasOlderMessages && !loadingOlderMessages && onLoadOlderMessages) {
      stickRef.current = false;
      restoreScrollRef.current = { height: container.scrollHeight, top: container.scrollTop };
      onLoadOlderMessages();
    }
    const top = container.scrollTop;
    const distance = container.scrollHeight - top - container.clientHeight;
    if (top < lastTopRef.current - 2) {
      stickRef.current = false;
    } else if (distance < 80) {
      stickRef.current = true;
    }
    lastTopRef.current = top;
  };

  useLayoutEffect(() => {
    stickRef.current = true;
    lastTopRef.current = 0;
    restoreScrollRef.current = null;
    snapToBottomRef.current = true;
  }, [conversationId]);

  useLayoutEffect(() => {
    if (!stickRef.current) {
      return;
    }
    const snap = snapToBottomRef.current;
    snapToBottomRef.current = false;
    // Follow instantly while streaming (smooth animation can't keep up with
    // per-token height changes). Also snap on conversation entry so loading an
    // existing thread opens at the latest message without a visible scroll tour.
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: snap || live ? 'auto' : 'smooth' });
  }, [messages, live, activeTool]);

  // Sending a new message is an explicit "take me to the latest" intent: always
  // re-arm the pin and snap to bottom, even if the user had scrolled up to read.
  const lastUserMessageId = messages.filter((message) => message.role === 'user').at(-1)?.id;
  useEffect(() => {
    if (!lastUserMessageId) {
      return;
    }
    stickRef.current = true;
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [lastUserMessageId]);

  const liveText = live ? stripPlanReplyMarkers(live) : '';
  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== 'tool'), [messages]);
  const displayMessages = useMemo(() => placeWorkspaceArtifactsAfterAssistant(visibleMessages), [visibleMessages]);
  useEffect(() => {
    const restore = restoreScrollRef.current;
    const container = scrollRef.current;
    if (!restore || !container) return;
    container.scrollTop = container.scrollHeight - restore.height + restore.top;
    lastTopRef.current = container.scrollTop;
    restoreScrollRef.current = null;
  }, [displayMessages.length]);
  const latestTextMessageId = [...displayMessages].reverse().find((message) => message.role === 'user' || message.role === 'assistant')?.id ?? null;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        {hasOlderMessages ? (
          <button
            type="button"
            onClick={() => {
              const container = scrollRef.current;
              if (container) restoreScrollRef.current = { height: container.scrollHeight, top: container.scrollTop };
              stickRef.current = false;
              onLoadOlderMessages?.();
            }}
            disabled={loadingOlderMessages}
            className="mx-auto inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-xs transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70"
          >
            {loadingOlderMessages ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                {t('common.loading', { defaultValue: '加载中…' })}
              </>
            ) : (
              t('chat.loadEarlier', { defaultValue: '加载更早消息' })
            )}
          </button>
        ) : null}
        {displayMessages
          .map((message) => {
            const displayMessage = message.role === 'assistant'
              ? { ...message, text: stripPlanReplyMarkers(message.text ?? '') }
              : message;
            return (
              <div key={message.id} className="animate-msg-in">
                <Message
                  message={displayMessage}
                  workspaces={workspaces}
                  spaces={spaces}
                  activeTool={activeTool}
                  status={status}
                  onOpenSpace={onOpenSpace}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  onDeleteMessage={onDeleteMessage}
                  onResendMessage={onResendMessage}
                  isLatest={message.id === latestTextMessageId}
                />
              </div>
            );
          })}
        {liveText ? <AssistantMessage text={liveText} streaming /> : null}
        {status === 'running' && !live && !workspaceRunning ? <ThinkingDots /> : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function placeWorkspaceArtifactsAfterAssistant(messages: DisplayMessage[]): DisplayMessage[] {
  const arranged = messages.map((message) => ({ ...message }));

  for (let index = 0; index < arranged.length; index += 1) {
    const message = arranged[index];
    if (message?.role !== 'space' || !message.artifacts?.length) {
      continue;
    }
    const targetIndex = nextAssistantIndex(arranged, index + 1);
    if (targetIndex < 0) {
      continue;
    }
    const target = arranged[targetIndex];
    if (!target) {
      continue;
    }
    arranged[index] = { ...message, artifacts: undefined };
    arranged[targetIndex] = {
      ...target,
      artifacts: mergeArtifacts(target.artifacts ?? [], message.artifacts),
    };
  }

  return arranged;
}

function nextAssistantIndex(messages: DisplayMessage[], start: number): number {
  for (let index = start; index < messages.length; index += 1) {
    const role = messages[index]?.role;
    if (role === 'assistant') {
      return index;
    }
    if (role === 'user' || role === 'space') {
      return -1;
    }
  }
  return -1;
}

function mergeArtifacts(current: ArtifactView[], incoming: ArtifactView[]): ArtifactView[] {
  const seen = new Set<string>();
  const merged: ArtifactView[] = [];
  for (const artifact of [...current, ...incoming]) {
    const key = artifact.path ?? artifact.href ?? `${artifact.spaceId}:${artifact.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

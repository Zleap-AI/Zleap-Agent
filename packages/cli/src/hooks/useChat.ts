import { useCallback, useReducer, useRef, useState, type MutableRefObject } from 'react';
import type { ToolApprovalPolicy } from '@zleap/core';
import type { Message } from '@zleap/ai';
import type { ChatEngine, ContextSnapshot, ToolConfirm } from '@zleap/agent/engine';
import { bypassesToolApproval, type PermissionMode } from '@zleap/agent';
import { systemPromptWithRunControls } from '../runModePrompt.js';
import { needsExecuteConfirmationReply } from '../planMarkers.js';
import type { RunMode } from '@zleap/agent';
import type {
  ContextUsage,
  DisplayMessage,
  RunStatus,
  SpaceView,
  ToolApprovalRequest,
  ToolCallView,
} from '../state/types.js';

export type Chat = {
  messages: DisplayMessage[];
  status: RunStatus;
  live: string;
  spaceLive: string;
  activeTool: ToolCallView | null;
  activeSpace: SpaceView | null;
  /** Latest sub-space lifecycle hint (live only, not committed to history). */
  activeSpaceStatus: string | null;
  pendingApproval: ToolApprovalRequest | null;
  lastRunError: boolean;
  contextUsage: ContextUsage | null;
  send: (text: string) => Promise<void>;
  abort: () => void;
  notify: (text: string) => void;
  clear: () => void;
  history: () => Message[];
  load: (
    messages: DisplayMessage[],
    contextMessages?: RestoredContextMessage[],
    runtimeContext?: RestoredRuntimeContext,
  ) => void;
  respondApproval: (approved: boolean) => void;
};

export type RestoredContextMessage = { role: 'system' | 'user' | 'assistant'; text: string };

export type RestoredRuntimeContext = {
  workspaceRoot?: string;
};

export type ProviderHistoryBase = {
  messages: Message[];
  baselineUserAssistantCount: number;
};

type Transcript = { messages: DisplayMessage[]; live: string; spaceLive: string };

type TranscriptAction =
  | { type: 'reset' }
  | { type: 'load'; messages: DisplayMessage[] }
  | { type: 'live'; text: string }
  | { type: 'spaceLive'; text: string }
  | { type: 'flush'; message: DisplayMessage }
  | { type: 'flushSpace'; message: DisplayMessage }
  | { type: 'append'; message: DisplayMessage };

function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case 'reset':
      return state.messages.length === 0 && state.live === '' && state.spaceLive === ''
        ? state
        : { messages: [], live: '', spaceLive: '' };
    case 'load':
      return { messages: action.messages, live: '', spaceLive: '' };
    case 'live':
      return state.live === action.text ? state : { ...state, live: action.text };
    case 'spaceLive':
      return state.spaceLive === action.text ? state : { ...state, spaceLive: action.text };
    case 'flush':
      return { messages: [...state.messages, action.message], live: '', spaceLive: state.spaceLive };
    case 'flushSpace':
      return { messages: [...state.messages, action.message], live: state.live, spaceLive: '' };
    case 'append':
      return { messages: [...state.messages, action.message], live: state.live, spaceLive: state.spaceLive };
    default:
      return state;
  }
}

function displayMessageToProviderMessage(message: DisplayMessage): Message | undefined {
  if (message.role === 'user') {
    return { role: 'user', content: message.text ?? '' };
  }
  if (message.role === 'assistant' || message.role === 'space_message') {
    return { role: 'assistant', content: [{ type: 'text', text: message.text ?? '' }] };
  }
  return undefined;
}

function restoredContextMessageToProviderMessage(message: RestoredContextMessage): Message | undefined {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: [{ type: 'text', text: message.text }] };
  }
  if (message.role === 'system') {
    return undefined;
  }
  return { role: 'user', content: message.text };
}

function committedProviderMessages(messages: DisplayMessage[]): Message[] {
  return messages.flatMap((message) => {
    const providerMessage = displayMessageToProviderMessage(message);
    return providerMessage ? [providerMessage] : [];
  });
}

export function restoredContextMessagesToProviderHistory(messages: RestoredContextMessage[]): Message[] {
  return messages.flatMap((message) => {
    const providerMessage = restoredContextMessageToProviderMessage(message);
    return providerMessage ? [providerMessage] : [];
  });
}

export function buildProviderHistory(messages: DisplayMessage[], base?: ProviderHistoryBase | null): Message[] {
  const committed = committedProviderMessages(messages);
  if (!base) {
    return committed;
  }
  return [...base.messages, ...committed.slice(base.baselineUserAssistantCount)];
}

export type SessionRuntimeOptions = {
  runMode: RunMode;
  permissionMode: PermissionMode;
};

export type ReplyRuntimeOptions = {
  confirm: ToolConfirm;
  workspaceRoot?: string;
  disableAllTools?: boolean;
  approvalPolicy?: ToolApprovalPolicy;
};

export function buildReplyRuntimeOptions(
  confirm: ToolConfirm,
  runtimeContext?: RestoredRuntimeContext | null,
  session?: SessionRuntimeOptions | null,
): ReplyRuntimeOptions {
  const workspaceRoot = normalizedRuntimeWorkspaceRoot(runtimeContext?.workspaceRoot);
  const approvalPolicy: ToolApprovalPolicy | undefined = session
    ? { mode: bypassesToolApproval(session.permissionMode) ? 'full_access' : 'request_approval' }
    : undefined;
  const disableAllTools = session?.runMode === 'plan';
  return {
    confirm,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(disableAllTools ? { disableAllTools: true } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
  };
}

function maybeNotifyPlanExecute(
  text: string,
  runMode: RunMode | undefined,
  notify: (text: string) => void,
): void {
  if (runMode !== 'plan') {
    return;
  }
  if (needsExecuteConfirmationReply(text)) {
    notify('计划已就绪 · 输入「执行」或 /execute 切换到普通模式并开始执行 · Shift+Tab 切换模式');
  }
}

function normalizedRuntimeWorkspaceRoot(workspaceRoot: string | undefined): string | undefined {
  const value = workspaceRoot?.trim();
  return value || undefined;
}

function snapshotToUsage(snapshot: ContextSnapshot): ContextUsage {
  const { compaction, window } = snapshot;
  const refreshThreshold = window.contextWindow && window.contextWindow > 0
    ? compaction.triggerTokens / window.contextWindow
    : 0;
  return {
    extractedCount: compaction.extractedCount,
    itemHistoryActive: compaction.itemHistoryActive,
    triggerMessages: compaction.foldedMessages,
    triggerTokens: compaction.triggerTokens,
    refreshThreshold,
    windowRatio: window.ratio,
    usedTokens: window.usedTokens,
    contextWindow: window.contextWindow,
    snapshotMessageCount: compaction.foldedMessages,
  };
}

export function useChat(
  engine: ChatEngine,
  systemPrompt: string,
  sessionRuntimeRef?: MutableRefObject<SessionRuntimeOptions>,
): Chat {
  const [{ messages, live, spaceLive }, dispatchTranscript] = useReducer(transcriptReducer, {
    messages: [],
    live: '',
    spaceLive: '',
  });
  const [status, setStatus] = useState<RunStatus>('idle');
  const [activeTool, setActiveTool] = useState<ToolCallView | null>(null);
  const [activeSpace, setActiveSpace] = useState<SpaceView | null>(null);
  const [activeSpaceStatus, setActiveSpaceStatus] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [lastRunError, setLastRunError] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

  const messagesRef = useRef<DisplayMessage[]>([]);
  const historyBaseRef = useRef<ProviderHistoryBase | null>(null);
  const runtimeContextRef = useRef<RestoredRuntimeContext | null>(null);
  const idRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const approvalRef = useRef<((approved: boolean) => void) | null>(null);
  const spaceDepthRef = useRef(0);
  const abortedRef = useRef(false);

  const setLive = useCallback((text: string) => dispatchTranscript({ type: 'live', text }), []);
  const setSpaceLiveText = useCallback((text: string) => dispatchTranscript({ type: 'spaceLive', text }), []);

  const livePendingRef = useRef('');
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIVE_THROTTLE_MS = 48;

  const flushLiveNow = useCallback(() => {
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    dispatchTranscript({ type: 'live', text: livePendingRef.current });
  }, []);

  const scheduleLive = useCallback(
    (text: string) => {
      livePendingRef.current = text;
      if (liveTimerRef.current) {
        return;
      }
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        dispatchTranscript({ type: 'live', text: livePendingRef.current });
      }, LIVE_THROTTLE_MS);
    },
    [],
  );

  const clearLiveSchedule = useCallback(() => {
    livePendingRef.current = '';
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  }, []);

  const append = useCallback((message: DisplayMessage) => {
    messagesRef.current = [...messagesRef.current, message];
    dispatchTranscript({ type: 'append', message });
  }, []);

  const flushAssistant = useCallback((text: string) => {
    const message: DisplayMessage = { id: idRef.current++, role: 'assistant', text };
    messagesRef.current = [...messagesRef.current, message];
    dispatchTranscript({ type: 'flush', message });
  }, []);

  const confirm = useCallback(
    (request: ToolApprovalRequest) => {
      if (sessionRuntimeRef && bypassesToolApproval(sessionRuntimeRef.current.permissionMode)) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        setPendingApproval(request);
        approvalRef.current = resolve;
      });
    },
    [sessionRuntimeRef],
  );

  const respondApproval = useCallback((approved: boolean) => {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    setPendingApproval(null);
    resolve?.(approved);
  }, []);

  const notify = useCallback(
    (text: string) => append({ id: idRef.current++, role: 'system', text, tone: 'notify' }),
    [append],
  );

  const notifyError = useCallback(
    (text: string) => append({ id: idRef.current++, role: 'error', text, tone: 'error' }),
    [append],
  );

  const buildHistory = useCallback(
    (): Message[] => buildProviderHistory(messagesRef.current, historyBaseRef.current),
    [],
  );

  const history = useCallback((): Message[] => buildHistory(), [buildHistory]);

  const send = useCallback(
    async (text: string) => {
      if (abortRef.current) {
        return;
      }

      const history: Message[] = buildHistory();
      history.push({ role: 'user', content: text });

      append({ id: idRef.current++, role: 'user', text });
      setStatus('running');
      clearLiveSchedule();
      setLive('');
      setSpaceLiveText('');
      setActiveSpaceStatus(null);
      setLastRunError(false);
      abortedRef.current = false;
      spaceDepthRef.current = 0;

      const controller = new AbortController();
      abortRef.current = controller;
      let acc = '';
      let spaceAcc = '';
      let pendingArgs = '';

      const discardSubSpaceLive = (): void => {
        spaceAcc = '';
        setSpaceLiveText('');
      };

      const session = sessionRuntimeRef?.current;

      try {
        const effectiveSystemPrompt = session ? systemPromptWithRunControls(systemPrompt, session.runMode) : systemPrompt;
        const replyOptions = buildReplyRuntimeOptions(confirm, runtimeContextRef.current, session);
        for await (const delta of engine.reply(history, effectiveSystemPrompt, controller.signal, replyOptions)) {
          if (delta.type === 'delta') {
            acc += delta.text;
            scheduleLive(acc);
          } else if (delta.type === 'space_message') {
            spaceAcc += delta.text;
            setSpaceLiveText(spaceAcc);
          } else if (delta.type === 'space_status') {
            setActiveSpaceStatus(delta.message);
          } else if (delta.type === 'context') {
            setContextUsage(snapshotToUsage(delta.snapshot));
          } else if (delta.type === 'tool') {
            if (acc.trim()) {
              flushAssistant(acc);
              acc = '';
            }
            discardSubSpaceLive();
            const nested = spaceDepthRef.current > 0;
            if (delta.phase === 'start') {
              pendingArgs = delta.detail;
              setActiveTool({ name: delta.name, args: delta.detail, result: '', status: 'running' });
            } else {
              setActiveTool(null);
              append({
                id: idRef.current++,
                role: 'tool',
                nested,
                tool: {
                  name: delta.name,
                  args: pendingArgs,
                  result: delta.detail,
                  status: delta.isError ? 'error' : 'done',
                },
              });
              pendingArgs = '';
            }
          } else if (delta.type === 'space') {
            if (acc.trim()) {
              flushAssistant(acc);
              acc = '';
            }
            discardSubSpaceLive();
            spaceDepthRef.current += 1;
            setActiveSpace({ id: delta.id, label: delta.label });
            append({
              id: idRef.current++,
              role: 'space',
              space: { id: delta.id, label: delta.label, goal: delta.goal },
            });
          } else if (delta.type === 'space_result') {
            discardSubSpaceLive();
            setActiveSpaceStatus(null);
            spaceDepthRef.current = Math.max(0, spaceDepthRef.current - 1);
            if (spaceDepthRef.current === 0) {
              setActiveSpace(null);
            }
            const ok = delta.envelope.status === 'success';
            append({
              id: idRef.current++,
              role: 'space_result',
              nested: true,
              result: {
                id: delta.id,
                status: ok ? 'success' : 'failed',
                summary: delta.envelope.summary,
              },
            });
          } else if (delta.type === 'needs_approval') {
            if (acc) {
              flushAssistant(acc);
              acc = '';
            }
            discardSubSpaceLive();
            setActiveTool(null);
            append({ id: idRef.current++, role: 'system', text: delta.message, tone: 'notify' });
          } else if (delta.type === 'error') {
            if (acc) {
              flushAssistant(acc);
              acc = '';
            }
            discardSubSpaceLive();
            setLastRunError(true);
            notifyError(delta.message);
            break;
          } else if (delta.type === 'done') {
            break;
          }
        }
      } finally {
        discardSubSpaceLive();
        setActiveSpaceStatus(null);
        flushLiveNow();
        if (acc) {
          flushAssistant(acc);
          maybeNotifyPlanExecute(acc, session?.runMode, notify);
        } else {
          clearLiveSchedule();
          setLive('');
        }
        if (abortedRef.current) {
          notify('已中断 · 可继续输入');
        }
        approvalRef.current?.(false);
        approvalRef.current = null;
        setPendingApproval(null);
        setActiveTool(null);
        setActiveSpace(null);
        spaceDepthRef.current = 0;
        setStatus('idle');
        abortRef.current = null;
      }
    },
    [
      append,
      buildHistory,
      confirm,
      engine,
      flushAssistant,
      clearLiveSchedule,
      flushLiveNow,
      scheduleLive,
      notify,
      notifyError,
      sessionRuntimeRef,
      setLive,
      setSpaceLiveText,
      systemPrompt,
    ],
  );

  const abort = useCallback(() => {
    abortedRef.current = true;
    approvalRef.current?.(false);
    approvalRef.current = null;
    setPendingApproval(null);
    setActiveSpaceStatus(null);
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    messagesRef.current = [];
    historyBaseRef.current = null;
    runtimeContextRef.current = null;
    dispatchTranscript({ type: 'reset' });
    setLastRunError(false);
    setContextUsage(null);
    engine.resetContext();
  }, [engine]);

  const load = useCallback(
    (restored: DisplayMessage[], contextMessages?: RestoredContextMessage[], runtimeContext?: RestoredRuntimeContext) => {
      const next = restored.map((message, index) => ({ ...message, id: index + 1 }));
      const contextHistory = contextMessages?.length ? restoredContextMessagesToProviderHistory(contextMessages) : [];
      historyBaseRef.current = contextHistory.length
        ? {
            messages: contextHistory,
            baselineUserAssistantCount: committedProviderMessages(next).length,
          }
        : null;
      const workspaceRoot = normalizedRuntimeWorkspaceRoot(runtimeContext?.workspaceRoot);
      runtimeContextRef.current = workspaceRoot ? { workspaceRoot } : null;
      idRef.current = next.length + 1;
      messagesRef.current = next;
      dispatchTranscript({ type: 'load', messages: next });
      setLastRunError(false);
      engine.resetContext();
    },
    [engine],
  );

  return {
    messages,
    status,
    live,
    spaceLive,
    activeTool,
    activeSpace,
    activeSpaceStatus,
    pendingApproval,
    lastRunError,
    contextUsage,
    send,
    abort,
    notify,
    clear,
    history,
    load,
    respondApproval,
  };
}

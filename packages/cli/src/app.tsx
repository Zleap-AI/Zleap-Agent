import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import type { CustomModelConfig } from '@zleap/ai';
import { type BuiltinCommand, parseBuiltinCommand, parseConnectChannel } from './commands/builtin.js';
import { formatSlashHelp } from './commands/registry.js';
import { CONFIG_PATH, loadConfig, modelLabel, resolvePersistence, saveConfig, type CliConfig } from '@zleap/host';
import { formatDoctorSummary } from './cli/doctor.js';
import { resolveCliContext, modelSourceLabel, resolveModelConfigById, type CliContext } from './cli/context.js';
import { formatConfigSummary } from './cli/formatConfig.js';
import {
  KNOWN_CHANNELS,
  formatChannelsStatusSummary,
  isKnownChannel,
  startTuiChannelConnect,
} from './cli/channels.js';
import { formatStackStatusSummary, spawnServeDetached, stopServeFromTui } from './cli/tuiServe.js';
import type { ConnectionView } from './cli/connectFlow.js';
import { listSelectableModels } from './cli/models.js';
import { type SessionListItem } from './cli/sessions.js';
import { ChatEngine, type EngineStatus } from '@zleap/agent/engine';
import { useAmbientStatus } from './hooks/useAmbientStatus.js';
import type { ContextBarMode, ContextBarProps } from './ui/ContextBar.js';
import { useChat, type SessionRuntimeOptions } from './hooks/useChat.js';
import { useCommandPalette } from './hooks/useCommandPalette.js';
import {
  nextPermissionMode,
  permissionModeHint,
  permissionModeLabel,
  type PermissionMode,
} from '@zleap/agent';
import {
  isPlanExecuteText,
  nextRunMode,
  runModeHint,
  runModeLabel,
  type RunMode,
} from '@zleap/agent';
import { patchSessionPrefs, resolveSessionPrefs } from '@zleap/host';
import { clearLastSession, loadLastSession, saveSession } from './session.js';
import type { DisplayMessage, ModelPicker, ModelWizard, SessionPicker } from './state/types.js';
import { ConfirmCard } from './ui/ConfirmCard.js';
import { ConnectPanel } from './ui/ConnectPanel.js';
import { Logo } from './ui/Logo.js';
import { PickerList, type PickerItem } from './ui/PickerList.js';
import { resolveMascotMood, type MascotMood } from './ui/mascotMood.js';
import { Message } from './ui/Message.js';
import { Prompt } from './ui/Prompt.js';
import { Spinner } from './ui/Spinner.js';
import { buildDefaultSeedWorkspaceDetails } from '@zleap/agent/workspaces';
import { advanceModelWizard, modelWizardStartHint } from './wizard/modelWizard.js';

type AppProps = {
  initialContext: CliContext;
  initialSessionModel?: CustomModelConfig;
  systemPrompt: string;
  initialMessages?: DisplayMessage[];
  /** Restore last session on launch (only with --continue / --resume). */
  continueSession?: boolean;
};

type LaunchLogoItem = {
  id: '__launch_logo__';
  kind: 'launch_logo';
  model: string;
  modelSource?: string;
  configPath: string;
  continueSession?: boolean;
  restoredCount?: number;
};

type StaticItem = DisplayMessage | LaunchLogoItem;

function isLaunchLogoItem(item: StaticItem): item is LaunchLogoItem {
  return 'kind' in item && item.kind === 'launch_logo';
}

function renderStaticItem(item: StaticItem): ReactElement {
  if (isLaunchLogoItem(item)) {
    return (
      <Logo
        key={item.id}
        model={item.model}
        modelSource={item.modelSource}
        configPath={item.configPath}
        continueSession={item.continueSession}
        restoredCount={item.restoredCount}
      />
    );
  }
  return (
    <Message
      key={item.id}
      role={item.role}
      text={item.text}
      tool={item.tool}
      space={item.space}
      result={item.result}
      nested={item.nested}
      tone={item.tone}
    />
  );
}

export function App({
  initialContext,
  initialSessionModel,
  systemPrompt,
  initialMessages,
  continueSession = false,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [config, setConfig] = useState<CliConfig>(initialContext.config);
  const [ctx, setCtx] = useState<CliContext>(initialContext);
  const [sessionModel, setSessionModel] = useState<CustomModelConfig | undefined>(initialSessionModel);
  const model = sessionModel ?? ctx.model ?? config.model;
  const engine = useMemo(() => new ChatEngine(model, ctx.persistence), [model, ctx.persistence]);
  const initialPrefs = resolveSessionPrefs(initialContext.config);
  const [runMode, setRunModeState] = useState<RunMode>(initialPrefs.runMode);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(initialPrefs.permissionMode);
  const sessionRuntimeRef = useRef<SessionRuntimeOptions>({
    runMode: initialPrefs.runMode,
    permissionMode: initialPrefs.permissionMode,
  });
  sessionRuntimeRef.current = { runMode, permissionMode };
  const chat = useChat(engine, systemPrompt, sessionRuntimeRef);
  const [input, setInput] = useState('');
  const needsOnboarding = !config.onboarded && !model;
  const [wizard, setWizard] = useState<ModelWizard | null>(needsOnboarding ? { step: 'protocol', draft: {} } : null);
  const [sessionPicker, setSessionPicker] = useState<SessionPicker | null>(null);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [modelPicker, setModelPicker] = useState<ModelPicker | null>(null);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modePicker, setModePicker] = useState(false);
  const [modePickerIndex, setModePickerIndex] = useState(0);
  const [channelPicker, setChannelPicker] = useState(false);
  const [channelPickerIndex, setChannelPickerIndex] = useState(0);
  const [connectView, setConnectView] = useState<ConnectionView | null>(null);
  const connectAbortRef = useRef<AbortController | null>(null);
  const userInputHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number | null>(null);
  const [onboardingHint, setOnboardingHint] = useState(needsOnboarding);
  const [ambientRefresh, setAmbientRefresh] = useState(0);
  const ambient = useAmbientStatus(ctx.dbReachable, ambientRefresh);

  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    if (initialMessages && initialMessages.length > 0) {
      hydrated.current = true;
      chat.load(initialMessages);
      return;
    }
    if (!continueSession) return;
    void (async () => {
      const local = await loadLastSession();
      if (local && local.length > 0) {
        hydrated.current = true;
        chat.load(local);
        return;
      }
      const fromDb = await engine.resumeLastThread();
      if (fromDb && fromDb.messages.length > 0) {
        hydrated.current = true;
        chat.load(
          fromDb.messages.map((message, index) => ({ id: index + 1, role: message.role, text: message.text })),
          fromDb.contextMessages,
          { workspaceRoot: fromDb.workspaceRoot },
        );
      }
    })();
  }, [continueSession, chat, engine, initialMessages]);

  useEffect(() => {
    if (model && !config.onboarded) {
      const next = { ...config, onboarded: true };
      void saveConfig(next);
      setConfig(next);
    }
  }, [model, config.onboarded]);

  useEffect(() => {
    if (needsOnboarding && wizard) {
      chat.notify('首次使用：请完成模型配置（也可稍后运行 zleap init）\n' + modelWizardStartHint());
    }
  }, []);

  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort();
    };
  }, []);

  const persistStatusRef = useRef(chat.status);
  useEffect(() => {
    const prev = persistStatusRef.current;
    persistStatusRef.current = chat.status;
    if (prev === 'running' && chat.status === 'idle') {
      void saveSession(chat.messages);
    }
  }, [chat.status, chat.messages]);

  const running = chat.status === 'running';
  const paletteEnabled =
    !wizard &&
    !sessionPicker &&
    !modelPicker &&
    !modePicker &&
    !connectView &&
    !channelPicker &&
    (!running || input.startsWith('/'));
  const palette = useCommandPalette(input, paletteEnabled, running);

  const [flash, setFlash] = useState<MascotMood | null>(null);
  const prevStatusRef = useRef(chat.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = chat.status;
    if (chat.status === 'running') {
      setFlash(null);
      return;
    }
    if (prev === 'running' && chat.status === 'idle') {
      setFlash(chat.lastRunError ? 'error' : 'done');
      const timer = setTimeout(() => setFlash(null), 1600);
      return () => clearTimeout(timer);
    }
  }, [chat.status, chat.lastRunError]);

  const mood =
    flash ??
    resolveMascotMood({
      running,
      tool: chat.activeTool != null,
      wizard: wizard != null,
      paletteOpen: palette.open,
    });

  const persistSessionPrefs = useCallback(
    (patch: { runMode?: RunMode; permissionMode?: PermissionMode }) => {
      const nextConfig = patchSessionPrefs(config, patch);
      void saveConfig(nextConfig);
      setConfig(nextConfig);
      if (patch.runMode) {
        setRunModeState(patch.runMode);
      }
      if (patch.permissionMode) {
        setPermissionModeState(patch.permissionMode);
      }
    },
    [config],
  );

  const applyRunMode = useCallback(
    (mode: RunMode, notify = true) => {
      persistSessionPrefs({ runMode: mode });
      if (notify) {
        chat.notify(`运行模式 → ${runModeLabel(mode)} · ${runModeHint(mode)}`);
      }
    },
    [chat, persistSessionPrefs],
  );

  const applyPermissionMode = useCallback(
    (mode: PermissionMode, notify = true) => {
      persistSessionPrefs({ permissionMode: mode });
      if (notify) {
        chat.notify(`权限模式 → ${permissionModeLabel(mode)} · ${permissionModeHint(mode)}`);
      }
    },
    [chat, persistSessionPrefs],
  );

  const cycleRunMode = useCallback(() => {
    applyRunMode(nextRunMode(runMode));
  }, [applyRunMode, runMode]);

  const cyclePermissionMode = useCallback(() => {
    applyPermissionMode(nextPermissionMode(permissionMode));
  }, [applyPermissionMode, permissionMode]);

  const openModePicker = useCallback((): void => {
    setModePicker(true);
    setModePickerIndex(0);
  }, []);

  const executePlan = useCallback(() => {
    applyRunMode('normal', false);
    chat.notify('已切换到普通模式，开始执行计划…');
    void chat.send('执行');
  }, [applyRunMode, chat]);

  const quit = useCallback(() => {
    exit();
  }, [exit]);

  const refreshContext = useCallback(async (): Promise<CliContext> => {
    const next = await resolveCliContext({ ...(sessionModel ? { sessionModel } : {}) });
    setCtx(next);
    setConfig(next.config);
    return next;
  }, [sessionModel]);

  const openSessionPicker = useCallback(async (): Promise<void> => {
    const items: SessionListItem[] = [];
    const local = await loadLastSession();
    if (local && local.length > 0) {
      items.push({
        id: '__local__',
        title: '上次本地会话',
        updatedAt: new Date(),
        source: 'local',
      });
    }
    const threads = await engine.listRecentThreads(12);
    for (const thread of threads) {
      items.push({ ...thread, source: 'db' });
    }
    setSessionPicker({ items });
    setSessionPickerIndex(0);
  }, [engine]);

  const openModelPicker = useCallback(async (): Promise<void> => {
    const items = await listSelectableModels();
    if (items.length === 0) {
      setWizard({ step: 'protocol', draft: {} });
      chat.notify(modelWizardStartHint());
      return;
    }
    setModelPicker({ items });
    setModelPickerIndex(0);
  }, [chat]);

  const openChannelPicker = useCallback((): void => {
    setChannelPicker(true);
    setChannelPickerIndex(0);
  }, []);

  const cancelConnect = useCallback((): void => {
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    setConnectView(null);
  }, []);

  const startConnectFlow = useCallback(
    async (channel: string): Promise<void> => {
      if (!isKnownChannel(channel)) {
        chat.notify(`未知频道。支持：${KNOWN_CHANNELS.join(' | ')}`);
        return;
      }
      cancelConnect();
      const controller = new AbortController();
      connectAbortRef.current = controller;
      setConnectView({
        channel,
        phase: 'connecting',
        title: `[${channel}] 连接中`,
        lines: ['正在请求连接…'],
      });
      const result = await startTuiChannelConnect(channel, {
        signal: controller.signal,
        onView: (view) => setConnectView(view),
      });
      if (controller.signal.aborted) {
        return;
      }
      connectAbortRef.current = null;
      if (result === 'connected') {
        setConnectView(null);
        chat.notify(`${channel} 连接成功，可在 IM 中发消息测试。`);
        setAmbientRefresh((n) => n + 1);
      } else if (result === 'error') {
        chat.notify(`${channel} 连接失败，请检查 gateway 日志。`);
      } else if (result === 'timeout') {
        setConnectView({
          channel,
          phase: 'error',
          title: `[${channel}] 连接超时`,
          lines: ['5 分钟内未完成连接。请确认 gateway 在运行：zleap serve --gateway'],
        });
        chat.notify('连接超时（5 分钟）。请确认 gateway 在运行：zleap serve --gateway');
      } else if (result === 'no_db') {
        setConnectView({
          channel,
          phase: 'error',
          title: `[${channel}] 连接失败`,
          lines: ['未配置或无法打开数据库。请运行 zleap init 并设置 ZLEAP_DATABASE_URL。'],
        });
        chat.notify('未配置或无法打开数据库。请检查 ZLEAP_DATABASE_URL 和数据库服务。');
      }
    },
    [cancelConnect, chat],
  );

  const runBuiltin = useCallback(
    (command: BuiltinCommand, rawInput?: string): void => {
      if (command === '/exit' || command === '/quit') {
        quit();
        return;
      }
      if (command === '/help') {
        chat.notify(formatSlashHelp());
        return;
      }
      if (command === '/status') {
        void (async () => {
          const status = await engine.inspect();
          const stack = await formatStackStatusSummary();
          const channels = ctx.dbReachable ? await formatChannelsStatusSummary() : null;
          const body = formatStatus(status, chat.messages.length, ctx);
          const parts = [body, stack];
          if (channels) {
            parts.push(channels);
          }
          chat.notify(parts.join('\n\n'));
        })();
        return;
      }
      if (command === '/config') {
        void refreshContext().then((next) => chat.notify(formatConfigSummary(next)));
        return;
      }
      if (command === '/doctor') {
        void formatDoctorSummary().then((text) => chat.notify(text));
        return;
      }
      if (command === '/abort') {
        if (chat.status === 'running') {
          chat.abort();
        } else {
          chat.notify('当前没有正在生成的回复。');
        }
        return;
      }
      if (command === '/connect') {
        const channel = rawInput ? parseConnectChannel(rawInput) : undefined;
        if (!channel) {
          openChannelPicker();
          return;
        }
        void startConnectFlow(channel);
        return;
      }
      if (command === '/channels') {
        void (async () => {
          if (!ctx.dbReachable) {
            chat.notify('未连接数据库，无法读取 IM 频道状态。请运行 zleap init 并 /serve。');
            return;
          }
          const summary = await formatChannelsStatusSummary();
          chat.notify(summary ?? '无法读取 IM 频道状态。');
        })();
        return;
      }
      if (command === '/serve') {
        chat.notify('正在后台启动本地栈…');
        void spawnServeDetached({ gateway: true }).then((text) => {
          chat.notify(text);
          setAmbientRefresh((n) => n + 1);
        });
        return;
      }
      if (command === '/stop') {
        void stopServeFromTui().then((text) => {
          chat.notify(text);
          setAmbientRefresh((n) => n + 1);
        });
        return;
      }
      if (command === '/context') {
        void engine.inspect().then((status) => chat.notify(formatContext(status, chat.messages.length)));
        return;
      }
      if (command === '/compact') {
        chat.notify('正在 compact…');
        void engine.compactNow(chat.history()).then((report) => chat.notify(report));
        return;
      }
      if (command === '/spaces') {
        chat.notify(formatSpaces());
        return;
      }
      if (command === '/clear' || command === '/new') {
        chat.clear();
        void clearLastSession();
        chat.notify('已开始新对话。');
        return;
      }
      if (command === '/sessions') {
        void openSessionPicker();
        return;
      }
      if (command === '/resume') {
        void (async () => {
          const restored = await loadLastSession();
          if (restored && restored.length > 0) {
            chat.load(restored);
            chat.notify(`已恢复 ${restored.length} 条消息。`);
            return;
          }
          const fromDb = await engine.resumeLastThread();
          if (fromDb && fromDb.messages.length > 0) {
            chat.load(
              fromDb.messages.map((message, index) => ({ id: index + 1, role: message.role, text: message.text })),
              fromDb.contextMessages,
              { workspaceRoot: fromDb.workspaceRoot },
            );
            chat.notify(`已从数据库恢复 ${fromDb.messages.length} 条消息。`);
            return;
          }
          chat.notify('没有可恢复的会话。');
        })();
        return;
      }
      if (command === '/memory') {
        void engine.recentMemory().then((text) => chat.notify(text));
        return;
      }
      if (command === '/model') {
        void openModelPicker();
        return;
      }
      if (command === '/mode') {
        openModePicker();
        return;
      }
      if (command === '/plan') {
        applyRunMode('plan');
        return;
      }
      if (command === '/normal') {
        applyRunMode('normal');
        return;
      }
      if (command === '/goal') {
        applyRunMode('goal');
        return;
      }
      if (command === '/permissions') {
        cyclePermissionMode();
        return;
      }
      if (command === '/execute') {
        executePlan();
        return;
      }
    },
    [
      applyRunMode,
      chat,
      ctx,
      cyclePermissionMode,
      engine,
      executePlan,
      openChannelPicker,
      openModePicker,
      openModelPicker,
      openSessionPicker,
      quit,
      refreshContext,
      startConnectFlow,
    ],
  );

  useInput((value, key) => {
    if (key.shift && key.tab) {
      if (!wizard && !sessionPicker && !modelPicker && !modePicker && !connectView && !channelPicker && !running) {
        cycleRunMode();
      }
      return;
    }
    if (key.ctrl && value === 'c') {
      if (chat.status === 'running') {
        chat.abort();
      } else {
        quit();
      }
      return;
    }
    if (key.ctrl && value === 'd') {
      quit();
      return;
    }
    if (chat.pendingApproval) {
      if (value === 'y' || value === 'Y' || value === 'a' || value === 'A') {
        chat.respondApproval(true);
      } else if (value === 'n' || value === 'N' || key.escape) {
        chat.respondApproval(false);
      }
      return;
    }
    if (key.upArrow && !palette.open) {
      if (sessionPicker) {
        setSessionPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (modelPicker) {
        setModelPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (modePicker) {
        setModePickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (channelPicker) {
        setChannelPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (!wizard && !connectView && input === '') {
        const hist = userInputHistoryRef.current;
        if (hist.length > 0) {
          if (historyCursorRef.current === null) {
            historyCursorRef.current = hist.length;
          }
          historyCursorRef.current = Math.max(0, historyCursorRef.current - 1);
          setInput(hist[historyCursorRef.current] ?? '');
        }
        return;
      }
    }
    if (key.downArrow && !palette.open) {
      if (sessionPicker) {
        setSessionPickerIndex((i) => Math.min((sessionPicker?.items.length ?? 1) - 1, i + 1));
        return;
      }
      if (modelPicker) {
        setModelPickerIndex((i) => Math.min(modelPicker?.items.length ?? 0, i + 1));
        return;
      }
      if (modePicker) {
        setModePickerIndex((i) => Math.min(2, i + 1));
        return;
      }
      if (channelPicker) {
        setChannelPickerIndex((i) => Math.min(KNOWN_CHANNELS.length - 1, i + 1));
        return;
      }
      if (historyCursorRef.current !== null) {
        historyCursorRef.current += 1;
        const hist = userInputHistoryRef.current;
        if (historyCursorRef.current >= hist.length) {
          historyCursorRef.current = null;
          setInput('');
        } else {
          setInput(hist[historyCursorRef.current] ?? '');
        }
        return;
      }
    }
    if (key.escape) {
      if (chat.status === 'running') {
        chat.abort();
        return;
      }
      if (sessionPicker) {
        setSessionPicker(null);
        chat.notify('已取消。');
        return;
      }
      if (modelPicker) {
        setModelPicker(null);
        chat.notify('已取消。');
        return;
      }
      if (modePicker) {
        setModePicker(false);
        chat.notify('已取消。');
        return;
      }
      if (channelPicker) {
        setChannelPicker(false);
        chat.notify('已取消。');
        return;
      }
      if (connectView) {
        cancelConnect();
        chat.notify('已取消连接。');
        return;
      }
      if (palette.open) {
        setInput('');
        palette.reset();
      }
    }
  });

  const onSubmit = (raw: string): void => {
    if (palette.open && palette.selected) {
      setInput('');
      palette.reset();
      if (palette.selected.name === '/connect') {
        openChannelPicker();
        return;
      }
      if (palette.selected.name === '/abort' && chat.status === 'running') {
        chat.abort();
        return;
      }
      runBuiltin(palette.selected.name);
      return;
    }

    const text = raw.trim();
    setInput('');
    historyCursorRef.current = null;

    const command = parseBuiltinCommand(text);
    if (command === '/abort') {
      runBuiltin('/abort');
      return;
    }

    if (sessionPicker) {
      const index = resolveNumberedSelection(text, sessionPickerIndex, 1);
      void handleSessionPick(String(index), sessionPicker, {
        chat,
        engine,
        clearPicker: () => setSessionPicker(null),
      });
      return;
    }

    if (modelPicker) {
      const index = resolveNumberedSelection(text, modelPickerIndex, 0);
      void handleModelPick(String(index), modelPicker, {
        chat,
        setWizard,
        setSessionModel,
        setCtx,
        clearPicker: () => setModelPicker(null),
      });
      return;
    }

    if (modePicker) {
      const modes: RunMode[] = ['normal', 'plan', 'goal'];
      const index = resolveNumberedSelection(text, modePickerIndex, 1) - 1;
      const mode = modes[index];
      if (!mode) {
        chat.notify('请输入有效编号（1=普通 2=计划 3=目标）。');
        setModePicker(true);
        return;
      }
      setModePicker(false);
      applyRunMode(mode);
      return;
    }

    if (channelPicker) {
      const index = resolveNumberedSelection(text, channelPickerIndex, 1);
      const channel = KNOWN_CHANNELS[index - 1];
      if (!channel) {
        chat.notify('请输入有效编号。');
        setChannelPicker(true);
        return;
      }
      setChannelPicker(false);
      void startConnectFlow(channel);
      return;
    }

    if (chat.status === 'running') {
      return;
    }
    if (!text) {
      return;
    }

    if (wizard) {
      void runWizardStep({ wizard, text, setWizard, setConfig, notify: chat.notify, refreshContext });
      if (onboardingHint) {
        setOnboardingHint(false);
      }
      return;
    }

    if (command) {
      runBuiltin(command, text);
      return;
    }

    if (runMode === 'plan' && isPlanExecuteText(text)) {
      executePlan();
      return;
    }

    userInputHistoryRef.current = [...userInputHistoryRef.current, text].slice(-50);
    void chat.send(text);
  };

  const displayModel = model ? modelLabel({ model }) : '未配置模型';
  const modelSource = sessionModel ? 'session' : ctx.modelSource;
  const launchLogoItemRef = useRef<LaunchLogoItem | null>(null);
  if (!launchLogoItemRef.current) {
    launchLogoItemRef.current = {
      id: '__launch_logo__',
      kind: 'launch_logo',
      model: displayModel,
      modelSource: modelSourceLabel(modelSource),
      configPath: CONFIG_PATH,
      continueSession,
      restoredCount: initialMessages?.length,
    };
  }

  const staticItems: StaticItem[] = useMemo(
    () => [launchLogoItemRef.current!, ...chat.messages],
    [chat.messages],
  );

  const sessionPickerItems: PickerItem[] = useMemo(
    () =>
      sessionPicker?.items.map((item, index) => ({
        id: item.id,
        label: item.title,
        detail: item.source === 'local' ? '本地' : '数据库',
      })) ?? [],
    [sessionPicker],
  );

  const modelPickerItems: PickerItem[] = useMemo(
    () =>
      modelPicker
        ? [
            { id: '__manual__', label: '手动配置向导', detail: '0' },
            ...modelPicker.items.map((item) => ({ id: item.id, label: item.label })),
          ]
        : [],
    [modelPicker],
  );

  const channelPickerItems: PickerItem[] = useMemo(
    () => KNOWN_CHANNELS.map((channel) => ({ id: channel, label: channel })),
    [],
  );

  const modePickerItems: PickerItem[] = useMemo(
    () => [
      { id: 'normal', label: '普通模式', detail: '1 · 直接对话与执行' },
      { id: 'plan', label: '计划模式', detail: '2 · 只分析不执行' },
      { id: 'goal', label: '目标模式', detail: '3 · 持续追踪目标' },
    ],
    [],
  );

  const messageCount = chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  const contextBar = useMemo((): ContextBarProps => {
    let mode: ContextBarMode = running ? 'running' : 'idle';
    let modeHint: string | undefined;
    if (connectView) {
      mode = 'connect';
      modeHint = connectView.title;
    } else if (channelPicker) {
      mode = 'picker';
      modeHint = '选择 IM 频道';
    } else if (sessionPicker) {
      mode = 'picker';
      modeHint = '选择会话';
    } else if (modelPicker) {
      mode = 'picker';
      modeHint = '选择模型';
    } else if (modePicker) {
      mode = 'picker';
      modeHint = '选择运行模式';
    } else if (wizard) {
      mode = 'wizard';
      modeHint = `输入 ${wizard.step}`;
    } else if (palette.open) {
      mode = 'palette';
    }
    return {
      model: displayModel,
      mode,
      modeHint,
      runMode,
      permissionMode,
      contextUsage: chat.contextUsage,
      messageCount,
      dbReachable: ctx.dbReachable,
      hasDatabase: Boolean(ctx.persistence.databaseUrl),
      ambient,
      draftLines: input.split('\n').length,
    };
  }, [
    ambient,
    channelPicker,
    chat.contextUsage,
    connectView,
    ctx.dbReachable,
    ctx.persistence.databaseUrl,
    displayModel,
    input,
    messageCount,
    modePicker,
    modelPicker,
    palette.open,
    permissionMode,
    runMode,
    running,
    sessionPicker,
    wizard,
  ]);

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>{(item) => renderStaticItem(item)}</Static>

      {onboardingHint && wizard ? (
        <Box marginTop={1}>
          <Text dimColor>首次使用 · 按提示完成模型配置，或 Ctrl+C 后运行 zleap init</Text>
        </Box>
      ) : null}

      {chat.live ? <Message role="assistant" text={chat.live} streaming /> : null}
      {chat.activeTool ? (
        <Message role="tool" tool={chat.activeTool} nested={chat.activeSpace != null || spaceDepthFromMessages(chat.messages)} />
      ) : null}
      {sessionPicker ? (
        <PickerList title="选择会话" items={sessionPickerItems} selectedIndex={sessionPickerIndex} />
      ) : null}
      {modelPicker ? (
        <PickerList title="选择模型" items={modelPickerItems} selectedIndex={modelPickerIndex} hint="0=手动向导 · Enter 确认" />
      ) : null}
      {modePicker ? (
        <PickerList title="选择运行模式" items={modePickerItems} selectedIndex={modePickerIndex} hint="Enter 确认 · Esc 取消" />
      ) : null}
      {channelPicker ? (
        <PickerList title="选择 IM 频道" items={channelPickerItems} selectedIndex={channelPickerIndex} />
      ) : null}
      {chat.pendingApproval ? <ConfirmCard request={chat.pendingApproval} /> : null}
      {connectView ? <ConnectPanel view={connectView} /> : null}
      {running && !chat.live && !chat.activeTool && !chat.pendingApproval ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Spinner />
            {chat.activeSpace ? <Text dimColor>{` · ${chat.activeSpace.label}`}</Text> : null}
          </Box>
          {chat.activeSpaceStatus ? (
            <Text dimColor wrap="wrap">{`  ${chat.activeSpaceStatus}`}</Text>
          ) : null}
        </Box>
      ) : null}

      <Prompt
        value={input}
        focus={!running || input.startsWith('/')}
        contextBar={contextBar}
        mood={mood}
        mask={wizard?.step === 'apiKey' ? '*' : undefined}
        palette={
          paletteEnabled
            ? {
                open: palette.open,
                commands: palette.commands,
                selectedIndex: palette.index,
                onMove: palette.move,
              }
            : undefined
        }
        onChange={setInput}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

function spaceDepthFromMessages(messages: DisplayMessage[]): boolean {
  let depth = 0;
  for (const message of messages) {
    if (message.role === 'space') depth += 1;
    if (message.role === 'space_result') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

async function handleSessionPick(
  text: string,
  picker: SessionPicker,
  opts: {
    chat: ReturnType<typeof useChat>;
    engine: ChatEngine;
    clearPicker: () => void;
  },
): Promise<void> {
  const index = Number.parseInt(text, 10);
  if (!Number.isFinite(index) || index < 1 || index > picker.items.length) {
    opts.chat.notify('请输入有效编号。');
    return;
  }
  const item = picker.items[index - 1]!;
  opts.clearPicker();
  if (item.source === 'local' || item.id === '__local__') {
    const local = await loadLastSession();
    if (local?.length) {
      opts.chat.load(local);
      opts.chat.notify(`已恢复本地会话（${local.length} 条）。`);
      return;
    }
  }
  const fromDb = await opts.engine.resumeThreadById(item.id);
  if (fromDb?.messages.length) {
    opts.chat.load(
      fromDb.messages.map((message, i) => ({ id: i + 1, role: message.role, text: message.text })),
      fromDb.contextMessages,
      { workspaceRoot: fromDb.workspaceRoot },
    );
    opts.chat.notify(`已恢复「${item.title}」（${fromDb.messages.length} 条）。`);
    return;
  }
  opts.chat.notify('无法恢复该会话。');
}

async function handleModelPick(
  text: string,
  picker: ModelPicker,
  opts: {
    chat: { notify: (text: string) => void };
    setWizard: (wizard: ModelWizard | null) => void;
    setSessionModel: (model: CustomModelConfig | undefined) => void;
    setCtx: (ctx: CliContext) => void;
    clearPicker: () => void;
  },
): Promise<void> {
  const index = Number.parseInt(text, 10);
  if (!Number.isFinite(index) || index < 0 || index > picker.items.length) {
    opts.chat.notify('请输入有效编号。');
    return;
  }
  opts.clearPicker();
  if (index === 0) {
    opts.setWizard({ step: 'protocol', draft: {} });
    opts.chat.notify(modelWizardStartHint());
    return;
  }
  const selected = picker.items[index - 1]!;
  const resolved = await resolveModelConfigById(selected.id);
  if (!resolved) {
    opts.chat.notify('无法加载该模型配置。');
    return;
  }
  opts.setSessionModel(resolved);
  const next = await resolveCliContext({ sessionModel: resolved });
  opts.setCtx(next);
  opts.chat.notify(`已切换模型：${selected.label}`);
}

export function formatStatus(status: EngineStatus, messageCount: number, ctx: CliContext): string {
  const { model, persistence, context } = status;
  const prefs = resolveSessionPrefs(ctx.config);
  const provider = model.custom ? 'OpenAI 兼容' : '无';
  const memory = persistence.enabled
    ? persistence.reachable
      ? `开${persistence.embeddingModel ? ` · embed: ${persistence.embeddingModel}` : ''}`
      : '已配置但不可达'
    : '关';
  const items = context.itemHistoryActive
    ? `活跃（已提取 ${context.extractedCount} 条）`
    : '未激活';
  return [
    '状态',
    `  模型       ${model.label}（${provider}）`,
    `  来源       ${modelSourceLabel(ctx.modelSource)}`,
    `  配置       ${CONFIG_PATH}`,
    `  数据库     ${ctx.persistence.databaseUrl ? (ctx.dbReachable ? '已连接' : '不可达') : '未配置'}`,
    `  运行模式   ${runModeLabel(prefs.runMode)}`,
    `  权限模式   ${permissionModeLabel(prefs.permissionMode)}`,
    `  记忆       ${memory}`,
    `  消息数     ${messageCount}`,
    `  Item 历史  ${items}`,
    ...formatPersistenceFailure(status.persistence),
  ].join('\n');
}

function formatPersistenceFailure(persistence: EngineStatus['persistence']): string[] {
  if (persistence.writeFailureCount <= 0) {
    return [];
  }
  const latest = persistence.lastWriteFailure
    ? `${persistence.lastWriteFailure.phase}/${persistence.lastWriteFailure.operation}${persistence.lastWriteFailure.code ? ` (${persistence.lastWriteFailure.code})` : ''}: ${persistence.lastWriteFailure.message}`
    : 'unknown persistence write failure';
  return [
    `  写入失败   ${persistence.writeFailureCount} 次`,
    `  最近       ${latest}`,
    '  建议       检查数据库连接后运行 /doctor',
  ];
}

function formatContext(status: EngineStatus, messageCount: number): string {
  const { context } = status;
  return [
    '上下文',
    `  消息数           ${messageCount}`,
    `  已提取           ${context.extractedCount} 条较早消息`,
    `  Item 历史        ${context.itemHistoryActive ? '有' : '尚无'}`,
    `  触发阈值         > ${context.triggerMessages} 条或 > ${context.triggerTokens.toLocaleString()} tokens 或 ${(context.refreshThreshold * 100).toFixed(0)}% 窗口`,
    '',
    '运行 /compact 可立即提取较早轮次到记忆。',
  ].join('\n');
}

function formatSpaces(): string {
  const lines = buildDefaultSeedWorkspaceDetails().flatMap((space) => {
    const planned = space.status === 'planned';
    const head = `  ${space.icon ? `${space.icon} ` : ''}${space.label}${planned ? '  (即将)' : ''}`;
    const detail = [`    场景:  ${space.when}`];
    if (!planned) {
      detail.push(`    工具:  ${space.toolIds.length ? space.toolIds.join(', ') : '—'}`);
    }
    return [head, ...detail];
  });
  return ['Workspace（每轮路由进入一个；Session 为常驻主空间）：', ...lines].join('\n');
}

export function resolveNumberedSelection(text: string, selectedIndex: number, emptyOffset: number): number {
  const trimmed = text.trim();
  if (trimmed) {
    return Number.parseInt(trimmed, 10);
  }
  return selectedIndex + emptyOffset;
}

async function runWizardStep(options: {
  wizard: ModelWizard;
  text: string;
  setWizard: (wizard: ModelWizard | null) => void;
  setConfig: (config: CliConfig) => void;
  notify: (text: string) => void;
  refreshContext: () => Promise<CliContext>;
}): Promise<void> {
  const { wizard, text, setWizard, setConfig, notify, refreshContext } = options;
  const result = await advanceModelWizard({ wizard, text, notify });
  setWizard(result.wizard);
  if (result.config) {
    const onboarded = { ...result.config, onboarded: true };
    await saveConfig(onboarded);
    setConfig(onboarded);
    await refreshContext();
  }
}

export { loadConfig };

import { mkdir } from 'node:fs/promises';
import type { CustomModelConfig, Message } from '@zleap/ai';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_FILE_WORKSPACE_ROOT,
  localDevActorContext,
  resolveConversationWorkspaceRoot,
  threadIdOf,
  type ActorContext,
  type HistorySource,
  type InboundMessage,
  type SendResult,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import type { PersistenceConfig } from '../config.js';
import {
  ChatEngine,
  DEFAULT_SYSTEM_PROMPT,
  type ChatDelta,
  type ChatTaskManager,
  type ToolConfirm,
} from '../engine/index.js';
import {
  isStopCommand,
  matchCommand,
  type CommandContext,
  type CommandOutcome,
} from './commands.js';
import { loadHistory } from './history.js';
import { messageFromInbound } from './inboundMessage.js';
import { KeyedMutex, Semaphore } from './mutex.js';
import { resolveModelFromStore, type ResolveModelInput } from './model.js';
import { OutboundSenderRegistry, type OutboundTarget } from './outbound.js';

/** Resolve the model to run for an inbound message. */
export type ModelResolver = (
  inbound: InboundMessage,
  input: ResolveModelInput,
) => Promise<CustomModelConfig | undefined> | CustomModelConfig | undefined;

/** Map a platform identity into the internal actor (memory/permission scope). */
export type ActorResolver = (inbound: InboundMessage) => ActorContext | undefined;

export function defaultConversationActor(inbound: InboundMessage): ActorContext | undefined {
  if (inbound.actor) {
    return inbound.actor;
  }
  if (inbound.kind === 'im') {
    return localDevActorContext();
  }
  return undefined;
}

/** Per-run ChatEngine construction overrides (web computes these per request). */
export type EngineOverrides = {
  /** Tool ids switched OFF; filtered when mounting a space's tools. */
  disabledToolIds?: string[];
  /** Space ids this assistant may enter; omit/empty means all. */
  allowedSpaceIds?: string[];
  /** Expose no tools in any space (plan mode). */
  disableAllTools?: boolean;
  /** Scheduled-task management tool surface. */
  taskManager?: ChatTaskManager;
  /** Temporarily expose selected skills for this run. */
  temporarySkillIds?: string[];
};

export type ConversationServiceDeps = {
  /** Shared, process-level durable store (one PG pool for all conversations). */
  store: ZleapStore | null;
  /**
   * Fallback engine persistence, used ONLY when `store` is null (e.g. per-request
   * web, which closes its read pools before streaming). When a shared `store` is
   * provided, engines inject it directly (one pool) and this is ignored; the
   * worker is then responsible for seeding defaults once at startup.
   */
  persistence?: PersistenceConfig;
  /** Model resolution; defaults to store -> space -> default -> env. */
  resolveModel?: ModelResolver;
  /** Identity mapping; defaults to `inbound.actor`. */
  resolveActor?: ActorResolver;
  /** Avatar/agent id to run as. Defaults to the built-in default avatar. */
  avatarId?: string;
  /** Base system prompt. Defaults to DEFAULT_SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Outbound senders for `deliver`. A fresh registry is created when omitted. */
  senders?: OutboundSenderRegistry;
  /** Global concurrency cap across conversations (0 disables it). */
  maxConcurrent?: number;
  /** Max number of cached per-conversation engines before LRU eviction. */
  maxEngines?: number;
};

export type HandleOptions = {
  systemPrompt?: string;
  targetSpace?: string;
  workspaceRoot?: string;
  confirm?: ToolConfirm;
  /** History policy. Defaults from `inbound.kind`: schedule=none, else store. */
  historySource?: HistorySource;
  /**
   * Include prior tool-call/result traces when rebuilding `store` history, so the
   * model sees what tools earlier turns used. Defaults to true.
   */
  includeToolHistory?: boolean;
  /** Full transcript for `historySource: 'caller'` (legacy web). Used as-is. */
  messages?: Message[];
  modelConfigId?: string;
  /** Pre-resolved model; bypasses the service's model resolver when provided. */
  model?: CustomModelConfig;
  /** Run as this avatar/agent id (overrides the service default for this run). */
  avatarId?: string;
  /** Per-run engine construction overrides (web tool/space/plan settings). */
  engine?: EngineOverrides;
  /** Intercept slash commands. Defaults to `inbound.kind !== 'schedule'`. */
  handleCommands?: boolean;
  signal?: AbortSignal;
};

type EngineEntry = { engine: ChatEngine; modelId: string };

const NO_MODEL_MESSAGE =
  '未配置模型。运行 zleap init 或 /model 配置；也可设置 ZLEAP_MODEL_BASE_URL / ZLEAP_MODEL_API_KEY / ZLEAP_MODEL_NAME。';

/** History-epoch separator. Must be sanitize-safe (within [\w:.-]). */
const EPOCH_SEPARATOR = '.e';

/**
 * Derive the effective conversation id for a given history epoch. The separator
 * must survive the persistence layer's sanitizeId (which keeps only [\w:.-]); a
 * '#' would be rewritten to '-', desyncing the session id that loadHistory reads
 * from the one beginReply writes to. Exported for the invariant regression test.
 */
export function epochConversationId(conversationId: string, epoch: number): string {
  return epoch > 0 ? `${conversationId}${EPOCH_SEPARATOR}${epoch}` : conversationId;
}

/**
 * L2 conversation layer. The single entry point every trigger (web, tasks, IM
 * gateway) calls. It is server-owned: it resolves the conversation identity,
 * loads history from the store (or runs clean), resolves the model, serializes
 * per-conversation, invokes the agent via a shared-store ChatEngine, and streams
 * the reply back. Persistence is a side effect of the engine run.
 */
export class ConversationService {
  private readonly store: ZleapStore | null;
  private readonly persistence?: PersistenceConfig;
  private readonly resolveModelFn: ModelResolver;
  private readonly resolveActorFn: ActorResolver;
  private readonly avatarId: string;
  private readonly systemPrompt: string;
  private readonly senders: OutboundSenderRegistry;
  private readonly mutex = new KeyedMutex();
  private readonly semaphore: Semaphore;
  private readonly engines = new Map<string, EngineEntry>();
  private readonly maxEngines: number;
  /** Per base-conversation history generation; bumped by /new (in-memory). */
  private readonly epochs = new Map<string, number>();
  /** Per base-conversation in-flight run, so /stop can abort it out-of-band. */
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(deps: ConversationServiceDeps) {
    this.store = deps.store;
    if (deps.persistence) {
      this.persistence = deps.persistence;
    }
    this.avatarId = deps.avatarId ?? DEFAULT_AVATAR_ID;
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.senders = deps.senders ?? new OutboundSenderRegistry();
    this.semaphore = new Semaphore(deps.maxConcurrent ?? 0);
    this.maxEngines = deps.maxEngines ?? 256;
    this.resolveActorFn = deps.resolveActor ?? defaultConversationActor;
    this.resolveModelFn = deps.resolveModel
      ?? (async (_inbound, input) => (await resolveModelFromStore(this.store, input)).model);
  }

  /** Access the outbound sender registry to register channel senders. */
  get outbound(): OutboundSenderRegistry {
    return this.senders;
  }

  /**
   * Process one inbound message and stream the assistant reply. Holds a
   * per-conversation lock for the whole "load -> run -> persist" sequence and an
   * optional global concurrency permit. Slash commands are intercepted here and
   * never reach the agent.
   */
  async *handle(inbound: InboundMessage, opts: HandleOptions = {}): AsyncIterable<ChatDelta> {
    const actor = this.resolveActorFn(inbound);
    const { channel, conversationId } = inbound;
    const baseThreadId = threadIdOf(channel, conversationId);
    const commandsEnabled = opts.handleCommands ?? (inbound.kind !== 'schedule');

    // /stop must bypass the per-chat lock to interrupt the in-flight run.
    if (commandsEnabled && isStopCommand(inbound.text)) {
      const running = this.activeRuns.get(baseThreadId);
      if (running) {
        running.abort();
        yield { type: 'delta', text: '已请求中止当前回复。' };
      } else {
        yield { type: 'delta', text: '当前没有正在进行的回复。' };
      }
      yield { type: 'done' };
      return;
    }

    const historySource = opts.historySource ?? defaultHistorySource(inbound.kind);
    const releaseConversation = await this.mutex.acquire(baseThreadId);
    const releaseGlobal = await this.semaphore.acquire();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort);
    try {
      const command = commandsEnabled ? matchCommand(inbound.text) : undefined;
      if (command) {
        const ctx: CommandContext = {
          inbound,
          ...(actor ? { actor } : {}),
          store: this.store,
          reset: () => this.resetConversation(channel, conversationId),
          modelLabel: () => this.modelLabel(inbound, opts),
        };
        const outcome = await command.run(ctx);
        yield* emitCommandOutcome(outcome);
        return;
      }

      const model = opts.model ?? await this.resolveModelFn(inbound, {
        ...(opts.targetSpace ? { targetSpace: opts.targetSpace } : {}),
        ...(opts.modelConfigId ? { modelConfigId: opts.modelConfigId } : {}),
      });
      if (!model) {
        yield { type: 'error', message: NO_MODEL_MESSAGE };
        return;
      }

      const epoch = await this.loadEpoch(baseThreadId);
      const effectiveConversationId = epochConversationId(conversationId, epoch);
      const messages = await this.buildMessages(historySource, inbound, opts, {
        channel,
        effectiveConversationId,
        ...(actor ? { actor } : {}),
      });

      const engine = this.engineFor(threadIdOf(channel, effectiveConversationId), model, {
        ...(opts.avatarId ? { avatarId: opts.avatarId } : {}),
        ...(opts.engine ? { engine: opts.engine } : {}),
      });
      const workspaceRoot = await this.ensureWorkspaceRoot(inbound, opts);

      this.activeRuns.set(baseThreadId, controller);
      try {
        yield* engine.reply(messages, opts.systemPrompt ?? this.systemPrompt, controller.signal, {
          conversationId: effectiveConversationId,
          source: channel,
          ...(actor ? { actor } : {}),
          ...(opts.confirm ? { confirm: opts.confirm } : {}),
          ...(opts.targetSpace ? { targetSpace: opts.targetSpace } : {}),
          ...(workspaceRoot ? { workspaceRoot } : {}),
          ...(opts.engine?.temporarySkillIds ? { temporarySkillIds: opts.engine.temporarySkillIds } : {}),
          ...(inbound.displayAttachments?.length ? { displayAttachments: inbound.displayAttachments } : {}),
        });
      } finally {
        if (this.activeRuns.get(baseThreadId) === controller) {
          this.activeRuns.delete(baseThreadId);
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onExternalAbort);
      releaseGlobal();
      releaseConversation();
    }
  }

  /**
   * Convenience wrapper: run `handle` and accumulate the streamed text into one
   * final string (the MVP IM strategy — buffer to final, then send). Surfaces
   * agent errors as the returned `error`.
   */
  async run(inbound: InboundMessage, opts: HandleOptions = {}): Promise<{ text: string; error?: string }> {
    const parts: string[] = [];
    let error: string | undefined;
    for await (const delta of this.handle(inbound, opts)) {
      if (delta.type === 'delta') {
        parts.push(delta.text);
      } else if (delta.type === 'space_result') {
        parts.push(`\n${delta.envelope.summary}`);
      } else if (delta.type === 'error') {
        error = delta.message;
        break;
      } else if (delta.type === 'done') {
        break;
      }
    }
    return { text: parts.join('').trim(), ...(error ? { error } : {}) };
  }

  /**
   * Outbound delivery: push a message to a conversation without an inbound
   * trigger (cron/task -> IM). Sending uses the channel's REST sender.
   */
  async deliver(target: OutboundTarget, content: string): Promise<SendResult> {
    const sender = this.senders.get(target.channel);
    if (!sender) {
      return { ok: false, error: `no_sender_for_channel:${target.channel}` };
    }
    return sender(target, content);
  }

  /**
   * Start a fresh context: bump the history epoch and drop cached engines. The
   * epoch is persisted to the base thread metadata so `/new` survives a worker
   * restart (in-memory-only would silently re-expose the old history).
   */
  async resetConversation(channel: string, conversationId: string): Promise<void> {
    const baseThreadId = threadIdOf(channel, conversationId);
    const next = (await this.loadEpoch(baseThreadId)) + 1;
    this.epochs.set(baseThreadId, next);
    await this.persistEpoch(baseThreadId, next);
    // Drop engines for both the prior effective id and the base id.
    for (const key of [...this.engines.keys()]) {
      if (key === baseThreadId || key.startsWith(`${baseThreadId}${EPOCH_SEPARATOR}`)) {
        this.engines.delete(key);
      }
    }
  }

  /** Resolve the current history epoch, reading the persisted value once. */
  private async loadEpoch(baseThreadId: string): Promise<number> {
    const cached = this.epochs.get(baseThreadId);
    if (cached !== undefined) {
      return cached;
    }
    let epoch = 0;
    if (this.store) {
      try {
        const thread = await this.store.threads.getThread(baseThreadId);
        const raw = thread?.metadata?.['historyEpoch'];
        if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
          epoch = Math.floor(raw);
        }
      } catch {
        // Best-effort: an unreadable store falls back to epoch 0.
      }
    }
    this.epochs.set(baseThreadId, epoch);
    return epoch;
  }

  /** Persist the history epoch onto the base thread's metadata (best-effort). */
  private async persistEpoch(baseThreadId: string, epoch: number): Promise<void> {
    if (!this.store) {
      return;
    }
    try {
      const existing = await this.store.threads.getThread(baseThreadId);
      const metadata = { ...(existing?.metadata ?? {}), historyEpoch: epoch };
      await this.store.threads.createThread(
        existing
          ? { ...existing, metadata }
          : { id: baseThreadId, avatarId: this.avatarId, status: 'active', metadata },
      );
    } catch {
      // Best-effort: the in-memory epoch still applies for this process lifetime.
    }
  }

  private async modelLabel(inbound: InboundMessage, opts: HandleOptions): Promise<string> {
    const model = await this.resolveModelFn(inbound, {
      ...(opts.targetSpace ? { targetSpace: opts.targetSpace } : {}),
      ...(opts.modelConfigId ? { modelConfigId: opts.modelConfigId } : {}),
    });
    return model ? model.displayName ?? model.model : '未配置';
  }

  private engineFor(
    threadId: string,
    model: CustomModelConfig,
    overrides: { avatarId?: string; engine?: EngineOverrides } = {},
  ): ChatEngine {
    // Per-run overrides (web: per-request avatar, tool/space/plan config, and
    // taskManager closures) are not safely shareable, so build a fresh engine
    // and skip the cache. Stable callers (IM/CLI/tasks) reuse a cached engine.
    if (overrides.avatarId || overrides.engine) {
      return this.buildEngine(model, overrides.avatarId ?? this.avatarId, overrides.engine);
    }
    const modelId = model.id ?? model.model;
    const cached = this.engines.get(threadId);
    if (cached && cached.modelId === modelId) {
      // Refresh LRU recency.
      this.engines.delete(threadId);
      this.engines.set(threadId, cached);
      return cached.engine;
    }
    const engine = this.buildEngine(model, this.avatarId);
    this.engines.set(threadId, { engine, modelId });
    if (this.engines.size > this.maxEngines) {
      const oldest = this.engines.keys().next().value;
      if (oldest !== undefined && oldest !== threadId) {
        this.engines.delete(oldest);
      }
    }
    return engine;
  }

  private buildEngine(model: CustomModelConfig, agentId: string, engine?: EngineOverrides): ChatEngine {
    // Prefer injecting the shared, process-level store so every engine reuses a
    // single PG pool (no per-engine/per-run pool leak in long-lived workers).
    // Defaults are seeded once at worker startup. Only when no shared store is
    // available (e.g. per-request web) do we fall back to the persistence path,
    // which opens its own pool and seeds defaults itself.
    const useSharedStore = this.store !== null;
    return new ChatEngine(model, useSharedStore ? undefined : this.persistence, {
      agent: { id: agentId, label: agentId },
      ...(useSharedStore ? { store: this.store } : {}),
      ...(engine?.disabledToolIds ? { disabledToolIds: engine.disabledToolIds } : {}),
      ...(engine?.allowedSpaceIds ? { allowedSpaceIds: engine.allowedSpaceIds } : {}),
      ...(engine?.disableAllTools ? { disableAllTools: engine.disableAllTools } : {}),
      ...(engine?.taskManager ? { taskManager: engine.taskManager } : {}),
    });
  }

  /** Assemble the message list per history policy. */
  private async buildMessages(
    historySource: HistorySource,
    inbound: InboundMessage,
    opts: HandleOptions,
    ctx: { channel: string; effectiveConversationId: string; actor?: ActorContext },
  ): Promise<Message[]> {
    if (historySource === 'caller') {
      // Legacy web: the transcript (including the new turn) is supplied as-is.
      return opts.messages ?? [];
    }
    const history = historySource === 'store' && this.store
      ? await loadHistory(this.store, {
          channel: ctx.channel,
          conversationId: ctx.effectiveConversationId,
          ...(ctx.actor ? { actor: ctx.actor } : {}),
          includeTools: opts.includeToolHistory ?? true,
        })
      : [];
    return [...history, messageFromInbound(inbound)];
  }

  private async ensureWorkspaceRoot(inbound: InboundMessage, opts: HandleOptions): Promise<string | undefined> {
    const explicit = opts.workspaceRoot?.trim();
    if (explicit) {
      return explicit;
    }
    // Web/CLI keep their existing behavior (engine derives web roots itself).
    if (inbound.channel === 'web' || inbound.channel === 'cli') {
      return undefined;
    }
    const root = resolveConversationWorkspaceRoot({
      conversationId: inbound.conversationId,
      baseRoot: process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? DEFAULT_FILE_WORKSPACE_ROOT,
    });
    await mkdir(root, { recursive: true });
    return root;
  }
}

function defaultHistorySource(kind: InboundMessage['kind']): HistorySource {
  return kind === 'schedule' ? 'none' : 'store';
}

async function* emitCommandOutcome(outcome: CommandOutcome): AsyncIterable<ChatDelta> {
  if (outcome.text) {
    yield { type: 'delta', text: outcome.text };
  }
  yield { type: 'done' };
}

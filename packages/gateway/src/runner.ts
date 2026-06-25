import { localDevActorContext, type ActorContext, type InboundMessage } from '@zleap/core';
import type { ConversationService, HandleOptions } from '@zleap/agent/conversation';
import { shouldAutoApproveToolWithoutHitl } from '@zleap/agent/engine';
import { buildInboundRunInput } from '@zleap/avatar';
import type { GatewayPermissionMode } from './config.js';
import type { GatewayLogger, PlatformAdapter, PlatformMessageEvent } from './types.js';

/**
 * IM channels have no interactive HITL surface, so a missing `confirm` would let
 * turnLoop execute high-risk tools unguarded (fail-open). Default to the same
 * safe policy scheduled tasks use: auto-approve no-risk tools, deny everything
 * that needs approval. `full_access` channels auto-approve every tool.
 */
const defaultGatewayConfirm: NonNullable<HandleOptions['confirm']> = async (request) =>
  shouldAutoApproveToolWithoutHitl(request.name);

const fullAccessConfirm: NonNullable<HandleOptions['confirm']> = async () => true;

export type GatewayRunnerDeps = {
  service: ConversationService;
  logger?: GatewayLogger;
  /** Zleap owner identity for gateway traffic. Defaults to the same local actor WebUI uses in dev. */
  actor?: ActorContext;
  /** Per-inbound run options (e.g. targetSpace). `confirm` is resolved per channel. */
  handleOptions?: HandleOptions;
};

/**
 * Wires platform adapters to the L2 ConversationService. Adapters only translate
 * platform events <-> the normalized contract; the runner owns the inbound->run->
 * reply->send loop and the per-channel outbound sender registration. Adapters are
 * attached/detached dynamically by the {@link ChannelSupervisor} so channels can
 * be enabled/disabled/reconfigured without a process restart.
 */
export class GatewayRunner {
  private readonly service: ConversationService;
  private readonly logger?: GatewayLogger;
  private readonly handleOptions: HandleOptions;
  private readonly actor: ActorContext;
  /** Per-channel tool-approval policy; defaults to request_approval. */
  private readonly permissions = new Map<string, GatewayPermissionMode>();

  constructor(deps: GatewayRunnerDeps) {
    this.service = deps.service;
    this.logger = deps.logger;
    this.actor = { ...(deps.actor ?? localDevActorContext()) };
    this.handleOptions = { ...(deps.handleOptions ?? {}) };
  }

  /** Set the tool-approval policy for a channel (called by the supervisor). */
  setPermission(channel: string, mode: GatewayPermissionMode): void {
    this.permissions.set(channel, mode);
  }

  /** Register an adapter's sender + handler and connect it. */
  async attach(adapter: PlatformAdapter): Promise<void> {
    this.service.outbound.register(adapter.channel, (target, content) => adapter.send(target, content));
    adapter.setMessageHandler((event) => this.onEvent(adapter, event));
    await adapter.connect();
    this.logger?.info('gateway channel started', { channel: adapter.channel });
  }

  /** Disconnect an adapter and drop its sender. */
  async detach(adapter: PlatformAdapter): Promise<void> {
    await adapter.disconnect().catch((error) => {
      this.logger?.warn('adapter disconnect failed', { channel: adapter.channel, error: errorMessage(error) });
    });
    this.service.outbound.unregister(adapter.channel);
    this.permissions.delete(adapter.channel);
    this.logger?.info('gateway channel stopped', { channel: adapter.channel });
  }

  private confirmFor(channel: string): NonNullable<HandleOptions['confirm']> {
    return this.permissions.get(channel) === 'full_access' ? fullAccessConfirm : defaultGatewayConfirm;
  }

  private async onEvent(adapter: PlatformAdapter, event: PlatformMessageEvent): Promise<void> {
    const inbound = toInbound(event, this.actor);
    try {
      await adapter.ack?.(event);
      const { text, error } = await this.service.run(inbound, {
        ...this.handleOptions,
        confirm: this.confirmFor(event.channel),
      });
      this.logger?.info('gateway run complete', {
        channel: event.channel,
        chars: text?.length ?? 0,
        ...(error ? { error } : {}),
      });
      const reply = error ? `⚠️ ${error}` : text;
      if (!reply) {
        this.logger?.warn('gateway produced empty reply', { channel: event.channel });
        return;
      }
      const result = await adapter.send(
        { channel: event.channel, conversationId: event.conversationId, ...(event.messageId ? { replyTo: event.messageId } : {}) },
        reply,
      );
      if (!result.ok) {
        this.logger?.warn('gateway reply send failed', { channel: event.channel, error: result.error });
      }
    } catch (error) {
      this.logger?.error('gateway event handling failed', { channel: event.channel, error: errorMessage(error) });
      // Best-effort: tell the user instead of leaving them with only the ack.
      await adapter
        .send(
          { channel: event.channel, conversationId: event.conversationId, ...(event.messageId ? { replyTo: event.messageId } : {}) },
          '⚠️ 处理消息时发生错误，请稍后重试。',
        )
        .catch((sendError) => {
          this.logger?.warn('gateway error-reply send failed', { channel: event.channel, error: errorMessage(sendError) });
        });
    }
  }
}

/** Map a normalized platform event into the L2 inbound contract. */
export function toInbound(event: PlatformMessageEvent, actor: ActorContext = localDevActorContext()): InboundMessage {
  // Gateway platform ids are transport identities, not Zleap owner ids. Until the
  // app has real multi-user login, gateway traffic should share the same local
  // actor as WebUI so memories, threads, tasks, and approvals stay in one owner
  // scope. Preserve platform ids only as metadata for attribution/audit.
  const inboundRun = buildInboundRunInput({
    actorId: actor.userId,
    eventId: event.eventId ?? event.messageId ?? event.conversationId,
    prompt: event.text,
  });
  return {
    channel: event.channel,
    conversationId: event.conversationId,
    kind: 'im',
    text: inboundRun.prompt,
    actor: { ...actor },
    ...(event.messageId ? { replyTo: event.messageId } : {}),
    metadata: {
      chatType: event.chatType,
      mentionsBot: event.mentionsBot ?? false,
      ...(event.userId ? { senderId: `${event.channel}:${event.userId}` } : {}),
      ...(event.tenantId ? { platformTenantId: `${event.channel}:${event.tenantId}` } : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

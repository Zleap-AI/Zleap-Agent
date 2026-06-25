import { redactMcpServerRecord, type McpServerRecord, type SecretRef } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse, createMcpServer, ensureAvatar } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ servers: [], persistence: { enabled: false, reachable: false } });
  }
  try {
    const servers = await store.mcp.listServers({ userId: actor.userId, tenantId: actor.tenantId });
    return Response.json({ servers: servers.map(redactMcpServerRecord), persistence: { enabled: true, reachable: true } });
  } finally {
    await store.close().catch(() => {});
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      transport?: string;
      config?: Record<string, unknown>;
      secretRefs?: SecretRef[];
      status?: McpServerRecord['status'];
      bindToSpaceId?: string;
      avatarId?: string;
    };
    if (!body.id?.trim() || !body.name?.trim()) {
      return Response.json({ error: 'id_and_name_required' }, { status: 400 });
    }
    if (body.transport !== 'stdio' && body.transport !== 'sse' && body.transport !== 'http') {
      return Response.json({ error: 'invalid_transport' }, { status: 400 });
    }
    if (body.status && body.status !== 'active' && body.status !== 'disabled' && body.status !== 'error') {
      return Response.json({ error: 'invalid_status' }, { status: 400 });
    }
    await ensureAvatar(store, body.avatarId);
    const { server, discovery } = await createMcpServer(store, {
      id: body.id.trim(),
      userId: actor.userId,
      tenantId: actor.tenantId,
      name: body.name.trim(),
      transport: body.transport,
      config: body.config,
      secretRefs: body.secretRefs,
      status: body.status,
      bindToSpaceId: body.bindToSpaceId,
    });
    return Response.json({ server: redactMcpServerRecord(server), discovery }, { status: 201 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      transport?: string;
      config?: Record<string, unknown>;
      secretRefs?: SecretRef[];
      status?: McpServerRecord['status'];
    };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const existing = await store.mcp.getServer(id, { userId: actor.userId, tenantId: actor.tenantId });
    if (!existing) {
      return Response.json({ error: 'mcp_server_not_found' }, { status: 404 });
    }
    const name = body.name?.trim() || existing.name;
    const transport = body.transport ?? existing.transport;
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      return Response.json({ error: 'invalid_transport' }, { status: 400 });
    }
    if (body.status && body.status !== 'active' && body.status !== 'disabled' && body.status !== 'error') {
      return Response.json({ error: 'invalid_status' }, { status: 400 });
    }
    const config = normalizeServerConfigForUpdate(existing, transport, body.config);
    if (transport === 'stdio' && typeof config.command !== 'string') {
      return Response.json({ error: 'command_required' }, { status: 400 });
    }
    if (transport !== 'stdio' && typeof config.url !== 'string') {
      return Response.json({ error: 'url_required' }, { status: 400 });
    }
    const now = new Date();
    const server: McpServerRecord = {
      ...existing,
      name,
      transport,
      config,
      secretRefs: body.secretRefs ?? existing.secretRefs,
      status: body.status ?? existing.status,
      updatedAt: now,
    };
    await store.transaction(async (tx) => {
      await tx.mcp.saveServer(server);
      await tx.spaces.saveCapability({
        id: server.id,
        type: 'mcp_server',
        version: 1,
        origin: 'mcp',
        label: server.name,
        description: `MCP server (${server.transport})`,
        descriptor: { transport: server.transport, status: server.status, hasSecrets: Boolean(server.secretRefs?.length) },
        implementationRef: `mcp:${server.id}`,
        createdAt: existing.createdAt,
      });
    });
    return Response.json({ server: redactMcpServerRecord(server) });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const existing = await store.mcp.getServer(id, { userId: actor.userId, tenantId: actor.tenantId });
    if (!existing) {
      return Response.json({ error: 'mcp_server_not_found' }, { status: 404 });
    }
    await store.mcp.deleteServer(id, { userId: actor.userId, tenantId: actor.tenantId });
    return Response.json({ ok: true });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

function normalizeServerConfigForUpdate(
  existing: McpServerRecord,
  transport: McpServerRecord['transport'],
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (transport === 'stdio') {
    const command = typeof incoming?.command === 'string' && incoming.command.trim() ? incoming.command.trim() : readStringConfig(existing.config, 'command');
    const args = Array.isArray(incoming?.args) ? incoming.args.filter((arg): arg is string => typeof arg === 'string' && Boolean(arg.trim())) : readStringArrayConfig(existing.config, 'args');
    const config: Record<string, unknown> = { command, args };
    if (hasOwn(incoming, 'env')) {
      const env = incoming.env;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        config.env = env;
      }
    } else if (existing.transport === 'stdio' && existing.config && hasOwn(existing.config, 'env')) {
      config.env = existing.config.env;
    }
    return config;
  }
  const url = typeof incoming?.url === 'string' && incoming.url.trim() ? incoming.url.trim() : readStringConfig(existing.config, 'url');
  return { url };
}

function readStringConfig(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArrayConfig(config: Record<string, unknown> | undefined, key: string): string[] {
  const value = config?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function hasOwn(value: unknown, key: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
}

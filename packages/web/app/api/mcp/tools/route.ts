import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse, ensureAvatar, registerMcpTool } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ tools: [], persistence: { enabled: false, reachable: false } });
  }
  try {
    const url = new URL(req.url);
    const serverId = url.searchParams.get('serverId') ?? undefined;
    const visibleServers = serverId
      ? (await store.mcp.getServer(serverId, { userId: actor.userId, tenantId: actor.tenantId }))
        ? [serverId]
        : []
      : (await store.mcp.listServers({ userId: actor.userId, tenantId: actor.tenantId })).map((server) => server.id);
    const tools = (await Promise.all(visibleServers.map((id) => store.mcp.listTools({ serverId: id })))).flat();
    return Response.json({ tools, persistence: { enabled: true, reachable: true } });
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
      serverId?: string;
      name?: string;
      version?: number;
      label?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      bindToSpaceId?: string;
      avatarId?: string;
    };
    if (!body.serverId?.trim() || !body.name?.trim()) {
      return Response.json({ error: 'serverId_and_name_required' }, { status: 400 });
    }
    await ensureAvatar(store, body.avatarId);
    const tool = await registerMcpTool(store, {
      id: body.id?.trim() || undefined,
      serverId: body.serverId.trim(),
      userId: actor.userId,
      tenantId: actor.tenantId,
      name: body.name.trim(),
      version: body.version,
      label: body.label,
      description: body.description,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
      bindToSpaceId: body.bindToSpaceId,
    });
    return Response.json({ tool }, { status: 201 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

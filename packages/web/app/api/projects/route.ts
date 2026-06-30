import { mkdir } from 'node:fs/promises';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { projectStore } from '../../../lib/server/projectStore';
import { resolveBrowsePath } from '../../../lib/server/projectPaths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const projects = await projectStore.list();
  return Response.json({ projects });
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      path?: string;
      note?: string;
      createPath?: boolean;
    };
    if (!body.id?.trim() || !body.name?.trim() || !body.path?.trim()) {
      return Response.json({ error: 'id_name_path_required' }, { status: 400 });
    }
    const path = resolveBrowsePath(body.path.trim());
    if (body.createPath) {
      await mkdir(path, { recursive: true });
    }
    const project = await projectStore.create({
      id: body.id.trim(),
      name: body.name.trim(),
      path,
      note: body.note?.trim() || undefined,
    });
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      path?: string;
      note?: string;
      spec?: string;
      emoji?: string;
      accent?: string;
    };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const emojiRaw = body.emoji;
    const project = await projectStore.update(body.id.trim(), {
      name: body.name?.trim(),
      path: body.path?.trim(),
      note: body.note,
      spec: body.spec,
      ...(emojiRaw !== undefined
        ? { emoji: emojiRaw.trim() ? emojiRaw.trim() : undefined }
        : {}),
      ...(body.accent !== undefined ? { accent: body.accent } : {}),
    });
    return Response.json({ project });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await projectStore.remove(body.id.trim());
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../../lib/server/avatarStore';
import { readSkillPackageTextFile, writeSkillPackageTextFile } from '../../../../../lib/server/skillMutations';
import { skillView } from '../../../../../lib/server/skillView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const version = readVersion(url.searchParams.get('version'));
    const skill = await store.skills.getSkill(id, version);
    if (!skill) {
      return Response.json({ error: 'skill_not_found' }, { status: 404 });
    }
    const path = url.searchParams.get('path');
    if (!path) {
      return Response.json({ files: skill.files ?? [] });
    }
    const file = await readSkillPackageTextFile(skill, path);
    return Response.json(file);
  } catch (error) {
    return skillFileErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string; version?: number };
    const skill = await store.skills.getSkill(id, body.version);
    if (!skill) {
      return Response.json({ error: 'skill_not_found' }, { status: 404 });
    }
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'skill_file_content_required' }, { status: 400 });
    }
    const result = await writeSkillPackageTextFile(store, skill, body.path, body.content);
    return Response.json({ path: result.path, content: result.content, skill: skillView(result.skill) });
  } catch (error) {
    return skillFileErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

function readVersion(value: string | null): number | undefined {
  if (!value) return undefined;
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function skillFileErrorResponse(error: unknown): Response {
  if (error instanceof Error) {
    if (
      error.message === 'skill_package_root_required' ||
      error.message === 'skill_file_path_required' ||
      error.message === 'skill_file_path_forbidden' ||
      error.message === 'skill_file_not_text_readable' ||
      error.message === 'skill_file_not_text_writable'
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }
  return avatarErrorResponse(error);
}

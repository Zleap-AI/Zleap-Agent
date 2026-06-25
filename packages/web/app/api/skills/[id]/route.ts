import type { SkillInvocationPolicy, SkillTrustStatus } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { deleteSkillRecord, updateSkillRecord } from '../../../../lib/server/skillMutations';
import { skillView } from '../../../../lib/server/skillView';

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
    return Response.json({ skill: skillView(skill) });
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
    const body = (await req.json().catch(() => ({}))) as {
      version?: number;
      label?: string;
      description?: string;
      instructions?: string;
      toolIds?: string[];
      allowedTools?: string[];
      disallowedTools?: string[];
      invocationPolicy?: SkillInvocationPolicy;
      trustStatus?: SkillTrustStatus;
      bindToSpaceId?: string;
    };
    const skill = await updateSkillRecord(store, { ...body, id });
    return Response.json({ skill: skillView(skill) });
  } catch (error) {
    return skillMutationErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const { id } = await params;
    const url = new URL(req.url);
    await deleteSkillRecord(store, id, readVersion(url.searchParams.get('version')));
    return Response.json({ ok: true });
  } catch (error) {
    return skillMutationErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

function readVersion(value: string | null): number | undefined {
  if (!value) return undefined;
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function skillMutationErrorResponse(error: unknown): Response {
  if (error instanceof Error && error.message === 'skill_not_found') {
    return Response.json({ error: 'skill_not_found' }, { status: 404 });
  }
  return avatarErrorResponse(error);
}

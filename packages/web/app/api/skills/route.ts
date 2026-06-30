import type { SkillSourceType, SkillTrustStatus } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { avatarErrorResponse, createSkill, ensureAvatar } from '../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import {
  deleteSkillRecord,
  importSkillPackage,
  normalizeSourceType,
  normalizeTrustStatus,
  updateSkillRecord,
  type UpdateSkillInput,
} from '../../../lib/server/skillMutations';
import { skillView } from '../../../lib/server/skillView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ skills: [], persistence: { enabled: false, reachable: false } });
  }
  try {
    const url = new URL(req.url);
    const sourceType = normalizeSourceType(url.searchParams.get('sourceType'));
    const trustStatus = normalizeTrustStatus(url.searchParams.get('trustStatus'));
    const skills = await store.skills.listSkills({ sourceType, trustStatus });
    return Response.json({ skills: skills.map(skillView), persistence: { enabled: true, reachable: true } });
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
      label?: string;
      description?: string;
      instructions?: string;
      toolIds?: string[];
      skillMd?: string;
      packageRoot?: string;
      sourcePath?: string;
      sourceType?: SkillSourceType;
      openaiYaml?: string;
      trustStatus?: SkillTrustStatus;
      bindToSpaceId?: string;
      avatarId?: string;
    };
    if (body.skillMd?.trim() || body.packageRoot?.trim() || body.sourcePath?.trim()) {
      const skill = await importSkillPackage(store, {
        root: body.packageRoot ?? body.sourcePath,
        skillMd: body.skillMd,
        openaiYaml: body.openaiYaml,
        sourceType: body.sourceType,
        trustStatus: body.trustStatus,
        bindToSpaceId: body.bindToSpaceId,
        avatarId: body.avatarId,
      });
      return Response.json({ skill: skillView(skill) }, { status: 201 });
    }
    if (!body.id?.trim() || !body.label?.trim()) {
      return Response.json({ error: 'id_and_label_required' }, { status: 400 });
    }
    await ensureAvatar(store, body.avatarId);
    const skill = await createSkill(store, {
      id: body.id.trim(),
      label: body.label.trim(),
      description: body.description,
      instructions: body.instructions,
      toolIds: body.toolIds ?? [],
      bindToSpaceId: body.bindToSpaceId,
    });
    return Response.json({ skill: skillView(skill) }, { status: 201 });
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
    const body = (await req.json().catch(() => ({}))) as UpdateSkillInput;
    const skill = await updateSkillRecord(store, body);
    return Response.json({ skill: skillView(skill) });
  } catch (error) {
    return skillMutationErrorResponse(error);
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
    const body = (await req.json().catch(() => ({}))) as { id?: string; version?: number };
    const id = body.id?.trim();
    if (!id) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await deleteSkillRecord(store, id, body.version);
    return Response.json({ ok: true });
  } catch (error) {
    return skillMutationErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

function skillMutationErrorResponse(error: unknown): Response {
  if (error instanceof Error && error.message === 'skill_not_found') {
    return Response.json({ error: 'skill_not_found' }, { status: 404 });
  }
  return avatarErrorResponse(error);
}

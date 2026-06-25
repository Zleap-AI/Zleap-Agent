import type { SkillSourceType, SkillTrustStatus } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { importSkillPackage } from '../../../../lib/server/skillMutations';
import { skillView } from '../../../../lib/server/skillView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ error: 'database_required' }, { status: 503 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      root?: string;
      skillMd?: string;
      openaiYaml?: string;
      sourceType?: SkillSourceType;
      trustStatus?: SkillTrustStatus;
      bindToSpaceId?: string;
      avatarId?: string;
    };
    const skill = await importSkillPackage(store, body);
    return Response.json({ skill: skillView(skill) }, { status: 201 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

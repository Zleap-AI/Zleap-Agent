import type { SkillInvocationPolicy } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { avatarErrorResponse, ensureAvatar } from '../../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../../lib/server/avatarStore';
import { SkillMarketplaceError, importMarketplaceSkill } from '../../../../../lib/server/skillMarketplace';
import { skillView } from '../../../../../lib/server/skillView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  if (!store) {
    return Response.json(
      {
        error: 'database_required',
        message: '技能需要数据库才能保存。请用 pnpm dev:web 启动 WebUI，或配置 ZLEAP_DATABASE_URL 后重启。',
      },
      { status: 503 },
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      avatarId?: string;
      root?: string;
      invocationPolicy?: SkillInvocationPolicy;
    };
    await ensureAvatar(store, body.avatarId);
    const result = await importMarketplaceSkill(store, {
      id: body.id ?? '',
      root: body.root,
      invocationPolicy: body.invocationPolicy,
    });
    return Response.json({ skill: skillView(result.skill), packageRoot: result.packageRoot, detail: result.detail }, { status: 201 });
  } catch (error) {
    if (error instanceof SkillMarketplaceError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

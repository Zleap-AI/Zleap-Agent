import { defaultSkillSourceRoots, scanSkillSourceRoot, type SkillSourceRoot } from '@zleap/core/skill-sources';
import { skillRecordFromPackageManifest } from '@zleap/core/skill-package';
import type { SkillSourceType, SkillTrustStatus } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { avatarErrorResponse, ensureAvatar, saveSkillRecord } from '../../../../lib/server/avatarContext';
import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { defaultSkillsRoot } from '../../../../lib/server/projectPaths';
import { normalizeSourceType, normalizeTrustStatus } from '../../../../lib/server/skillMutations';
import { skillView } from '../../../../lib/server/skillView';

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
      roots?: Array<{ root?: string; sourceType?: SkillSourceType }>;
      projectRoot?: string;
      homeDir?: string;
      includeAdmin?: boolean;
      zleapSkillsRoot?: string;
      trustStatus?: SkillTrustStatus;
      bindToSpaceId?: string;
      avatarId?: string;
    };
    await ensureAvatar(store, body.avatarId);
    const roots = normalizeRoots(body.roots) ?? defaultSkillSourceRoots({
      projectRoot: cleanOptional(body.projectRoot),
      homeDir: cleanOptional(body.homeDir),
      includeAdmin: body.includeAdmin === true,
      zleapSkillsRoot: cleanOptional(body.zleapSkillsRoot) ?? defaultSkillsRoot(),
    });
    const trustStatus = normalizeTrustStatus(body.trustStatus);
    const imported = [];
    const errors = [];
    for (const root of roots) {
      const results = await scanSkillSourceRoot(root, { trustStatus });
      for (const result of results) {
        if (result.ok) {
          const skill = await saveSkillRecord(
            store,
            skillRecordFromPackageManifest(result.manifest, { origin: root.sourceType === 'project' ? 'project' : 'user', sourceType: root.sourceType }),
            body.bindToSpaceId,
          );
          imported.push(skillView(skill));
        } else {
          errors.push(result);
        }
      }
    }
    return Response.json({ skills: imported, errors, scannedRoots: roots }, { status: 200 });
  } catch (error) {
    return avatarErrorResponse(error);
  } finally {
    await store.close().catch(() => {});
  }
}

function normalizeRoots(values: Array<{ root?: string; sourceType?: SkillSourceType }> | undefined): SkillSourceRoot[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const roots = values
    .map((value) => ({ root: value.root?.trim() ?? '', sourceType: normalizeSourceType(value.sourceType) }))
    .filter((value): value is SkillSourceRoot => Boolean(value.root && value.sourceType));
  return roots.length ? roots : undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

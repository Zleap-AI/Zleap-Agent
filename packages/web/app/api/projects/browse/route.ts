import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { browseDirectories, DEFAULT_PROJECTS_ROOT, defaultSkillsRoot } from '../../../../lib/server/projectPaths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List child directories for the project folder picker (server-side, home-scoped). */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const preset = url.searchParams.get('preset');
  const presetPath = preset === 'skills' ? defaultSkillsRoot() : homedir();
  const path = url.searchParams.get('path') ?? presetPath;
  try {
    await mkdir(DEFAULT_PROJECTS_ROOT, { recursive: true });
    if (preset === 'skills' && !url.searchParams.has('path')) {
      await mkdir(presetPath, { recursive: true });
    }
    const result = await browseDirectories(path);
    return Response.json({ root: DEFAULT_PROJECTS_ROOT, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

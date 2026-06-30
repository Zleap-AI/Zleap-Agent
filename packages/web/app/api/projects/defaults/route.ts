import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { DEFAULT_PROJECTS_ROOT } from '../../../../lib/server/projectPaths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  await mkdir(DEFAULT_PROJECTS_ROOT, { recursive: true });
  return Response.json({ root: DEFAULT_PROJECTS_ROOT, home: homedir() });
}

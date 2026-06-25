import { isActorResponse, requireHttpActor } from '../../../../../lib/server/actor';
import { actorToTaskActor, taskRunToJson, withTaskService } from '../../../../../lib/server/taskService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  try {
    const { id } = await context.params;
    const url = new URL(req.url);
    const limit = numberParam(url.searchParams.get('limit'), 5);
    const offset = numberParam(url.searchParams.get('offset'), 0);
    const runs = await withTaskService(async (service) => service.listRuns(actorToTaskActor(actor), id, { limit, offset }));
    return Response.json({ runs: runs.map(taskRunToJson) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function numberParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

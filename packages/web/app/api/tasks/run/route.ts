import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { actorToTaskActor, taskRunToJson, taskToJson, withTaskService } from '../../../../lib/server/taskService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const result = await withTaskService(async (service) => service.runNow(actorToTaskActor(actor), body.id!.trim()));
    return Response.json({ task: taskToJson(result.task), run: taskRunToJson(result.run) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

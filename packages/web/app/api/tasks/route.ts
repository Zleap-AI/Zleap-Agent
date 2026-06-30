import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { actorToTaskActor, isVisibleTaskInList, taskDefaultsFromBody, taskToJson, withTaskService } from '../../../lib/server/taskService';
import { DEFAULT_AVATAR_ID, type ScheduledTaskRecord } from '@zleap/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const url = new URL(req.url);
  const all = url.searchParams.get('all') === '1';
  const taskActor = actorToTaskActor(actor);
  const enriched = await withTaskService(async (service) => {
    const tasks = await service.listTasks(taskActor, { all });
    const visibleTasks = all ? tasks : tasks.filter(isVisibleTaskInList);
    return Promise.all(visibleTasks.map(async (task: ScheduledTaskRecord) => taskToJson(task, await service.listRuns(taskActor, task.id, { limit: 5 }))));
  });
  return Response.json({ tasks: enriched });
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as {
      name?: string;
      cron?: string;
      prompt?: string;
      timezone?: string | null;
      enabled?: boolean;
      avatarId?: string | null;
      projectId?: string | null;
      conversationId?: string | null;
      modelId?: string | null;
      permissionMode?: unknown;
      targetSpace?: string | null;
    };
    if (!body.cron?.trim() || !body.prompt?.trim()) {
      return Response.json({ error: 'cron_prompt_required' }, { status: 400 });
    }
    const name = body.name?.trim() || 'Task';
    const task = await withTaskService(async (service) =>
      service.createTask(
        actorToTaskActor(actor),
        {
          name,
          cron: body.cron!.trim(),
          prompt: body.prompt!.trim(),
          timezone: body.timezone,
          enabled: body.enabled,
          avatarId: body.avatarId,
          projectId: body.projectId,
          conversationId: body.conversationId,
          modelConfigId: body.modelId,
          permissionMode: normalizeTaskPermissionMode(body.permissionMode),
          targetSpace: body.targetSpace,
        },
        taskDefaultsFromBody(body, DEFAULT_AVATAR_ID),
      ),
    );
    return Response.json({ task: taskToJson(task) }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      cron?: string;
      prompt?: string;
      timezone?: string | null;
      enabled?: boolean;
      avatarId?: string | null;
      projectId?: string | null;
      conversationId?: string | null;
      modelId?: string | null;
      permissionMode?: unknown;
      targetSpace?: string | null;
    };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    const task = await withTaskService(async (service) => service.updateTask(actorToTaskActor(actor), body.id!.trim(), {
      name: body.name?.trim(),
      cron: body.cron?.trim(),
      prompt: body.prompt?.trim(),
      timezone: body.timezone,
      enabled: body.enabled,
      avatarId: body.avatarId,
      projectId: body.projectId,
      conversationId: body.conversationId,
      modelConfigId: body.modelId,
      permissionMode: normalizeTaskPermissionMode(body.permissionMode),
      targetSpace: body.targetSpace,
    }));
    return Response.json({ task: taskToJson(task) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function normalizeTaskPermissionMode(value: unknown): 'request_approval' | 'full_access' | undefined {
  if (value === 'full_access' || value === 'request_approval') return value;
  return undefined;
}

export async function DELETE(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await withTaskService(async (service) => service.deleteTask(actorToTaskActor(actor), body.id!.trim()));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

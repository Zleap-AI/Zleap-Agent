import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { storeFromEnv } from '../../../lib/server/avatarStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;

  const persistenceEnabled = Boolean(process.env.ZLEAP_DATABASE_URL);
  let persistenceReachable = false;
  let persistenceError: string | undefined;
  try {
    const store = await storeFromEnv();
    persistenceReachable = Boolean(store);
    await store?.close().catch(() => undefined);
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : String(error);
  }

  const degraded = persistenceEnabled && !persistenceReachable;
  return Response.json(
    {
      status: degraded ? 'degraded' : 'ok',
      persistence: {
        enabled: persistenceEnabled,
        reachable: persistenceReachable,
        ...(persistenceError ? { error: 'persistence_health_failed' } : {}),
      },
      checkedAt: new Date().toISOString(),
    },
    { status: degraded ? 503 : 200 },
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Unauthenticated liveness probe for `zleap status`, desktop shell, and load balancers. */
export async function GET(): Promise<Response> {
  return Response.json(
    {
      status: 'ok',
      service: 'zleap-web',
      checkedAt: new Date().toISOString(),
    },
    { status: 200 },
  );
}

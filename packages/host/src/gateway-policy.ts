import pg from 'pg';

/** Whether the IM gateway worker should start for this serve session. */
export async function shouldStartGateway(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.ZLEAP_GATEWAY === '1') {
    return true;
  }
  if (env.ZLEAP_GATEWAY === '0') {
    return false;
  }

  const databaseUrl = env.ZLEAP_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    return false;
  }

  try {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const result = await client.query<{ enabled: boolean }>(
      `SELECT 1 FROM gateway_integrations
       WHERE COALESCE((config->>'enabled')::boolean, false) = true
       LIMIT 1`,
    );
    await client.end();
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

import pg from 'pg';
import { buildServeEnv } from './env.js';
import { compareVersions } from './app-layout.js';
import type { AppMetadata } from './upgrade.js';

export type RuntimeUpdatePolicy = {
  allowDowngrade?: boolean;
  allowSchemaDowngrade?: boolean;
};

export type ActiveTaskPreflightOptions = {
  databaseUrl?: string;
  ignoreActiveTasks?: boolean;
  clientFactory?: (databaseUrl: string) => ActiveTaskClient;
};

export type ActiveTaskPreflightResult =
  | { checked: true; active: false; detail: string }
  | { checked: true; active: true; detail: string; count: number }
  | { checked: false; active: false; detail: string };

type ActiveTaskClient = {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};

export function assertRuntimeUpdateAllowed(
  current: AppMetadata | undefined,
  next: Pick<AppMetadata, 'version' | 'schemaVersion'>,
  policy: RuntimeUpdatePolicy = {},
): void {
  if (current?.version && compareVersions(next.version, current.version) < 0 && !allowDowngrade(policy)) {
    throw new Error(`Refusing to downgrade runtime from ${current.version} to ${next.version}`);
  }

  const currentSchema = numberOrUndefined(current?.schemaVersion);
  const nextSchema = numberOrUndefined(next.schemaVersion);
  if (
    currentSchema !== undefined &&
    nextSchema !== undefined &&
    nextSchema < currentSchema &&
    !allowSchemaDowngrade(policy)
  ) {
    throw new Error(`Refusing schema downgrade from ${currentSchema} to ${nextSchema}`);
  }
}

export async function assertNoActiveTaskRuns(
  options: ActiveTaskPreflightOptions = {},
): Promise<ActiveTaskPreflightResult> {
  if (options.ignoreActiveTasks || process.env.ZLEAP_IGNORE_ACTIVE_TASKS === '1') {
    return { checked: false, active: false, detail: 'active task preflight skipped' };
  }

  const databaseUrl = options.databaseUrl ?? buildServeEnv().ZLEAP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    return { checked: false, active: false, detail: 'database url not configured' };
  }

  const client = options.clientFactory?.(databaseUrl) ?? new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT status, COUNT(*)::int AS count
         FROM scheduled_task_runs
        WHERE status = ANY($1)
        GROUP BY status`,
      [['queued', 'running']],
    );
    const counts = result.rows.map((row) => ({
      status: String(row.status),
      count: Number(row.count) || 0,
    }));
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    if (total > 0) {
      const detail = counts.map((row) => `${row.status}:${row.count}`).join(', ');
      throw new Error(`Refusing runtime update while scheduled tasks are active (${detail})`);
    }
    return { checked: true, active: false, detail: 'no queued/running scheduled tasks' };
  } catch (error) {
    if (isMissingTableError(error)) {
      return { checked: false, active: false, detail: 'scheduled_task_runs table not found' };
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function allowDowngrade(policy: RuntimeUpdatePolicy = {}): boolean {
  return policy.allowDowngrade === true || process.env.ZLEAP_ALLOW_DOWNGRADE === '1';
}

export function allowSchemaDowngrade(policy: RuntimeUpdatePolicy = {}): boolean {
  return policy.allowSchemaDowngrade === true || process.env.ZLEAP_ALLOW_SCHEMA_DOWNGRADE === '1';
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMissingTableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '42P01';
}

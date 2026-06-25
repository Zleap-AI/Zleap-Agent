import pg from 'pg';
import { schemaSql } from './schema.js';
import type { StoreConfig } from './store.js';

const { Pool } = pg;

const APP_TABLES = [
  'avatars',
  'avatar_versions',
  'spaces',
  'space_versions',
  'capability_definitions',
  'space_capability_bindings',
  'skill_definitions',
  'model_configs',
  'mcp_servers',
  'mcp_tool_definitions',
  'scheduled_tasks',
  'scheduled_task_runs',
  'threads',
  'space_sessions',
  'session_entries',
  'session_leafs',
  'runs',
  'works',
  'work_steps',
  'tool_calls',
  'artifacts',
  'artifact_references',
  'capability_snapshots',
  'ledger_events',
  'outbox',
  'sessions',
  'session_runs',
  'agent_memory',
  'source_group',
  'source',
  'event',
  'entity',
  'event_entity',
] as const;

export type ResetDurableStoreDataResult = {
  tablesCleared: number;
};

export async function resetDurableStoreData(config: StoreConfig): Promise<ResetDurableStoreDataResult> {
  const pool = new Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query(schemaSql(config.dimension));
    const existing = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [[...APP_TABLES]],
    );
    const tables = existing.rows.map((row) => row.tablename);
    if (tables.length === 0) {
      return { tablesCleared: 0 };
    }
    await pool.query(`TRUNCATE TABLE ${tables.map(quoteIdentifier).join(', ')} RESTART IDENTITY CASCADE`);
    return { tablesCleared: tables.length };
  } finally {
    await pool.end().catch(() => {});
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

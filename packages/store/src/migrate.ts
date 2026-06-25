import pg from 'pg';
import { schemaSql } from './schema.js';

const { Pool } = pg;

/**
 * Apply the schema to the database in DATABASE_URL (or argv[2]).
 * Dimension comes from ZLEAP_EMBED_DIM (default 1536).
 *
 *   DATABASE_URL=postgres://... ZLEAP_EMBED_DIM=1536 pnpm --filter @zleap/store migrate
 */
async function main(): Promise<void> {
  const connectionString = process.argv[2] ?? process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('Usage: DATABASE_URL=postgres://… migrate  (or pass the URL as the first arg)\n');
    process.exitCode = 1;
    return;
  }
  const dimension = Number(process.env.ZLEAP_EMBED_DIM ?? 1536);
  const pool = new Pool({ connectionString });
  try {
    await pool.query(schemaSql(dimension));
    process.stdout.write(`Migrated schema (embedding dimension ${dimension}).\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

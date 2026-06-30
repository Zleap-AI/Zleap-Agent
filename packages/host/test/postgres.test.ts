import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '../src/constants.js';
import { isManagedLocalDatabaseUrl } from '../src/postgres.js';

describe('postgres bootstrap', () => {
  it('treats the default database url as managed local Postgres', () => {
    expect(isManagedLocalDatabaseUrl(DEFAULT_DATABASE_URL)).toBe(true);
    expect(isManagedLocalDatabaseUrl('postgres://zleap:zleap@localhost:5433/zleap')).toBe(true);
    expect(isManagedLocalDatabaseUrl('postgresql://zleap:zleap@127.0.0.1:5433/zleap')).toBe(true);
  });

  it('does not treat custom database urls as managed local Postgres', () => {
    expect(isManagedLocalDatabaseUrl('postgres://zleap:zleap@127.0.0.1:5432/zleap')).toBe(false);
    expect(isManagedLocalDatabaseUrl('postgres://zleap:zleap@db.example.test:5433/zleap')).toBe(false);
    expect(isManagedLocalDatabaseUrl('postgres://other:secret@127.0.0.1:5433/zleap')).toBe(false);
  });
});

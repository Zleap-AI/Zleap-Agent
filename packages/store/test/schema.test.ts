import { describe, expect, it } from 'vitest';
import { schemaSql } from '../src/schema.js';

describe('schemaSql', () => {
  it('includes the super-agent configuration and runtime backbone', () => {
    const sql = schemaSql(64);

    for (const table of [
      'avatars',
      'avatar_versions',
      'spaces',
      'space_versions',
      'capability_definitions',
      'space_capability_bindings',
      'skill_definitions',
      'mcp_servers',
      'mcp_tool_definitions',
      'threads',
      'space_sessions',
      'session_entries',
      'runs',
      'works',
      'work_steps',
      'tool_calls',
      'artifacts',
      'artifact_references',
      'capability_snapshots',
      'ledger_events',
      'outbox',
      'agent_memory',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('models the A-line agent_memory notes table with kind-scoped indexes', () => {
    const sql = schemaSql(64);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_memory');
    expect(sql).toContain('subject     text NOT NULL DEFAULT');
    expect(sql).toContain('ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS subject');
    expect(sql).toContain('agent_memory_impression_idx');
    expect(sql).toContain('agent_memory_experience_idx');
    expect(sql).toContain("WHERE kind = 'impression'");
    expect(sql).toContain("WHERE kind = 'experience'");
  });

  it('embeds the B-line core event-graph tables with the matching vector dimension', () => {
    const sql = schemaSql(96);

    for (const table of ['source_group', 'source', 'event', 'entity', 'event_entity']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('source_scope_idx');
    expect(sql).toContain('event_hash_idx');
    expect(sql).toContain('event_embedding_idx');
    expect(sql).toContain('event_search_idx');
    expect(sql).toContain('UNIQUE (source_id, type, normalized_name)');
    expect(sql).toContain('embedding    vector(96)');
  });

  it('models SpaceSession isolation and capability binding constraints', () => {
    const sql = schemaSql(32);

    expect(sql).toContain('ALTER TABLE threads ADD COLUMN IF NOT EXISTS user_id text');
    expect(sql).toContain('ALTER TABLE threads ADD COLUMN IF NOT EXISTS tenant_id text');
    expect(sql).toContain('threads_owner_idx');
    expect(sql).toContain('ALTER TABLE space_sessions ADD COLUMN IF NOT EXISTS user_id text');
    expect(sql).toContain('ALTER TABLE space_sessions ADD COLUMN IF NOT EXISTS tenant_id text');
    expect(sql).toContain('space_sessions_owner_idx');
    expect(sql).toContain('space_sessions_one_main_idx');
    expect(sql).toContain("WHERE kind = 'main'");
    // At most one active space per slug — duplicate 'main' is an impossible write.
    expect(sql).toContain('spaces_active_slug_idx');
    expect(sql).toContain('UNIQUE (space_id, space_version, capability_type, capability_id)');
    expect(sql).toContain('PRIMARY KEY (type, id, version)');
  });

  it('models actor ownership for MCP servers', () => {
    const sql = schemaSql(32);

    expect(sql).toContain('ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS user_id text');
    expect(sql).toContain('ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tenant_id text');
    expect(sql).toContain('mcp_servers_owner_idx');
    expect(sql).not.toContain("config = config - 'env'");
  });

  it('models standard skill package metadata', () => {
    const sql = schemaSql(32);

    for (const column of [
      'source_type',
      'source_path',
      'package_root',
      'source_name',
      'frontmatter',
      'openai_config',
      'claude_config',
      'allowed_tools',
      'disallowed_tools',
      'invocation_policy',
      'trust_status',
      'risk_audit',
      'schema_hash',
      'updated_at',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('skill_definitions_source_idx');
    expect(sql).toContain('skill_definitions_trust_idx');
    expect(sql).toContain('ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS source_type text');
    expect(sql).toContain('UPDATE skill_definitions');
  });

  it('models actor ownership for ledger audit events', () => {
    const sql = schemaSql(32);

    expect(sql).toContain('ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS user_id text');
    expect(sql).toContain('ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS tenant_id text');
    expect(sql).toContain('ledger_events_owner_idx');
  });

  it('backfills legacy owner fields from metadata and parent records', () => {
    const sql = schemaSql(32);

    expect(sql).toContain("metadata->>'userId'");
    expect(sql).toContain('UPDATE space_sessions AS ss');
    expect(sql).toContain('FROM threads AS t');
    expect(sql).toContain('UPDATE ledger_events AS le');
    expect(sql).toContain('FROM space_sessions AS ss');
  });

  it('rejects invalid embedding dimensions', () => {
    expect(() => schemaSql(0)).toThrow(/dimension must be a positive integer/);
    expect(() => schemaSql(1.5)).toThrow(/dimension must be a positive integer/);
  });
});

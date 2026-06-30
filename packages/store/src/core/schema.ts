/**
 * core 事件图 DDL（docs/store.md §3.2）。5 张表：source_group / source / event /
 * entity / event_entity。embedding 维度与基础 schema 一致，迁移时固定。
 */
export function coreSchemaSql(dimension: number): string {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`coreSchemaSql: dimension must be a positive integer, got ${dimension}`);
  }
  return `
CREATE TABLE IF NOT EXISTS source_group (
  id          text PRIMARY KEY,         -- 'memory' / 'knowledge'
  name        text NOT NULL,
  metadata    jsonb,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- 身份/隔离/范围都在 source 上, 按 kind 用不同维度
CREATE TABLE IF NOT EXISTS source (
  id          text PRIMARY KEY,
  group_id    text NOT NULL REFERENCES source_group(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  agent_id    text NOT NULL,
  user_id     text,
  tenant_id   text,
  space_id    text,
  thread_id   text,
  name        text,
  metadata    jsonb,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS source_scope_idx
  ON source (group_id, agent_id, kind, COALESCE(user_id,''), COALESCE(space_id,''), COALESCE(thread_id,''));
CREATE INDEX IF NOT EXISTS source_owner_idx
  ON source (group_id, agent_id, kind, thread_id);

-- 纯净: 无身份列, 只认 source_id; message_ids/content_hash 为出处与幂等
CREATE TABLE IF NOT EXISTS event (
  id           text PRIMARY KEY,
  source_id    text NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  summary      text NOT NULL,
  content      text NOT NULL,
  metadata     jsonb,
  keywords     text[] NOT NULL DEFAULT '{}',
  message_ids  text[],
  content_hash text,
  relation_id  text,
  supersedes_id text,
  superseded_by text,
  superseded_at timestamptz,
  importance   double precision,
  confidence   double precision,
  status       text NOT NULL DEFAULT 'active',
  valid_until  timestamptz,
  embedding    vector(${dimension}),
  search_text  tsvector,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

ALTER TABLE event ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE event ADD COLUMN IF NOT EXISTS relation_id text;
ALTER TABLE event ADD COLUMN IF NOT EXISTS supersedes_id text;
ALTER TABLE event ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE event ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE INDEX IF NOT EXISTS event_source_idx ON event (source_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS event_hash_idx ON event (source_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_relation_idx ON event (relation_id, status, created_at DESC) WHERE relation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_superseded_by_idx ON event (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_embedding_idx ON event USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS event_search_idx ON event USING gin (search_text);
CREATE INDEX IF NOT EXISTS event_keywords_idx ON event USING gin (keywords);

-- 实体按 source 共享去重
CREATE TABLE IF NOT EXISTS entity (
  id              text PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  type            text NOT NULL,        -- time|location|person|topic
  name            text NOT NULL,
  normalized_name text NOT NULL,
  aliases         text[],
  embedding       vector(${dimension}),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (source_id, type, normalized_name)
);

CREATE INDEX IF NOT EXISTS entity_source_type_idx ON entity (source_id, type);
CREATE INDEX IF NOT EXISTS entity_normalized_idx ON entity (normalized_name);

CREATE TABLE IF NOT EXISTS event_entity (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  entity_id   text NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  role        text,
  description text,
  weight      double precision DEFAULT 1.0,
  confidence  double precision,
  UNIQUE (event_id, entity_id)
);

CREATE INDEX IF NOT EXISTS event_entity_event_idx ON event_entity (event_id);
CREATE INDEX IF NOT EXISTS event_entity_entity_idx ON event_entity (entity_id, weight DESC);
`;
}

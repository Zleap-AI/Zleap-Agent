import { coreSchemaSql } from './core/schema.js';

/**
 * Idempotent DDL for the Zleap durable store. The embedding column dimension is
 * fixed at migration time and must match the configured embedding model.
 */
export function schemaSql(dimension: number): string {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`schemaSql: dimension must be a positive integer, got ${dimension}`);
  }
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS avatars (
  id               text PRIMARY KEY,
  user_id          text,
  slug             text NOT NULL,
  name             text NOT NULL,
  current_version  integer NOT NULL,
  status           text NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS avatars_user_slug_idx
  ON avatars (COALESCE(user_id, ''), slug);

CREATE TABLE IF NOT EXISTS avatar_versions (
  avatar_id        text NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  version          integer NOT NULL,
  name             text NOT NULL,
  description      text,
  persona          text,
  model_config_id  text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (avatar_id, version)
);

-- Spaces are GLOBAL (not owned by an avatar). id IS the slug. core.md §3.
CREATE TABLE IF NOT EXISTS spaces (
  id               text PRIMARY KEY,
  slug             text NOT NULL,
  kind             text NOT NULL,
  current_version  integer NOT NULL,
  status           text NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS spaces_kind_idx
  ON spaces (kind, status);

-- A space's slug IS its canonical id (core.md §3): at most one ACTIVE space may
-- own a given slug. This makes a duplicate 'main' (or any slug collision) an
-- impossible write rather than something to clean up after. Partial on active so
-- an archived slug can be re-created.
CREATE UNIQUE INDEX IF NOT EXISTS spaces_active_slug_idx
  ON spaces (slug)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS space_versions (
  space_id         text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  version          integer NOT NULL,
  label            text NOT NULL,
  description      text,
  routing_card     text,
  instructions     text,
  model_config_id  text,
  summary_model_config_id text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (space_id, version)
);

CREATE TABLE IF NOT EXISTS capability_definitions (
  id                 text NOT NULL,
  type               text NOT NULL,
  version            integer NOT NULL,
  origin             text NOT NULL,
  label              text,
  description        text,
  descriptor         jsonb,
  schema_hash        text,
  implementation_ref text,
  created_at         timestamptz NOT NULL,
  PRIMARY KEY (type, id, version)
);

CREATE TABLE IF NOT EXISTS space_capability_bindings (
  id                 text PRIMARY KEY,
  space_id           text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  space_version      integer NOT NULL,
  capability_type    text NOT NULL,
  capability_id      text NOT NULL,
  capability_version integer,
  enabled            boolean NOT NULL,
  config             jsonb,
  order_index        integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL,
  UNIQUE (space_id, space_version, capability_type, capability_id)
);

CREATE INDEX IF NOT EXISTS space_capability_bindings_space_idx
  ON space_capability_bindings (space_id, space_version, enabled, order_index);

CREATE TABLE IF NOT EXISTS skill_definitions (
  id                text NOT NULL,
  version           integer NOT NULL,
  origin            text NOT NULL,
  label             text NOT NULL,
  description       text,
  instructions      text,
  tool_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata          jsonb,
  source_type       text,
  source_path       text,
  package_root      text,
  source_name       text,
  frontmatter       jsonb,
  body              text,
  files             jsonb,
  openai_config     jsonb,
  claude_config     jsonb,
  license           text,
  compatibility     jsonb,
  allowed_tools     jsonb NOT NULL DEFAULT '[]'::jsonb,
  disallowed_tools  jsonb NOT NULL DEFAULT '[]'::jsonb,
  invocation_policy text,
  trust_status      text,
  risk_audit        jsonb,
  schema_hash       text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz,
  PRIMARY KEY (id, version)
);

ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS source_path text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS package_root text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS source_name text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS frontmatter jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS files jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS openai_config jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS claude_config jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS license text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS compatibility jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS disallowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS invocation_policy text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS trust_status text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS risk_audit jsonb;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS schema_hash text;
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE skill_definitions
SET updated_at = COALESCE(updated_at, created_at)
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS skill_definitions_origin_idx
  ON skill_definitions (origin, id, version);

CREATE INDEX IF NOT EXISTS skill_definitions_source_idx
  ON skill_definitions (source_type, source_name, version);

CREATE INDEX IF NOT EXISTS skill_definitions_trust_idx
  ON skill_definitions (trust_status, id, version);

CREATE TABLE IF NOT EXISTS model_configs (
  id          text PRIMARY KEY,
  provider_id text NOT NULL,
  model       text NOT NULL,
  purpose     text NOT NULL,
  config      jsonb,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          text PRIMARY KEY,
  user_id     text,
  tenant_id   text,
  name        text NOT NULL,
  transport   text NOT NULL,
  config      jsonb,
  secret_refs jsonb,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- IM gateway channel credentials/config (e.g. Feishu app_id/app_secret), one
-- row per channel. Secrets are redacted on API read, not at storage.
CREATE TABLE IF NOT EXISTS gateway_integrations (
  channel    text PRIMARY KEY,
  config     jsonb,
  updated_at timestamptz NOT NULL
);

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tenant_id text;

-- Inline config.env is allowed for stdio MCP servers; secrets are redacted on
-- API read (redactMcpServerRecord) rather than stripped at schema bootstrap.

CREATE INDEX IF NOT EXISTS mcp_servers_owner_idx
  ON mcp_servers (user_id, tenant_id, status);

CREATE TABLE IF NOT EXISTS mcp_tool_definitions (
  id            text NOT NULL,
  server_id     text NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       integer NOT NULL,
  label         text,
  description   text,
  input_schema  jsonb,
  output_schema jsonb,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS mcp_tool_definitions_server_idx
  ON mcp_tool_definitions (server_id, name, version);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id                 text PRIMARY KEY,
  user_id            text,
  tenant_id          text,
  avatar_id          text NOT NULL,
  project_id         text,
  conversation_id    text,
  model_config_id    text,
  permission_mode    text NOT NULL,
  target_space       text,
  name               text NOT NULL,
  prompt             text NOT NULL,
  cron               text NOT NULL,
  timezone           text NOT NULL,
  enabled            boolean NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  deleted_at         timestamptz
);

CREATE INDEX IF NOT EXISTS scheduled_tasks_owner_idx
  ON scheduled_tasks (user_id, tenant_id, deleted_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS scheduled_tasks_enabled_idx
  ON scheduled_tasks (enabled, deleted_at, updated_at DESC);

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS conversation_id text;

UPDATE scheduled_tasks
  SET conversation_id = 'task:' || id
  WHERE conversation_id IS NULL;

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'agent';

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS payload jsonb;

ALTER TABLE scheduled_tasks
  DROP COLUMN IF EXISTS concurrency_policy;

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id             text PRIMARY KEY,
  task_id        text NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  queue_job_id   text,
  trigger        text NOT NULL,
  status         text NOT NULL,
  scheduled_for  timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  conversation_id text,
  agent_run_id   text,
  summary        text,
  error          text,
  metadata       jsonb
);

CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_idx
  ON scheduled_task_runs (task_id, started_at DESC, scheduled_for DESC, id DESC);

CREATE INDEX IF NOT EXISTS scheduled_task_runs_status_idx
  ON scheduled_task_runs (task_id, status);

CREATE TABLE IF NOT EXISTS threads (
  id              text PRIMARY KEY,
  avatar_id       text NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  user_id         text,
  tenant_id       text,
  title           text,
  main_session_id text,
  status          text NOT NULL,
  source          text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  metadata        jsonb
);

ALTER TABLE threads ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS tenant_id text;

UPDATE threads
SET user_id = COALESCE(user_id, metadata->>'userId'),
    tenant_id = COALESCE(tenant_id, metadata->>'tenantId')
WHERE user_id IS NULL OR tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS threads_avatar_status_idx
  ON threads (avatar_id, status, updated_at);

CREATE INDEX IF NOT EXISTS threads_owner_idx
  ON threads (user_id, tenant_id, status, updated_at);

CREATE TABLE IF NOT EXISTS space_sessions (
  id                    text PRIMARY KEY,
  thread_id             text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  avatar_id             text NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  user_id               text,
  tenant_id             text,
  space_id              text NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
  kind                  text NOT NULL,
  parent_session_id     text,
  root_goal             text,
  task                  text,
  status                text NOT NULL,
  current_leaf_entry_id text,
  source                text,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  metadata              jsonb
);

ALTER TABLE space_sessions ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE space_sessions ADD COLUMN IF NOT EXISTS tenant_id text;

UPDATE space_sessions AS ss
SET user_id = COALESCE(ss.user_id, ss.metadata->>'userId', t.user_id),
    tenant_id = COALESCE(ss.tenant_id, ss.metadata->>'tenantId', t.tenant_id)
FROM threads AS t
WHERE ss.thread_id = t.id
  AND (ss.user_id IS NULL OR ss.tenant_id IS NULL);

CREATE INDEX IF NOT EXISTS space_sessions_thread_idx
  ON space_sessions (thread_id, kind, status);

CREATE INDEX IF NOT EXISTS space_sessions_parent_idx
  ON space_sessions (parent_session_id);

CREATE INDEX IF NOT EXISTS space_sessions_avatar_space_idx
  ON space_sessions (avatar_id, space_id, status);

CREATE INDEX IF NOT EXISTS space_sessions_owner_idx
  ON space_sessions (user_id, tenant_id, status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS space_sessions_one_main_idx
  ON space_sessions (thread_id)
  WHERE kind = 'main';

CREATE TABLE IF NOT EXISTS session_entries (
  id              text PRIMARY KEY,
  session_id      text NOT NULL REFERENCES space_sessions(id) ON DELETE CASCADE,
  parent_entry_id text,
  type            text NOT NULL,
  role            text,
  content         text,
  data            jsonb,
  run_id          text,
  work_id         text,
  work_step_id    text,
  tool_call_id    text,
  artifact_id     text,
  token_count     integer,
  created_at      timestamptz NOT NULL
);

ALTER TABLE session_entries ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS session_entries_branch_idx
  ON session_entries (session_id, parent_entry_id, created_at);

CREATE TABLE IF NOT EXISTS session_leafs (
  session_id text NOT NULL REFERENCES space_sessions(id) ON DELETE CASCADE,
  name       text NOT NULL,
  entry_id   text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id              text PRIMARY KEY,
  avatar_id       text NOT NULL,
  avatar_version  integer NOT NULL,
  thread_id       text,
  main_session_id text,
  status          text NOT NULL,
  goal            text NOT NULL,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  error           jsonb,
  metadata        jsonb
);

CREATE INDEX IF NOT EXISTS runs_thread_idx
  ON runs (thread_id, started_at);

CREATE TABLE IF NOT EXISTS works (
  id                text PRIMARY KEY,
  run_id            text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id         text,
  parent_session_id text,
  status            text NOT NULL,
  goal              text NOT NULL,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  error             jsonb,
  metadata          jsonb
);

CREATE INDEX IF NOT EXISTS works_run_idx
  ON works (run_id, started_at);

CREATE TABLE IF NOT EXISTS work_steps (
  id                     text PRIMARY KEY,
  work_id                text NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  workspace_id           text NOT NULL,
  session_id             text,
  status                 text NOT NULL,
  started_at             timestamptz,
  ended_at               timestamptz,
  error                  jsonb,
  capability_snapshot_id text,
  metadata               jsonb
);

CREATE INDEX IF NOT EXISTS work_steps_work_idx
  ON work_steps (work_id, workspace_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              text PRIMARY KEY,
  run_id          text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  work_id         text,
  work_step_id    text,
  session_id      text,
  tool_id         text NOT NULL,
  input           jsonb,
  result          jsonb,
  error           jsonb,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz
);

CREATE INDEX IF NOT EXISTS tool_calls_run_idx
  ON tool_calls (run_id, started_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id                  text PRIMARY KEY,
  run_id              text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  work_id             text,
  work_step_id        text,
  thread_id           text NOT NULL,
  producer_session_id text NOT NULL,
  target_session_id   text,
  workspace_id        text NOT NULL,
  kind                text NOT NULL,
  status              text NOT NULL,
  title               text NOT NULL,
  summary             text NOT NULL,
  content             text,
  data                jsonb,
  content_uri         text,
  created_at          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_thread_idx
  ON artifacts (thread_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_cache_entries (
  id              text PRIMARY KEY,
  user_id         text,
  agent_id        text,
  thread_id       text REFERENCES threads(id) ON DELETE CASCADE,
  conversation_id text,
  run_id          text,
  work_id         text,
  step_id         text,
  workspace_id    text,
  tool_call_id    text,
  tool_id         text,
  kind            text NOT NULL,
  title           text NOT NULL,
  summary         text NOT NULL,
  content         text NOT NULL,
  metadata        jsonb,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS runtime_cache_thread_created_idx
  ON runtime_cache_entries (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_cache_conversation_created_idx
  ON runtime_cache_entries (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_cache_run_created_idx
  ON runtime_cache_entries (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_references (
  id                text PRIMARY KEY,
  artifact_id       text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  uri               text,
  title             text,
  data              jsonb,
  source_session_id text,
  created_at        timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_snapshots (
  id                      text PRIMARY KEY,
  avatar_id               text NOT NULL,
  avatar_version          integer NOT NULL,
  space_id                text NOT NULL,
  space_version           integer NOT NULL,
  model_config_id         text,
  summary_model_config_id text,
  capabilities            jsonb NOT NULL,
  memory_policy           jsonb,
  permission_policy       jsonb,
  created_at              timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id           text PRIMARY KEY,
  run_id       text,
  work_id      text,
  work_step_id text,
  thread_id    text,
  session_id   text,
  user_id      text,
  tenant_id    text,
  type         text NOT NULL,
  data         jsonb,
  created_at   timestamptz NOT NULL
);

ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS tenant_id text;

UPDATE ledger_events AS le
SET user_id = COALESCE(le.user_id, le.data->>'userId', t.user_id),
    tenant_id = COALESCE(le.tenant_id, le.data->>'tenantId', t.tenant_id)
FROM threads AS t
WHERE le.thread_id = t.id
  AND (le.user_id IS NULL OR le.tenant_id IS NULL);

UPDATE ledger_events AS le
SET user_id = COALESCE(le.user_id, le.data->>'userId', ss.user_id),
    tenant_id = COALESCE(le.tenant_id, le.data->>'tenantId', ss.tenant_id)
FROM space_sessions AS ss
WHERE le.session_id = ss.id
  AND (le.user_id IS NULL OR le.tenant_id IS NULL);

CREATE INDEX IF NOT EXISTS ledger_events_run_idx
  ON ledger_events (run_id, created_at);

CREATE INDEX IF NOT EXISTS ledger_events_owner_idx
  ON ledger_events (user_id, tenant_id, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id           text PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL,
  attempts     integer NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 text PRIMARY KEY,
  agent_id           text,
  kind               text NOT NULL,
  trigger            text NOT NULL,
  title              text,
  parent_session_id  text,
  status             text NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  metadata           jsonb
);

CREATE TABLE IF NOT EXISTS session_runs (
  session_id   text NOT NULL,
  run_id       text NOT NULL,
  appended_at  timestamptz NOT NULL,
  PRIMARY KEY (session_id, run_id)
);

-- A 线 · agent_memory 笔记 (docs/store.md §2): 对人记忆.
-- experience kind 仅为旧数据兼容保留; 新经验记忆写入 core 事件图.
CREATE TABLE IF NOT EXISTS agent_memory (
  id          text PRIMARY KEY,
  kind        text NOT NULL,            -- impression | legacy experience
  agent_id    text NOT NULL,
  user_id     text,                     -- impression: user 级有值; global agent self 为 NULL
  space_id    text,                     -- legacy only
  thread_id   text,                     -- 出处(写入时所在对话), 仅溯源
  subject     text NOT NULL DEFAULT 'user', -- impression: user | agent
  memory      text NOT NULL,
  status      text NOT NULL DEFAULT 'active',   -- active | archived
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'user';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS memory text;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memory' AND column_name = 'content'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memory' AND column_name = 'title'
  ) THEN
    EXECUTE 'UPDATE agent_memory SET memory = COALESCE(NULLIF(memory, ''''), NULLIF(content, ''''), NULLIF(title, ''''), '''') WHERE memory IS NULL OR memory = ''''';
  END IF;
END $$;
UPDATE agent_memory SET memory = '' WHERE memory IS NULL;
ALTER TABLE agent_memory ALTER COLUMN memory SET NOT NULL;
ALTER TABLE agent_memory DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE agent_memory DROP COLUMN IF EXISTS title;
ALTER TABLE agent_memory DROP COLUMN IF EXISTS content;
ALTER TABLE agent_memory DROP COLUMN IF EXISTS importance;

CREATE INDEX IF NOT EXISTS agent_memory_impression_idx
  ON agent_memory (agent_id, user_id, status, created_at DESC)
  WHERE kind = 'impression';

CREATE INDEX IF NOT EXISTS agent_memory_experience_idx
  ON agent_memory (agent_id, status, created_at DESC)
  WHERE kind = 'experience';
${coreSchemaSql(dimension)}`;
}

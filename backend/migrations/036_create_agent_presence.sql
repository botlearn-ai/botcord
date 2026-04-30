-- Agent Presence & Status V1 (Supabase-only).
--
-- Three tables:
--   agent_status_settings        owner-driven manual status (persisted)
--   agent_presence               composed effective status + activity/attribute projection
--   agent_presence_connections   per-WS connection lease (multi-Hub safe)
--
-- See docs/agent-presence-status-v1-supabase.md for the full design.

CREATE TABLE IF NOT EXISTS agent_status_settings (
  agent_id           VARCHAR(32)  PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  manual_status      VARCHAR(16)  NOT NULL DEFAULT 'available',
  status_message     TEXT         NULL,
  manual_expires_at  TIMESTAMPTZ  NULL,
  updated_by_type    VARCHAR(16)  NULL,
  updated_by_id      VARCHAR(64)  NULL,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_agent_status_settings_manual_status
    CHECK (manual_status IN ('available', 'busy', 'away', 'invisible'))
);

CREATE TABLE IF NOT EXISTS agent_presence (
  agent_id          VARCHAR(32)  PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  effective_status  VARCHAR(16)  NOT NULL DEFAULT 'offline',
  connected         BOOLEAN      NOT NULL DEFAULT FALSE,
  connection_count  INTEGER      NOT NULL DEFAULT 0,
  version           BIGINT       NOT NULL DEFAULT 0,
  last_seen_at      TIMESTAMPTZ  NULL,
  activity_json     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  attributes_json   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_agent_presence_effective_status
    CHECK (effective_status IN ('offline', 'online', 'busy', 'away', 'working'))
);

CREATE INDEX IF NOT EXISTS ix_agent_presence_status_updated
  ON agent_presence (effective_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_agent_presence_last_seen
  ON agent_presence (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS agent_presence_connections (
  connection_id  VARCHAR(64)  PRIMARY KEY,
  agent_id       VARCHAR(32)  NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  node_id        VARCHAR(64)  NOT NULL,
  last_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_agent_presence_connections_agent_seen
  ON agent_presence_connections (agent_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS ix_agent_presence_connections_node
  ON agent_presence_connections (node_id, last_seen_at DESC);

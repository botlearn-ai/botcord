-- OpenClaw host instances: a host is the OpenClaw VM/container that runs
-- the BotCord plugin. Mirrors `daemon_instances` shape — long-lived control
-- plane row with refresh-token rotation; agents owned by this host link via
-- `agents.openclaw_host_id`.

CREATE TABLE IF NOT EXISTS openclaw_host_instances (
    id                       VARCHAR(32)  PRIMARY KEY,                  -- oc_<12 hex>
    owner_user_id            UUID         NOT NULL,
    host_pubkey              TEXT         NOT NULL UNIQUE,
    label                    VARCHAR(64)  NULL,
    refresh_token_hash       VARCHAR(128) NULL,                          -- nullable so revoke can blank it
    refresh_token_expires_at TIMESTAMPTZ  NULL,
    last_seen_at             TIMESTAMPTZ  NULL,
    revoked_at               TIMESTAMPTZ  NULL,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_openclaw_host_instances_owner
  ON openclaw_host_instances (owner_user_id);

CREATE INDEX IF NOT EXISTS ix_openclaw_host_instances_refresh_hash
  ON openclaw_host_instances (refresh_token_hash);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS openclaw_host_id VARCHAR(32)
    REFERENCES openclaw_host_instances(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_agents_openclaw_host
  ON agents(openclaw_host_id)
  WHERE openclaw_host_id IS NOT NULL;

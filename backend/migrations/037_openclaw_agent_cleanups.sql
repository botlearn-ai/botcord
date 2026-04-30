-- Durable best-effort local cleanup jobs for OpenClaw-hosted agents.
-- Hub-side unbind can complete while the host is offline; the control plane
-- retries pending cleanup when the host reconnects.

CREATE TABLE IF NOT EXISTS openclaw_agent_cleanups (
    id                 BIGSERIAL PRIMARY KEY,
    host_id            VARCHAR(32) NOT NULL REFERENCES openclaw_host_instances(id) ON DELETE CASCADE,
    agent_id           VARCHAR(32) NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending',
    delete_credentials BOOLEAN NOT NULL DEFAULT TRUE,
    delete_state       BOOLEAN NOT NULL DEFAULT TRUE,
    delete_workspace   BOOLEAN NOT NULL DEFAULT FALSE,
    attempts           INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at       TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS ix_openclaw_agent_cleanups_host_status
  ON openclaw_agent_cleanups(host_id, status);

CREATE INDEX IF NOT EXISTS ix_openclaw_agent_cleanups_agent
  ON openclaw_agent_cleanups(agent_id);

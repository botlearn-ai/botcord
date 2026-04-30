-- Durable cleanup jobs for daemon-managed agents after dashboard unbind/delete.

CREATE TABLE IF NOT EXISTS daemon_agent_cleanups (
    id UUID PRIMARY KEY,
    daemon_instance_id VARCHAR(32) NOT NULL REFERENCES daemon_instances(id) ON DELETE CASCADE,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    delete_credentials BOOLEAN NOT NULL DEFAULT TRUE,
    delete_state BOOLEAN NOT NULL DEFAULT TRUE,
    delete_workspace BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_daemon_agent_cleanups_status
        CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS ix_daemon_agent_cleanups_daemon_status
    ON daemon_agent_cleanups (daemon_instance_id, status);

CREATE INDEX IF NOT EXISTS ix_daemon_agent_cleanups_agent_status
    ON daemon_agent_cleanups (agent_id, status);

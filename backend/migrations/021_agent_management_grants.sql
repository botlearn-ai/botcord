-- Owner-granted management capabilities for agent-credential API access.

CREATE TABLE IF NOT EXISTS agent_management_grants (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    scope VARCHAR(64) NOT NULL,
    daemon_instance_id VARCHAR(32),
    limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_user_id
    ON agent_management_grants (user_id);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_agent_id
    ON agent_management_grants (agent_id);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_daemon_instance_id
    ON agent_management_grants (daemon_instance_id);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_user_agent
    ON agent_management_grants (user_id, agent_id);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_agent_scope
    ON agent_management_grants (agent_id, scope);

CREATE INDEX IF NOT EXISTS ix_agent_management_grants_scope_active
    ON agent_management_grants (scope, revoked_at, expires_at);

-- Cloud Agent MVP schema. See docs/cloud-agent-technical-design.md §5.
--
-- This migration introduces the persistence layer for Cloud Agents:
--   1. Extend agents.hosting_kind to allow 'cloud'.
--   2. Tag daemon_instances rows with a kind so local and cloud-owned
--      daemons can coexist in the same table without ambiguous joins.
--   3. cloud_daemon_instances: one row per E2B sandbox (a host that
--      can run multiple Cloud Agents).
--   4. cloud_agent_instances: one row per Cloud Agent ↔ cloud daemon
--      binding.
--   5. usage_events: idempotent per-run usage ledger.
--   6. usage_balances: per-user, per-period Cloud Credits and sandbox
--      seconds accounting (included / used / reserved).

ALTER TABLE agents
    DROP CONSTRAINT IF EXISTS ck_agents_hosting_kind;

ALTER TABLE agents
    ADD CONSTRAINT ck_agents_hosting_kind
    CHECK (hosting_kind IS NULL OR hosting_kind IN ('daemon', 'openclaw', 'cli', 'cloud'));

ALTER TABLE daemon_instances
    ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'local';

ALTER TABLE daemon_instances
    DROP CONSTRAINT IF EXISTS ck_daemon_instances_kind;

ALTER TABLE daemon_instances
    ADD CONSTRAINT ck_daemon_instances_kind
    CHECK (kind IN ('local', 'cloud'));

CREATE INDEX IF NOT EXISTS ix_daemon_instances_kind
    ON daemon_instances (kind);


CREATE TABLE IF NOT EXISTS cloud_daemon_instances (
    id VARCHAR(32) PRIMARY KEY,
    user_id UUID NOT NULL,
    daemon_instance_id VARCHAR(32) NOT NULL REFERENCES daemon_instances(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    provider_sandbox_id VARCHAR(128),
    provider_template_id VARCHAR(128),
    status VARCHAR(16) NOT NULL DEFAULT 'creating',
    region VARCHAR(64),
    runtime VARCHAR(64) NOT NULL,
    max_agents INTEGER NOT NULL DEFAULT 1,
    active_agent_count INTEGER NOT NULL DEFAULT 0,
    last_started_at TIMESTAMPTZ,
    last_paused_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    error_code VARCHAR(64),
    error_message TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_cloud_daemon_instances_status
        CHECK (status IN ('creating', 'starting', 'ready', 'paused', 'failed', 'deleting', 'deleted')),
    CONSTRAINT ck_cloud_daemon_instances_active_agent_count
        CHECK (active_agent_count >= 0),
    CONSTRAINT uq_cloud_daemon_instances_daemon_instance_id
        UNIQUE (daemon_instance_id)
);

CREATE INDEX IF NOT EXISTS ix_cloud_daemon_instances_user
    ON cloud_daemon_instances (user_id);

CREATE INDEX IF NOT EXISTS ix_cloud_daemon_instances_status
    ON cloud_daemon_instances (status);


CREATE TABLE IF NOT EXISTS cloud_agent_instances (
    id VARCHAR(32) PRIMARY KEY,
    user_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
    cloud_daemon_instance_id VARCHAR(32) NOT NULL REFERENCES cloud_daemon_instances(id) ON DELETE CASCADE,
    daemon_instance_id VARCHAR(32) NOT NULL REFERENCES daemon_instances(id) ON DELETE CASCADE,
    runtime VARCHAR(64) NOT NULL,
    model_profile VARCHAR(64) NOT NULL,
    workspace_ref TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'provisioning',
    last_run_at TIMESTAMPTZ,
    error_code VARCHAR(64),
    error_message TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_cloud_agent_instances_status
        CHECK (status IN ('provisioning', 'ready', 'paused', 'failed', 'deleting', 'deleted'))
);

CREATE INDEX IF NOT EXISTS ix_cloud_agent_instances_user
    ON cloud_agent_instances (user_id);

CREATE INDEX IF NOT EXISTS ix_cloud_agent_instances_cloud_daemon
    ON cloud_agent_instances (cloud_daemon_instance_id);

CREATE INDEX IF NOT EXISTS ix_cloud_agent_instances_status
    ON cloud_agent_instances (status);


CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id VARCHAR(64) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    model VARCHAR(64) NOT NULL,
    input_cache_hit_tokens BIGINT NOT NULL DEFAULT 0,
    input_cache_miss_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    sandbox_seconds BIGINT NOT NULL DEFAULT 0,
    credits_charged BIGINT NOT NULL DEFAULT 0,
    idempotency_key VARCHAR(128) NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_usage_events_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_usage_events_user_created
    ON usage_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_usage_events_agent_created
    ON usage_events (agent_id, created_at);

CREATE INDEX IF NOT EXISTS ix_usage_events_run
    ON usage_events (run_id);


CREATE TABLE IF NOT EXISTS usage_balances (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    included_credits BIGINT NOT NULL DEFAULT 0,
    used_credits BIGINT NOT NULL DEFAULT 0,
    reserved_credits BIGINT NOT NULL DEFAULT 0,
    included_sandbox_seconds BIGINT NOT NULL DEFAULT 0,
    used_sandbox_seconds BIGINT NOT NULL DEFAULT 0,
    reserved_sandbox_seconds BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_usage_balances_user_period UNIQUE (user_id, period_start),
    CONSTRAINT ck_usage_balances_non_negative CHECK (
        used_credits >= 0
        AND reserved_credits >= 0
        AND used_sandbox_seconds >= 0
        AND reserved_sandbox_seconds >= 0
    )
);

CREATE INDEX IF NOT EXISTS ix_usage_balances_user
    ON usage_balances (user_id);

-- PR 7: per-run reservation table.
--
-- ``usage_balances`` already tracks the aggregate reserved_* totals; this
-- table records the individual reservations so settle / release can move
-- the right amount when each run completes (or is abandoned). One row per
-- ``run_id`` — the unique constraint makes reserve() idempotent at the
-- run level.

CREATE TABLE IF NOT EXISTS usage_reservations (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id VARCHAR(64) NOT NULL,
    reserved_credits BIGINT NOT NULL DEFAULT 0,
    reserved_sandbox_seconds BIGINT NOT NULL DEFAULT 0,
    state VARCHAR(16) NOT NULL DEFAULT 'active',
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    CONSTRAINT uq_usage_reservations_run_id UNIQUE (run_id),
    CONSTRAINT ck_usage_reservations_state
        CHECK (state IN ('active', 'settled', 'released')),
    CONSTRAINT ck_usage_reservations_non_negative
        CHECK (reserved_credits >= 0 AND reserved_sandbox_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS ix_usage_reservations_user_state
    ON usage_reservations (user_id, state);

CREATE INDEX IF NOT EXISTS ix_usage_reservations_agent
    ON usage_reservations (agent_id);

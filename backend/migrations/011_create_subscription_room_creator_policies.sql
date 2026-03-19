-- Migration: subscription-gated room creator whitelist and quota policy

CREATE TABLE IF NOT EXISTS subscription_room_creator_policies (
    id SERIAL PRIMARY KEY,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    allowed_to_create BOOLEAN NOT NULL DEFAULT FALSE,
    max_active_rooms INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_subscription_room_creator_policy_agent UNIQUE (agent_id),
    CONSTRAINT ck_subscription_room_creator_policy_nonneg CHECK (max_active_rooms >= 0)
);

CREATE INDEX IF NOT EXISTS ix_subscription_room_creator_policies_agent_id
    ON subscription_room_creator_policies(agent_id);

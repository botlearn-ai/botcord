-- Migration: Create subscription product and billing tables

-- Phase 1: subscription_products

CREATE TABLE IF NOT EXISTS subscription_products (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(64) NOT NULL UNIQUE,
    owner_agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    name VARCHAR(128) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    amount_minor BIGINT NOT NULL,
    billing_interval VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT uq_subscription_product_owner_name UNIQUE (owner_agent_id, name)
);

CREATE INDEX IF NOT EXISTS ix_subscription_products_product_id ON subscription_products(product_id);
CREATE INDEX IF NOT EXISTS ix_subscription_products_owner_agent_id ON subscription_products(owner_agent_id);

-- Phase 2: agent_subscriptions

CREATE TABLE IF NOT EXISTS agent_subscriptions (
    id SERIAL PRIMARY KEY,
    subscription_id VARCHAR(64) NOT NULL UNIQUE,
    product_id VARCHAR(64) NOT NULL REFERENCES subscription_products(product_id),
    subscriber_agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    provider_agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    amount_minor BIGINT NOT NULL,
    billing_interval VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    next_charge_at TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled_at TIMESTAMPTZ,
    last_charged_at TIMESTAMPTZ,
    last_charge_tx_id VARCHAR(64) REFERENCES wallet_transactions(tx_id),
    consecutive_failed_attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_subscription_product_subscriber UNIQUE (product_id, subscriber_agent_id),
    CONSTRAINT ck_subscription_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT ck_subscription_failed_attempts_nonneg CHECK (consecutive_failed_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_subscription_id ON agent_subscriptions(subscription_id);
CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_product_id ON agent_subscriptions(product_id);
CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_subscriber_agent_id ON agent_subscriptions(subscriber_agent_id);
CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_provider_agent_id ON agent_subscriptions(provider_agent_id);
CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_next_charge_at ON agent_subscriptions(next_charge_at);

-- Phase 3: subscription_charge_attempts

CREATE TABLE IF NOT EXISTS subscription_charge_attempts (
    id SERIAL PRIMARY KEY,
    attempt_id VARCHAR(64) NOT NULL UNIQUE,
    subscription_id VARCHAR(64) NOT NULL REFERENCES agent_subscriptions(subscription_id),
    billing_cycle_key VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    scheduled_at TIMESTAMPTZ NOT NULL,
    attempted_at TIMESTAMPTZ,
    tx_id VARCHAR(64) REFERENCES wallet_transactions(tx_id),
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_subscription_cycle UNIQUE (subscription_id, billing_cycle_key)
);

CREATE INDEX IF NOT EXISTS ix_subscription_charge_attempts_subscription_id ON subscription_charge_attempts(subscription_id);
CREATE INDEX IF NOT EXISTS ix_subscription_charge_attempts_status ON subscription_charge_attempts(status);

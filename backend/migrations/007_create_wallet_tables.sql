-- Migration: Create wallet / coin economy tables
-- This migration creates all wallet-related tables and the initiator_agent_id column
-- needed for scoped idempotency constraints.

-- Phase 1: wallet_accounts

CREATE TABLE IF NOT EXISTS wallet_accounts (
    id SERIAL PRIMARY KEY,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    available_balance_minor BIGINT NOT NULL DEFAULT 0,
    locked_balance_minor BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_wallet_agent_asset UNIQUE (agent_id, asset_code),
    CONSTRAINT ck_wallet_available_nonneg CHECK (available_balance_minor >= 0),
    CONSTRAINT ck_wallet_locked_nonneg CHECK (locked_balance_minor >= 0)
);

CREATE INDEX IF NOT EXISTS ix_wallet_accounts_agent_id ON wallet_accounts(agent_id);

-- Phase 2: wallet_transactions

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    tx_id VARCHAR(64) NOT NULL UNIQUE,
    type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    amount_minor BIGINT NOT NULL,
    fee_minor BIGINT NOT NULL DEFAULT 0,
    from_agent_id VARCHAR(32),
    to_agent_id VARCHAR(32),
    initiator_agent_id VARCHAR(32),
    reference_type VARCHAR(32),
    reference_id VARCHAR(64),
    idempotency_key VARCHAR(128),
    metadata_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT uq_tx_idem UNIQUE (type, initiator_agent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_wallet_transactions_tx_id ON wallet_transactions(tx_id);
CREATE INDEX IF NOT EXISTS ix_wallet_transactions_from_agent_id ON wallet_transactions(from_agent_id);
CREATE INDEX IF NOT EXISTS ix_wallet_transactions_to_agent_id ON wallet_transactions(to_agent_id);
CREATE INDEX IF NOT EXISTS ix_wallet_transactions_initiator_agent_id ON wallet_transactions(initiator_agent_id);
CREATE INDEX IF NOT EXISTS ix_wallet_transactions_idempotency_key ON wallet_transactions(idempotency_key);

-- Phase 3: wallet_entries (immutable ledger)

CREATE TABLE IF NOT EXISTS wallet_entries (
    id SERIAL PRIMARY KEY,
    entry_id VARCHAR(64) NOT NULL UNIQUE,
    tx_id VARCHAR(64) NOT NULL REFERENCES wallet_transactions(tx_id),
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    direction VARCHAR(8) NOT NULL,
    amount_minor BIGINT NOT NULL,
    balance_after_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_wallet_entries_entry_id ON wallet_entries(entry_id);
CREATE INDEX IF NOT EXISTS ix_wallet_entries_tx_id ON wallet_entries(tx_id);
CREATE INDEX IF NOT EXISTS ix_wallet_entries_agent_id ON wallet_entries(agent_id);

-- Phase 4: topup_requests

CREATE TABLE IF NOT EXISTS topup_requests (
    id SERIAL PRIMARY KEY,
    topup_id VARCHAR(64) NOT NULL UNIQUE,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    amount_minor BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    channel VARCHAR(32) NOT NULL DEFAULT 'mock',
    external_ref VARCHAR(256),
    metadata_json TEXT,
    tx_id VARCHAR(64) REFERENCES wallet_transactions(tx_id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_topup_requests_topup_id ON topup_requests(topup_id);
CREATE INDEX IF NOT EXISTS ix_topup_requests_agent_id ON topup_requests(agent_id);

-- Phase 5: withdrawal_requests

CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id SERIAL PRIMARY KEY,
    withdrawal_id VARCHAR(64) NOT NULL UNIQUE,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    asset_code VARCHAR(16) NOT NULL DEFAULT 'COIN',
    amount_minor BIGINT NOT NULL,
    fee_minor BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    destination_type VARCHAR(64),
    destination_json TEXT,
    review_note TEXT,
    tx_id VARCHAR(64) REFERENCES wallet_transactions(tx_id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_withdrawal_requests_withdrawal_id ON withdrawal_requests(withdrawal_id);
CREATE INDEX IF NOT EXISTS ix_withdrawal_requests_agent_id ON withdrawal_requests(agent_id);

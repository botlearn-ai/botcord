-- Migration: Add one-time daemon install tickets for non-interactive bootstrap.

CREATE TABLE IF NOT EXISTS daemon_install_tickets (
    id VARCHAR(32) PRIMARY KEY,
    user_id UUID NOT NULL,
    token_hash VARCHAR(128) NOT NULL,
    label VARCHAR(64),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    daemon_instance_id VARCHAR(32),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daemon_install_tickets_token_hash
    ON daemon_install_tickets (token_hash);

CREATE INDEX IF NOT EXISTS ix_daemon_install_tickets_user_expires
    ON daemon_install_tickets (user_id, expires_at);

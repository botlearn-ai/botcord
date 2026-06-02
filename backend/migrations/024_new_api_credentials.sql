-- Per-user new-api account/token mapping for Cloud Agent runtime credentials.

CREATE TABLE IF NOT EXISTS new_api_credentials (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    new_api_user_id INTEGER NOT NULL,
    new_api_username VARCHAR(64) NOT NULL,
    token_id INTEGER NOT NULL,
    token_name VARCHAR(128) NOT NULL,
    api_base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    quota BIGINT NOT NULL DEFAULT 0,
    used_quota BIGINT NOT NULL DEFAULT 0,
    token_remain_quota BIGINT NOT NULL DEFAULT 0,
    token_used_quota BIGINT NOT NULL DEFAULT 0,
    quota_per_usd DOUBLE PRECISION NOT NULL DEFAULT 500000.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_new_api_credentials_user_id UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS ix_new_api_credentials_new_api_user
    ON new_api_credentials (new_api_user_id);

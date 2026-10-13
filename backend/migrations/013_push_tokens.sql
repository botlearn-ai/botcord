-- Expo push tokens for the mobile client; one row per device token.
-- Apply using the configured Hub schema (users stays in public).
BEGIN;

CREATE TABLE IF NOT EXISTS push_tokens (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    token VARCHAR(256) NOT NULL,
    platform VARCHAR(16) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(user_id) REFERENCES public.users (id),
    UNIQUE (token),
    CONSTRAINT ck_push_token_platform CHECK (platform IN ('ios', 'android', 'web'))
);

CREATE INDEX IF NOT EXISTS ix_push_tokens_user_id ON push_tokens (user_id);

COMMIT;

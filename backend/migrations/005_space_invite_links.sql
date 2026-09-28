-- Shareable organization invite links (people without an account sign up first).
-- Apply after 002_team_identity_spaces.sql, using the configured Hub schema.
BEGIN;

CREATE TABLE IF NOT EXISTS space_invite_links (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    code VARCHAR(48) NOT NULL,
    created_by_user_id UUID NOT NULL,
    max_uses INTEGER,
    use_count INTEGER DEFAULT '0' NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (code),
    CONSTRAINT ck_space_invite_link_uses CHECK (use_count >= 0),
    CONSTRAINT ck_space_invite_link_max_uses CHECK (max_uses IS NULL OR max_uses > 0),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    FOREIGN KEY(created_by_user_id) REFERENCES public.users (id)
);

CREATE INDEX IF NOT EXISTS ix_space_invite_links_space_id ON space_invite_links (space_id);

COMMIT;

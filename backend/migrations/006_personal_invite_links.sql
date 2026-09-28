-- Personal (single-use by default) organization invite links: who it is for, who used it.
-- Apply after 005_space_invite_links.sql, using the configured Hub schema.
BEGIN;

ALTER TABLE space_invite_links ADD COLUMN IF NOT EXISTS label VARCHAR(64);
ALTER TABLE space_invite_links ADD COLUMN IF NOT EXISTS redeemed_by_user_id UUID REFERENCES public.users (id);
ALTER TABLE space_invite_links ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP WITH TIME ZONE;

COMMIT;

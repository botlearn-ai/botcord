-- Agent policy extension: split the single legacy `message_policy` column into
-- per-axis admission (contact / room-invite) plus daemon-side attention defaults.
--
-- The application layer continues to dual-write `message_policy` while the
-- legacy column is in use; a follow-up PR drops it.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS contact_policy TEXT NOT NULL DEFAULT 'contacts_only';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS allow_agent_sender BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS allow_human_sender BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS room_invite_policy TEXT NOT NULL DEFAULT 'contacts_only';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS default_attention TEXT NOT NULL DEFAULT 'always';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS attention_keywords TEXT NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_agents_contact_policy'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT ck_agents_contact_policy
      CHECK (contact_policy IN ('open','contacts_only','whitelist','closed'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_agents_room_invite_policy'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT ck_agents_room_invite_policy
      CHECK (room_invite_policy IN ('open','contacts_only','closed'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_agents_default_attention'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT ck_agents_default_attention
      CHECK (default_attention IN ('always','mention_only','keyword','muted'))
      NOT VALID;
  END IF;
END $$;

-- Backfill: copy the legacy `message_policy` ('open' | 'contacts_only') into
-- `contact_policy`. `room_invite_policy` keeps the safer 'contacts_only'
-- default — it is a stricter axis and pre-existing agents never opted in.
UPDATE agents SET contact_policy = message_policy::text
  WHERE contact_policy = 'contacts_only' AND message_policy IS NOT NULL;

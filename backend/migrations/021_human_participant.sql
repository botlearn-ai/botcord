-- Human-as-first-class migration.
--
-- 1. Adds public.users.human_id with deterministic backfill (hu_<12 hex>) and a
--    UNIQUE index, so every existing user gets a stable social identity.
-- 2. Drops the FK-to-agents constraint on the polymorphic participant columns
--    (rooms.owner_id, room_members.agent_id, contacts.owner_id,
--    blocks.owner_id, contact_requests.from_agent_id/to_agent_id,
--    message_records.sender_id) so Human participants (hu_*) are legal.
-- 3. Adds the owner_type / participant_type / peer_type / blocked_type /
--    from_type / to_type discriminator columns. They default to 'agent' so
--    every existing row keeps its old semantics without a bespoke backfill.
-- 4. Creates the agent_approval_queue table used when a Human-owned Agent
--    receives a contact_request / room_invite / payment that should be
--    surfaced to its owner for approval instead of auto-accepted.
--
-- Postgres-specific. SQLite (used in tests) constructs the same shape from
-- SQLAlchemy models.

-- ---------------------------------------------------------------------------
-- 1. public.users.human_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS human_id VARCHAR(32);

-- Backfill existing rows. ``gen_random_bytes`` is the pgcrypto equivalent of
-- ``secrets.token_hex(6)`` used by hub.id_generators.generate_human_id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE public.users
    SET human_id = 'hu_' || encode(gen_random_bytes(6), 'hex')
    WHERE human_id IS NULL;

ALTER TABLE public.users
    ALTER COLUMN human_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_human_id
    ON public.users (human_id);

-- ---------------------------------------------------------------------------
-- 2. Participant-type discriminator enum
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'participanttype') THEN
        CREATE TYPE participanttype AS ENUM ('agent', 'human');
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. rooms.owner_id: drop FK, add owner_type
-- ---------------------------------------------------------------------------

ALTER TABLE rooms
    DROP CONSTRAINT IF EXISTS rooms_owner_id_fkey;

ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS owner_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 4. room_members.agent_id: drop FK, add participant_type
-- ---------------------------------------------------------------------------

ALTER TABLE room_members
    DROP CONSTRAINT IF EXISTS room_members_agent_id_fkey;

ALTER TABLE room_members
    ADD COLUMN IF NOT EXISTS participant_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 5. contacts: drop owner FK, add owner_type + peer_type
-- ---------------------------------------------------------------------------

ALTER TABLE contacts
    DROP CONSTRAINT IF EXISTS contacts_owner_id_fkey;

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS owner_type participanttype NOT NULL DEFAULT 'agent';

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS peer_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 6. blocks: drop owner FK, add owner_type + blocked_type
-- ---------------------------------------------------------------------------

ALTER TABLE blocks
    DROP CONSTRAINT IF EXISTS blocks_owner_id_fkey;

ALTER TABLE blocks
    ADD COLUMN IF NOT EXISTS owner_type participanttype NOT NULL DEFAULT 'agent';

ALTER TABLE blocks
    ADD COLUMN IF NOT EXISTS blocked_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 7. contact_requests: drop from/to FKs, add from_type + to_type
-- ---------------------------------------------------------------------------

ALTER TABLE contact_requests
    DROP CONSTRAINT IF EXISTS contact_requests_from_agent_id_fkey;

ALTER TABLE contact_requests
    DROP CONSTRAINT IF EXISTS contact_requests_to_agent_id_fkey;

ALTER TABLE contact_requests
    ADD COLUMN IF NOT EXISTS from_type participanttype NOT NULL DEFAULT 'agent';

ALTER TABLE contact_requests
    ADD COLUMN IF NOT EXISTS to_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 8. message_records.sender_id: drop FK (Human-originated messages need this)
-- ---------------------------------------------------------------------------

ALTER TABLE message_records
    DROP CONSTRAINT IF EXISTS message_records_sender_id_fkey;

-- ---------------------------------------------------------------------------
-- 9. agent_approval_queue
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approvalkind') THEN
        CREATE TYPE approvalkind AS ENUM ('contact_request', 'room_invite', 'payment');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approvalstate') THEN
        CREATE TYPE approvalstate AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS agent_approval_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    owner_user_id UUID NOT NULL REFERENCES public.users(id),
    kind approvalkind NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    state approvalstate NOT NULL DEFAULT 'pending',
    resolved_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_agent_approval_agent_state
    ON agent_approval_queue (agent_id, state);

CREATE INDEX IF NOT EXISTS ix_agent_approval_owner_state
    ON agent_approval_queue (owner_user_id, state);

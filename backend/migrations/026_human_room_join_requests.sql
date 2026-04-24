-- Human-as-first-class: polymorphic room_join_requests.
--
-- 1. Drops the FK on room_join_requests.agent_id so Human requesters (hu_*)
--    are legal (the agent_id column remains as the legacy column name; it now
--    stores any participant id — same pattern as room_members.agent_id).
-- 2. Adds participant_type discriminator column (default 'agent') so existing
--    rows keep their A→Room semantics.
-- 3. Replaces the (room_id, agent_id, status) unique constraint with one that
--    also covers participant_type — a Human and an Agent with accidentally
--    colliding ids (shouldn't happen, but be safe) get distinct pending rows.
--
-- Postgres-specific. SQLite (tests) builds the same shape from the SQLAlchemy
-- model so no migration is run there.

-- ---------------------------------------------------------------------------
-- 1. Drop the FK to agents.agent_id
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fk_name text;
BEGIN
    SELECT conname INTO fk_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'room_join_requests'::regclass
      AND confrelid = 'agents'::regclass;
    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE room_join_requests DROP CONSTRAINT %I', fk_name);
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. Add participant_type column (reuses enum created in 024_human_participant)
-- ---------------------------------------------------------------------------

ALTER TABLE room_join_requests
    ADD COLUMN IF NOT EXISTS participant_type participanttype NOT NULL DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 3. Replace unique constraint to include participant_type
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_room_join_request_pending'
          AND conrelid = 'room_join_requests'::regclass
    ) THEN
        ALTER TABLE room_join_requests DROP CONSTRAINT uq_room_join_request_pending;
    END IF;
END$$;

ALTER TABLE room_join_requests
    ADD CONSTRAINT uq_room_join_request_pending
    UNIQUE (room_id, agent_id, participant_type, status);

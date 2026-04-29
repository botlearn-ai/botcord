-- Drop the FK constraint on shares.shared_by_agent_id so that human participants
-- (hu_* IDs, not present in the agents table) can create share links.
-- This mirrors what migration 024 did for rooms, room_members, contacts, blocks,
-- contact_requests, and message_records.

ALTER TABLE shares
    DROP CONSTRAINT IF EXISTS shares_shared_by_agent_id_fkey;
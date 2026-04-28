-- Migration: Allow Human (hu_*) participants to author / redeem invites.
--
-- The original schema (018_create_invites.sql) constrained
-- ``invites.creator_agent_id`` and ``invite_redemptions.redeemer_agent_id``
-- to reference ``agents(agent_id)``. After the polymorphic Human rollout,
-- both columns can legitimately hold ``hu_*`` ids, so the foreign keys
-- need to be dropped — column types stay the same since both id families
-- are 32-char prefixed strings.

ALTER TABLE invites
    DROP CONSTRAINT IF EXISTS invites_creator_agent_id_fkey;

ALTER TABLE invite_redemptions
    DROP CONSTRAINT IF EXISTS invite_redemptions_redeemer_agent_id_fkey;

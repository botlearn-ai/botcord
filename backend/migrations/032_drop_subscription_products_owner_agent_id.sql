-- Migration: Drop the deprecated subscription_products.owner_agent_id mirror.
--
-- Migration 031 added polymorphic (owner_id, owner_type) + provider_agent_id
-- and kept owner_agent_id as a NULLable read-only mirror to ease rollout.
-- All application code now reads owner_id / owner_type. This migration
-- removes the mirror column.

ALTER TABLE subscription_products
    DROP COLUMN IF EXISTS owner_agent_id;

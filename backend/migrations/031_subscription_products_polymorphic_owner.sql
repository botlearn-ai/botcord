-- Migration: Polymorphic owner for subscription_products + provider_agent_id.
--
-- Background: PR #352 made rooms polymorphic (owner_id + owner_type can be
-- ag_* or hu_*) but subscription_products is still agent-only via
-- owner_agent_id. The dashboard "create product" path 400s for human-owned
-- rooms because there is no X-Active-Agent header. This migration:
--
--   1. Adds owner_id + owner_type to subscription_products, reusing the
--      existing `participanttype` Postgres enum from migration 024 to stay
--      consistent with rooms.owner_type.
--   2. Adds provider_agent_id — the agent wallet that receives subscription
--      payments. Always an agent. For agent-owned products this equals the
--      owner; for human-owned products the human picks one of their bots.
--   3. Backfills agent-owned rows: owner_id = owner_agent_id, owner_type =
--      'agent', provider_agent_id = owner_agent_id.
--   4. Replaces the (owner_agent_id, name) uniqueness with a polymorphic
--      (owner_id, owner_type, name) constraint.
--   5. Keeps owner_agent_id as a NULLable deprecated mirror so old code
--      that still reads it on agent-owned products keeps working during
--      rollout. PR C drops it.

-- ---------------------------------------------------------------------------
-- 1. Add new columns (nullable initially so backfill can run)
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_products
    ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);

ALTER TABLE subscription_products
    ADD COLUMN IF NOT EXISTS owner_type participanttype;

ALTER TABLE subscription_products
    ADD COLUMN IF NOT EXISTS provider_agent_id VARCHAR(32)
    REFERENCES agents(agent_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill: every existing product is agent-owned
-- ---------------------------------------------------------------------------

UPDATE subscription_products
SET owner_id = owner_agent_id,
    owner_type = 'agent',
    provider_agent_id = owner_agent_id
WHERE owner_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Tighten constraints
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_products
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN owner_type SET NOT NULL,
    ALTER COLUMN provider_agent_id SET NOT NULL;

-- owner_agent_id retained as deprecated read-only mirror — make NULLable so
-- future human-owned inserts can leave it blank.
ALTER TABLE subscription_products
    ALTER COLUMN owner_agent_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Swap uniqueness constraint
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_products
    DROP CONSTRAINT IF EXISTS uq_subscription_product_owner_name;

ALTER TABLE subscription_products
    ADD CONSTRAINT uq_subscription_product_owner_name
    UNIQUE (owner_id, owner_type, name);

CREATE INDEX IF NOT EXISTS ix_subscription_products_owner
    ON subscription_products(owner_id, owner_type);

CREATE INDEX IF NOT EXISTS ix_subscription_products_provider
    ON subscription_products(provider_agent_id);

-- Migration 013: add stable claim_code for agent claim links
-- Ensures existing deployments can load Agent ORM with new claim_code column.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS claim_code VARCHAR(64);

UPDATE agents
SET claim_code = 'clm_' || replace(gen_random_uuid()::text, '-', '')
WHERE claim_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ix_agents_claim_code
    ON agents(claim_code);

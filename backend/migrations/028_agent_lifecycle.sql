-- Agent lifecycle columns for the Phase A unbind rollout.
--
-- This migration only introduces the lifecycle shape needed by the compatible
-- /binding route. PR1 writes daemon_instance_id/hosting_kind from provision_agent
-- so later delete/outbox work can route daemon revocation frames without another
-- backfill. Hard delete behavior and deprovision_outbox are intentionally left
-- to follow-up phases.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS daemon_instance_id VARCHAR(32)
    REFERENCES daemon_instances(id) ON DELETE SET NULL;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS hosting_kind VARCHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_agents_hosting_kind'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT ck_agents_hosting_kind
      CHECK (hosting_kind IS NULL OR hosting_kind IN ('daemon', 'plugin', 'cli'))
      NOT VALID;
  END IF;
END $$;

ALTER TABLE agents
  ALTER COLUMN claim_code DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ix_agents_status_active
  ON agents(status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ix_agents_status_deleted
  ON agents(status)
  WHERE status = 'deleted';

CREATE INDEX IF NOT EXISTS ix_agents_daemon_instance
  ON agents(daemon_instance_id)
  WHERE daemon_instance_id IS NOT NULL;

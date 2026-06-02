ALTER TABLE agent_schedules
  ADD COLUMN IF NOT EXISTS session_policy varchar(32) NULL;

ALTER TABLE agent_schedules
  ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_agent_schedules_session_policy'
      AND conrelid = 'agent_schedules'::regclass
  ) THEN
    ALTER TABLE agent_schedules
      ADD CONSTRAINT ck_agent_schedules_session_policy
      CHECK (session_policy IS NULL OR session_policy IN ('fresh_per_run', 'reuse_per_schedule'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_agent_schedules_session_epoch'
      AND conrelid = 'agent_schedules'::regclass
  ) THEN
    ALTER TABLE agent_schedules
      ADD CONSTRAINT ck_agent_schedules_session_epoch
      CHECK (session_epoch >= 1);
  END IF;
END $$;

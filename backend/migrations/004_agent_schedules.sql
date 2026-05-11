CREATE TABLE IF NOT EXISTS agent_schedules (
  id text PRIMARY KEY,
  agent_id varchar(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  user_id uuid NULL,
  name varchar(80) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  schedule_json json NOT NULL,
  payload_json json NOT NULL,
  created_by varchar(16) NOT NULL DEFAULT 'owner',
  next_fire_at timestamptz NULL,
  last_fire_at timestamptz NULL,
  locked_until timestamptz NULL,
  locked_by varchar(64) NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_agent_schedules_agent_name UNIQUE (agent_id, name)
);

CREATE INDEX IF NOT EXISTS ix_agent_schedules_due
  ON agent_schedules(enabled, next_fire_at);

CREATE INDEX IF NOT EXISTS ix_agent_schedules_agent
  ON agent_schedules(agent_id);

CREATE INDEX IF NOT EXISTS ix_agent_schedules_user
  ON agent_schedules(user_id);

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
  id text PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  agent_id varchar(32) NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  status varchar(24) NOT NULL DEFAULT 'queued',
  error text NULL,
  dedupe_key varchar(128) NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_agent_schedule_runs_dedupe_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS ix_agent_schedule_runs_schedule
  ON agent_schedule_runs(schedule_id, scheduled_for);

CREATE INDEX IF NOT EXISTS ix_agent_schedule_runs_agent
  ON agent_schedule_runs(agent_id, scheduled_for);

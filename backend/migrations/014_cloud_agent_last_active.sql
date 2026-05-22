-- Cloud Agent activity tracking. Adds a dedicated `last_active_at` column to
-- `cloud_agent_instances` so the idle-pause sweep can recognize ongoing
-- agent use (inbound messages that would wake the runtime, outbound sends,
-- owner-chat traffic, gateway control frames) without relying on
-- `updated_at`, which the ORM bumps on unrelated status writes.
--
-- See backend/hub/services/cloud_agent_activity.py for the event-side stamps
-- and backend/hub/services/cloud_agent.py:_cloud_agent_last_activity_at for
-- the consumer.

ALTER TABLE cloud_agent_instances
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_cloud_agent_instances_last_active
    ON cloud_agent_instances (last_active_at);

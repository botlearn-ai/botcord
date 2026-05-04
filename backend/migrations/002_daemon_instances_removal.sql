-- Device removal lifecycle for daemon_instances.
--
-- `removal_requested_at` marks a device as scheduled for removal but still
-- allowed to reconnect to drain pending local cleanup. `revoked_at` remains
-- terminal; we only set it after cleanup drains (or when the user explicitly
-- forgets an offline device).

ALTER TABLE daemon_instances
    ADD COLUMN IF NOT EXISTS removal_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS removal_reason TEXT,
    ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_daemon_instances_removal_pending
    ON daemon_instances (user_id)
    WHERE removal_requested_at IS NOT NULL AND revoked_at IS NULL;

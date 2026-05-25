-- Raise Cloud Agent sandbox capacity to five Bots.
-- Existing rows may have been created with lower environment defaults; lift
-- those rows so users can immediately use the new capacity after migration.

ALTER TABLE cloud_daemon_instances
    ALTER COLUMN max_agents SET DEFAULT 5;

UPDATE cloud_daemon_instances
SET max_agents = 5
WHERE max_agents < 5;

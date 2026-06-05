-- Persist the running @botcord/daemon package version learned from runtime snapshots.

ALTER TABLE daemon_instances
  ADD COLUMN IF NOT EXISTS daemon_version VARCHAR(64);

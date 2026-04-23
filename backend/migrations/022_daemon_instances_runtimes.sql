-- 022_daemon_instances_runtimes.sql
-- Add runtime discovery snapshot columns to daemon_instances. Idempotent.

alter table daemon_instances
    add column if not exists runtimes_json jsonb;

alter table daemon_instances
    add column if not exists runtimes_probed_at timestamptz;

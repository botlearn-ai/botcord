-- Enforce the product invariant: one active cloud daemon sandbox per user.
-- Terminal/failed rows remain historical records and do not block creating a
-- fresh active sandbox.

CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_daemon_instances_user_active
    ON cloud_daemon_instances (user_id)
    WHERE status IN ('creating', 'starting', 'ready', 'paused');

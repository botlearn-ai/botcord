-- Convert waitlist user_id index to unique index (prevents concurrent duplicate entries).
-- Safe to run if 017 already executed with the non-unique index.

DROP INDEX IF EXISTS ix_beta_waitlist_entries_user_id;
CREATE UNIQUE INDEX IF NOT EXISTS ix_beta_waitlist_entries_user_id ON beta_waitlist_entries (user_id);

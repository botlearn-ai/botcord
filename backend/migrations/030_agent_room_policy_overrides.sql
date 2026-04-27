-- Per-room attention overrides for agents.
--
-- Sparse table: rows exist only when the user wants a specific room to differ
-- from the agent's global default. NULL columns mean "inherit from the agent".
-- ``muted_until`` is a transient snooze timestamp (e.g. "today only"); the
-- resolver in hub/policy.py treats past timestamps as no-op.
--
-- This migration only covers the attention axis (per design doc §3.2). The
-- admission policy is intentionally NOT room-scoped — it is a Hub-side hard
-- constraint and per-room loosening would balloon the audit surface.

CREATE TABLE IF NOT EXISTS agent_room_policy_overrides (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        TEXT        NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  room_id         TEXT        NOT NULL REFERENCES rooms(room_id)   ON DELETE CASCADE,
  attention_mode  TEXT,
  keywords        TEXT,
  muted_until     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_arpo_agent_room UNIQUE (agent_id, room_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_arpo_attention_mode'
  ) THEN
    ALTER TABLE agent_room_policy_overrides
      ADD CONSTRAINT ck_arpo_attention_mode
      CHECK (attention_mode IS NULL
             OR attention_mode IN ('always','mention_only','keyword','muted'))
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_arpo_agent
  ON agent_room_policy_overrides (agent_id);

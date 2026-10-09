-- Hub-side execution decisions (docs/access-graph-model.md §8 PR 4):
--   * access_edges.capability — how far a non-owner may make the agent act
--     through a connection / offer / agent-member edge; owned by the edge.
--   * access_graph_settings.legacy_full_before — relations that already
--     existed when this migration ran keep full capability; newer ones start
--     as 'consult'. Organization rooms are always 'consult'.
--   * agent_sender_reply_rules — per-sender attention rules.
-- Apply after 008_access_graph.sql, using the configured Hub schema.
BEGIN;

ALTER TABLE access_edges ADD COLUMN IF NOT EXISTS capability VARCHAR(16);

CREATE TABLE IF NOT EXISTS access_graph_settings (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO access_graph_settings (key, value)
    VALUES ('legacy_full_before', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'))
    ON CONFLICT (key) DO NOTHING;

-- Edges projected before this migration are all legacy relations.
UPDATE access_edges SET capability = 'full'
    WHERE capability IS NULL AND kind IN ('connection', 'offer');
UPDATE access_edges e SET capability = CASE WHEN r.space_id IS NULL THEN 'full' ELSE 'consult' END
    FROM rooms r
    WHERE e.capability IS NULL AND e.kind = 'member' AND e.from_kind = 'agent' AND r.room_id = e.to_id;

CREATE TABLE IF NOT EXISTS agent_sender_reply_rules (
    id BIGSERIAL PRIMARY KEY,
    agent_id VARCHAR(32) NOT NULL REFERENCES agents (agent_id) ON DELETE CASCADE,
    sender_id VARCHAR(32) NOT NULL,
    room_scope VARCHAR(64) NOT NULL DEFAULT '',
    attention_mode VARCHAR(32) NOT NULL,
    keywords TEXT,
    muted_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asrr_agent_sender_room
    ON agent_sender_reply_rules (agent_id, sender_id, room_scope);

COMMIT;

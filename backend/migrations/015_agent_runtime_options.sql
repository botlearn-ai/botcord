-- Persist per-agent runtime selector options chosen from daemon-discovered
-- model catalogs. These mirror into local daemon credentials and managed
-- routes, while Hub remains the source of truth for dashboard edits.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS runtime_model VARCHAR(128);

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(64);

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS thinking BOOLEAN;

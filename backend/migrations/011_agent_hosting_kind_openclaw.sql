ALTER TABLE agents
    DROP CONSTRAINT IF EXISTS ck_agents_hosting_kind;

UPDATE agents
SET hosting_kind = NULL
WHERE hosting_kind IS NOT NULL
  AND hosting_kind NOT IN ('daemon', 'openclaw', 'cli', 'cloud');

ALTER TABLE agents
    ADD CONSTRAINT ck_agents_hosting_kind
    CHECK (hosting_kind IS NULL OR hosting_kind IN ('daemon', 'openclaw', 'cli', 'cloud'));

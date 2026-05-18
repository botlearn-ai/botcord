ALTER TABLE agents
    DROP CONSTRAINT IF EXISTS ck_agents_hosting_kind;

ALTER TABLE agents
    ADD CONSTRAINT ck_agents_hosting_kind
    CHECK (hosting_kind IS NULL OR hosting_kind IN ('daemon', 'openclaw', 'cli'));

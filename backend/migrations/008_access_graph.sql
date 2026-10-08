-- Access graph: principal registry + typed directed edges (docs/access-graph-model.md).
-- Apply after 007_org_rooms.sql, using the configured Hub schema.
-- Rows are projected from legacy tables by hub.services.access_graph_sync
-- (run scripts/sync_access_graph.py once after applying; the Hub then keeps
-- them in sync in the background).
BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS principal_id VARCHAR(32);
UPDATE organizations SET principal_id = 'og_' || substr(md5(random()::text || id::text), 1, 12)
    WHERE principal_id IS NULL;
ALTER TABLE organizations ALTER COLUMN principal_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_principal_id ON organizations (principal_id);

CREATE TABLE IF NOT EXISTS principals (
    id VARCHAR(32) PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    avatar_url TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_principal_kind CHECK (kind IN ('user', 'agent', 'organization', 'public'))
);

CREATE TABLE IF NOT EXISTS access_edges (
    id UUID PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    from_id VARCHAR(32) NOT NULL REFERENCES principals (id),
    from_kind VARCHAR(16) NOT NULL,
    to_id VARCHAR(64) NOT NULL,
    to_kind VARCHAR(16) NOT NULL,
    scope_org_id VARCHAR(32) NOT NULL DEFAULT '',
    role VARCHAR(32),
    terms JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    issued_by VARCHAR(32),
    source VARCHAR(96) UNIQUE,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_access_edge_kind CHECK (kind IN ('ownership', 'membership', 'member', 'grant', 'manage',
        'offer', 'order', 'connection', 'block')),
    CONSTRAINT ck_access_edge_status CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
    CONSTRAINT ck_access_edge_version CHECK (version > 0),
    CONSTRAINT ck_access_edge_endpoints CHECK (
        (kind = 'ownership' AND from_kind IN ('user', 'organization') AND to_kind = 'agent') OR
        (kind = 'membership' AND from_kind IN ('user', 'agent') AND to_kind = 'organization') OR
        (kind = 'member' AND from_kind IN ('user', 'agent') AND to_kind = 'conversation') OR
        (kind IN ('grant', 'manage') AND from_kind = 'user' AND to_kind = 'agent') OR
        (kind = 'offer' AND from_kind = 'public' AND to_kind = 'agent') OR
        (kind = 'order' AND from_kind IN ('user', 'organization') AND to_kind = 'agent') OR
        (kind IN ('connection', 'block') AND from_kind IN ('user', 'agent') AND to_kind IN ('user', 'agent'))
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_edges_live ON access_edges (kind, from_id, to_id, scope_org_id)
    WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS ix_access_edges_from ON access_edges (from_id, kind, status);
CREATE INDEX IF NOT EXISTS ix_access_edges_to ON access_edges (to_id, kind, status);
CREATE INDEX IF NOT EXISTS ix_access_edges_scope ON access_edges (scope_org_id, kind);

CREATE TABLE IF NOT EXISTS access_edge_deps (
    edge_id UUID NOT NULL REFERENCES access_edges (id) ON DELETE CASCADE,
    depends_on_edge_id UUID NOT NULL REFERENCES access_edges (id) ON DELETE CASCADE,
    depends_on_version INTEGER NOT NULL,
    PRIMARY KEY (edge_id, depends_on_edge_id)
);
CREATE INDEX IF NOT EXISTS ix_access_edge_deps_depends_on ON access_edge_deps (depends_on_edge_id);

CREATE TABLE IF NOT EXISTS access_edge_events (
    id BIGSERIAL PRIMARY KEY,
    edge_id UUID NOT NULL,
    event VARCHAR(16) NOT NULL,
    actor_id VARCHAR(32),
    version INTEGER NOT NULL,
    before JSONB,
    after JSONB,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_access_edge_events_edge_id ON access_edge_events (edge_id);

COMMIT;

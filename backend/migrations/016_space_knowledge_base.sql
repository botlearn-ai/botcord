-- Space knowledge base: markdown tree per Space, agentic retrieval (tree/cat/grep/search).
-- See docs/space-knowledge-base-design.md.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS kb_nodes (
    node_id VARCHAR(32) PRIMARY KEY,
    space_id UUID NOT NULL REFERENCES spaces(id),
    path VARCHAR(512) NOT NULL,
    kind VARCHAR(8) NOT NULL,
    title VARCHAR(256),
    description TEXT,
    description_source VARCHAR(8),
    summary TEXT,
    summary_source VARCHAR(8),
    summary_source_hash VARCHAR(64),
    tags JSON NOT NULL DEFAULT '[]',
    content TEXT,
    content_hash VARCHAR(64),
    size_bytes INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    published_revision_id VARCHAR(32),
    pending_count INTEGER NOT NULL DEFAULT 0,
    source_refs JSON NOT NULL DEFAULT '[]',
    created_by VARCHAR(32) NOT NULL,
    updated_by VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT ck_kb_node_kind CHECK (kind IN ('dir', 'page')),
    CONSTRAINT ck_kb_node_version CHECK (version >= 0),
    CONSTRAINT ck_kb_node_description_source CHECK (description_source IS NULL OR description_source IN ('human', 'agent')),
    CONSTRAINT ck_kb_node_summary_source CHECK (summary_source IS NULL OR summary_source IN ('human', 'agent'))
);
CREATE INDEX IF NOT EXISTS ix_kb_nodes_space_id ON kb_nodes (space_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_nodes_space_path_live ON kb_nodes (space_id, path) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_kb_nodes_path_prefix ON kb_nodes (space_id, path text_pattern_ops);
CREATE INDEX IF NOT EXISTS ix_kb_nodes_content_trgm ON kb_nodes USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_kb_nodes_meta_trgm ON kb_nodes
    USING gin ((coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(summary, '')) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS kb_revisions (
    revision_id VARCHAR(32) PRIMARY KEY,
    node_id VARCHAR(32) NOT NULL REFERENCES kb_nodes(node_id),
    space_id UUID NOT NULL REFERENCES spaces(id),
    base_version INTEGER NOT NULL,
    kind VARCHAR(8) NOT NULL DEFAULT 'content',
    title VARCHAR(256),
    description TEXT,
    summary TEXT,
    tags JSON,
    content TEXT,
    source_refs JSON,
    status VARCHAR(16) NOT NULL,
    author VARCHAR(32) NOT NULL,
    reviewer VARCHAR(32),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    CONSTRAINT ck_kb_revision_status CHECK (status IN ('proposed', 'published', 'rejected', 'superseded'))
);
CREATE INDEX IF NOT EXISTS ix_kb_revisions_node_id ON kb_revisions (node_id);
CREATE INDEX IF NOT EXISTS ix_kb_revisions_space_status ON kb_revisions (space_id, status);
COMMIT;

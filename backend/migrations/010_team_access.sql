-- Team access UX (docs/access-graph-model.md): per-agent default capability
-- for new non-owner relations, and organization access requests.
-- Apply after 009_access_capability_reply_rules.sql, using the configured Hub schema.
BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS non_owner_capability VARCHAR(16) NOT NULL DEFAULT 'consult';

CREATE TABLE IF NOT EXISTS agent_access_requests (
    id UUID PRIMARY KEY,
    space_id UUID NOT NULL REFERENCES spaces (id),
    agent_id VARCHAR(32) NOT NULL REFERENCES agents (agent_id),
    requester_user_id UUID NOT NULL REFERENCES public.users (id),
    requested_role VARCHAR(16) NOT NULL,
    message TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    decided_by_user_id UUID REFERENCES public.users (id),
    decided_at TIMESTAMPTZ,
    grant_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_access_request_role CHECK (requested_role IN ('consultant', 'collaborator')),
    CONSTRAINT ck_access_request_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS ix_access_requests_space_agent ON agent_access_requests (space_id, agent_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_requests_pending
    ON agent_access_requests (space_id, agent_id, requester_user_id) WHERE status = 'pending';

COMMIT;

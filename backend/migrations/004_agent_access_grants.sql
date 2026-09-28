-- Agent sharing P1: an agent owner lets one organization member call the agent.
-- Apply after 002_team_identity_spaces.sql, using the configured Hub schema.
BEGIN;

CREATE TABLE IF NOT EXISTS agent_access_grants (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    agent_membership_id UUID NOT NULL,
    agent_membership_version INTEGER NOT NULL,
    grantee_user_id UUID NOT NULL,
    grantee_membership_id UUID NOT NULL,
    grantee_membership_version INTEGER NOT NULL,
    role VARCHAR(16) NOT NULL,
    workspace_path TEXT,
    allowed_commands JSON DEFAULT '[]' NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_by_user_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT ck_agent_access_grant_role CHECK (role IN ('consultant', 'collaborator')),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    FOREIGN KEY(agent_id) REFERENCES agents (agent_id),
    FOREIGN KEY(agent_membership_id) REFERENCES space_agent_memberships (id),
    FOREIGN KEY(grantee_user_id) REFERENCES public.users (id),
    FOREIGN KEY(grantee_membership_id) REFERENCES space_user_memberships (id),
    FOREIGN KEY(created_by_user_id) REFERENCES public.users (id)
);

CREATE INDEX IF NOT EXISTS ix_agent_access_grants_agent_grantee ON agent_access_grants (agent_id, grantee_user_id);
CREATE INDEX IF NOT EXISTS ix_agent_access_grants_space_grantee ON agent_access_grants (space_id, grantee_user_id);

COMMIT;

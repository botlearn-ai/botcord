-- Team identity foundation only; existing resources and communication are unchanged.

BEGIN;

CREATE TABLE IF NOT EXISTS spaces (
    id UUID NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) DEFAULT 'active' NOT NULL,
    policy_version INTEGER DEFAULT '1' NOT NULL,
    settings JSON DEFAULT '{}' NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT ck_space_kind CHECK (kind IN ('personal', 'organization')),
    CONSTRAINT ck_space_status CHECK (status IN ('active', 'suspended', 'archived')),
    CONSTRAINT ck_space_version CHECK (policy_version > 0)
);

CREATE TABLE IF NOT EXISTS organizations (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    slug VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (space_id),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS personal_spaces (
    space_id UUID NOT NULL,
    user_id UUID NOT NULL,
    PRIMARY KEY (space_id),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    UNIQUE (user_id),
    FOREIGN KEY(user_id) REFERENCES public.users (id)
);

CREATE TABLE IF NOT EXISTS space_audit_events (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    actor_user_id UUID NOT NULL,
    action VARCHAR(64) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    details JSON DEFAULT '{}' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    FOREIGN KEY(actor_user_id) REFERENCES public.users (id)
);

CREATE INDEX IF NOT EXISTS ix_space_audit_events_space_id ON space_audit_events (space_id);

CREATE TABLE IF NOT EXISTS space_user_memberships (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    user_id UUID NOT NULL,
    status VARCHAR(16) DEFAULT 'active' NOT NULL,
    version INTEGER DEFAULT '1' NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (space_id, user_id),
    UNIQUE (space_id, id),
    CONSTRAINT ck_space_user_status CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
    CONSTRAINT ck_space_user_version CHECK (version > 0),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    FOREIGN KEY(user_id) REFERENCES public.users (id)
);

CREATE TABLE IF NOT EXISTS agent_ownerships (
    agent_id VARCHAR(32) NOT NULL,
    owner_user_id UUID,
    owner_organization_id UUID,
    PRIMARY KEY (agent_id),
    CONSTRAINT ck_agent_exactly_one_owner CHECK ((owner_user_id IS NOT NULL AND owner_organization_id IS NULL) OR (owner_user_id IS NULL AND owner_organization_id IS NOT NULL)),
    FOREIGN KEY(agent_id) REFERENCES agents (agent_id),
    FOREIGN KEY(owner_user_id) REFERENCES public.users (id),
    FOREIGN KEY(owner_organization_id) REFERENCES organizations (id)
);

CREATE TABLE IF NOT EXISTS organization_policies (
    organization_id UUID NOT NULL,
    admin_dm_content_access_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    external_communication_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    PRIMARY KEY (organization_id),
    FOREIGN KEY(organization_id) REFERENCES organizations (id)
);

CREATE TABLE IF NOT EXISTS space_agent_memberships (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    sponsor_user_membership_id UUID NOT NULL,
    sponsor_version INTEGER NOT NULL,
    status VARCHAR(16) DEFAULT 'invited' NOT NULL,
    version INTEGER DEFAULT '1' NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (space_id, agent_id),
    UNIQUE (space_id, id),
    FOREIGN KEY(space_id, sponsor_user_membership_id) REFERENCES space_user_memberships (space_id, id),
    CONSTRAINT ck_space_agent_status CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
    CONSTRAINT ck_space_agent_version CHECK (version > 0 AND sponsor_version > 0),
    FOREIGN KEY(space_id) REFERENCES spaces (id),
    FOREIGN KEY(agent_id) REFERENCES agents (agent_id)
);

CREATE TABLE IF NOT EXISTS space_agent_profiles (
    membership_id UUID NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    bio TEXT,
    function_label VARCHAR(128),
    PRIMARY KEY (membership_id),
    FOREIGN KEY(membership_id) REFERENCES space_agent_memberships (id)
);

CREATE TABLE IF NOT EXISTS space_role_bindings (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    user_membership_id UUID,
    agent_membership_id UUID,
    role_key VARCHAR(16) NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(space_id, user_membership_id) REFERENCES space_user_memberships (space_id, id),
    FOREIGN KEY(space_id, agent_membership_id) REFERENCES space_agent_memberships (space_id, id),
    UNIQUE (user_membership_id, role_key),
    UNIQUE (agent_membership_id, role_key),
    CONSTRAINT ck_space_role_subject CHECK ((user_membership_id IS NOT NULL AND agent_membership_id IS NULL AND role_key IN ('owner', 'admin', 'member')) OR (user_membership_id IS NULL AND agent_membership_id IS NOT NULL AND role_key = 'participant')),
    FOREIGN KEY(space_id) REFERENCES spaces (id)
);

COMMIT;

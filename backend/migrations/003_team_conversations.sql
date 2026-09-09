-- Organization conversations are separate from legacy personal Rooms.
-- Apply after 002_team_identity_spaces.sql, using the configured Hub schema.
BEGIN;

CREATE TABLE IF NOT EXISTS team_conversations (
    id UUID NOT NULL,
    space_id UUID NOT NULL,
    creator_membership_id UUID NOT NULL,
    kind VARCHAR(8) NOT NULL,
    visibility VARCHAR(16) NOT NULL,
    name VARCHAR(128) NOT NULL,
    dm_key VARCHAR(128),
    last_sequence INTEGER DEFAULT '0' NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (space_id, id),
    UNIQUE (space_id, dm_key),
    CONSTRAINT ck_team_conversation_kind CHECK (kind IN ('room', 'dm')),
    CONSTRAINT ck_team_conversation_visibility CHECK (visibility IN ('organization', 'private')),
    CONSTRAINT ck_team_dm_private CHECK (kind != 'dm' OR (visibility = 'private' AND dm_key IS NOT NULL)),
    CONSTRAINT ck_team_conversation_sequence CHECK (last_sequence >= 0),
    FOREIGN KEY(space_id, creator_membership_id) REFERENCES space_user_memberships (space_id, id),
    FOREIGN KEY(space_id) REFERENCES spaces (id)
);

CREATE INDEX IF NOT EXISTS ix_team_conversations_space_updated ON team_conversations (space_id, updated_at);

CREATE TABLE IF NOT EXISTS team_conversation_members (
    conversation_id UUID NOT NULL,
    membership_id UUID NOT NULL,
    space_id UUID NOT NULL,
    membership_version INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, membership_id),
    FOREIGN KEY(space_id, conversation_id) REFERENCES team_conversations (space_id, id),
    FOREIGN KEY(space_id, membership_id) REFERENCES space_user_memberships (space_id, id),
    CONSTRAINT ck_team_participant_version CHECK (membership_version > 0)
);

CREATE TABLE IF NOT EXISTS team_messages (
    conversation_id UUID NOT NULL,
    sequence INTEGER NOT NULL,
    space_id UUID NOT NULL,
    author_membership_id UUID NOT NULL,
    client_id UUID NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (conversation_id, sequence),
    FOREIGN KEY(space_id, conversation_id) REFERENCES team_conversations (space_id, id),
    FOREIGN KEY(space_id, author_membership_id) REFERENCES space_user_memberships (space_id, id),
    UNIQUE (conversation_id, author_membership_id, client_id),
    CONSTRAINT ck_team_message_sequence CHECK (sequence > 0)
);

CREATE TABLE IF NOT EXISTS team_conversation_reads (
    conversation_id UUID NOT NULL,
    membership_id UUID NOT NULL,
    space_id UUID NOT NULL,
    last_sequence INTEGER DEFAULT '0' NOT NULL,
    PRIMARY KEY (conversation_id, membership_id),
    FOREIGN KEY(space_id, conversation_id) REFERENCES team_conversations (space_id, id),
    FOREIGN KEY(space_id, membership_id) REFERENCES space_user_memberships (space_id, id),
    CONSTRAINT ck_team_read_sequence CHECK (last_sequence >= 0)
);

COMMIT;

create table if not exists invites (
    id integer primary key generated always as identity,
    code varchar(32) not null unique,
    kind varchar(16) not null,
    creator_agent_id varchar(32) not null references agents(agent_id),
    room_id varchar(64) references rooms(room_id),
    expires_at timestamptz,
    max_uses integer not null default 1,
    use_count integer not null default 0,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists ix_invites_creator_kind on invites (creator_agent_id, kind);
create index if not exists ix_invites_room_id on invites (room_id);

create table if not exists invite_redemptions (
    id integer primary key generated always as identity,
    code varchar(32) not null references invites(code),
    redeemer_agent_id varchar(32) not null references agents(agent_id),
    created_at timestamptz not null default now(),
    constraint uq_invite_redemption unique (code, redeemer_agent_id)
);

create index if not exists ix_invite_redemptions_redeemer on invite_redemptions (redeemer_agent_id);

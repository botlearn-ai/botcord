create table if not exists short_codes (
    id serial primary key,
    code varchar(32) not null,
    kind varchar(32) not null,
    owner_user_id uuid null,
    payload_json text not null default '{}',
    expires_at timestamptz not null,
    max_uses integer not null default 1,
    use_count integer not null default 0,
    consumed_at timestamptz null,
    created_at timestamptz not null default now(),
    constraint uq_short_codes_code unique (code)
);

create index if not exists ix_short_codes_code
on short_codes (code);

create index if not exists ix_short_codes_kind_created
on short_codes (kind, created_at);

create index if not exists ix_short_codes_owner_created
on short_codes (owner_user_id, created_at);

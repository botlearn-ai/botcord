create table if not exists daemon_instances (
    id                  varchar(32)  primary key,
    user_id             uuid         not null,
    label               varchar(64)  null,
    refresh_token_hash  varchar(128) not null,
    created_at          timestamptz  not null default now(),
    last_seen_at        timestamptz  null,
    revoked_at          timestamptz  null
);

create index if not exists ix_daemon_instances_user
on daemon_instances (user_id);

create index if not exists ix_daemon_instances_refresh_hash
on daemon_instances (refresh_token_hash);

create table if not exists daemon_device_codes (
    device_code         varchar(64)  primary key,
    user_code           varchar(16)  not null,
    user_id             uuid         null,
    daemon_instance_id  varchar(32)  null,
    expires_at          timestamptz  not null,
    approved_at         timestamptz  null,
    consumed_at         timestamptz  null,
    status              varchar(16)  not null default 'pending',
    issued_token_json   text         null,
    label               varchar(64)  null,
    created_at          timestamptz  not null default now(),
    constraint uq_daemon_device_codes_user_code unique (user_code)
);

create index if not exists ix_daemon_device_codes_status
on daemon_device_codes (status, expires_at);

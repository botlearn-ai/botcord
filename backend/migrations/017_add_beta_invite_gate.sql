-- Beta invite gate: invite codes, redemptions, waitlist, and user access flags.

create type betacodestatus as enum ('active', 'revoked');
create type betawaitliststatus as enum ('pending', 'approved', 'rejected');

create table if not exists beta_invite_codes (
    id uuid primary key default gen_random_uuid(),
    code varchar(64) not null unique,
    label varchar(128) not null default '',
    max_uses integer not null default 1,
    used_count integer not null default 0,
    created_by varchar(256) not null default '',
    expires_at timestamptz,
    status betacodestatus not null default 'active',
    created_at timestamptz not null default now()
);

create index if not exists ix_beta_invite_codes_code on beta_invite_codes (code);
create index if not exists ix_beta_invite_codes_status on beta_invite_codes (status);

create table if not exists beta_code_redemptions (
    id uuid primary key default gen_random_uuid(),
    code_id uuid not null references beta_invite_codes(id),
    user_id uuid not null unique references public.users(id),
    redeemed_at timestamptz not null default now()
);

create index if not exists ix_beta_code_redemptions_code_id on beta_code_redemptions (code_id);

create table if not exists beta_waitlist_entries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id),
    email varchar(256) not null,
    note text,
    status betawaitliststatus not null default 'pending',
    applied_at timestamptz not null default now(),
    reviewed_at timestamptz,
    sent_code_id uuid references beta_invite_codes(id)
);

create unique index if not exists ix_beta_waitlist_entries_user_id on beta_waitlist_entries (user_id);
create index if not exists ix_beta_waitlist_entries_status on beta_waitlist_entries (status);

alter table public.users
    add column if not exists beta_access boolean not null default false,
    add column if not exists beta_admin boolean not null default false;

-- One-time bind ticket JTI tracking to prevent replay attacks.
-- No FK to agents — the ticket may be consumed before the agent row exists.

create table if not exists used_bind_tickets (
    id serial primary key,
    jti varchar(64) not null unique,
    created_at timestamptz not null default now()
);

create index if not exists ix_used_bind_tickets_created_at
on used_bind_tickets (created_at);

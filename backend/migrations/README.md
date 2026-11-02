# SQL Migrations

Incremental schema deltas for databases that already hold data. Fresh
databases get the full schema from `Base.metadata.create_all` at Hub
startup (`hub/main.py`) — migrations here are only for evolving live
environments.

## Baseline reset — 2026-06-10

All previously applied migrations (`001`–`031`) were deleted after
confirming both prod (`czgzvulavmtexfqagccy`) and preview
(`fzchrymqyrzolvkfwgds`) had fully applied them. The
`_botcord_schema_migrations` ledger tables were truncated at the same
time (backups: `~/botcord-migration-ledger-backup/` on zhejian's
machine). The ORM models are the schema baseline as of this date.

New migrations start fresh from `001_*.sql`.

## How it works

- `make migrate` (or `uv run python scripts/run_sql_migrations.py`)
  applies any `*.sql` file here whose filename is not yet recorded in
  `_botcord_schema_migrations`, in lexicographic order.
- CI: `.github/workflows/db-migrate.yml` (manual dispatch, preview or
  production) runs the same script.
- Exception: migration 018 is refused by this generic runner. The US backend
  deploy workflow coordinates stopping old writers, applying 018 and its ledger
  atomically, backfilling, validating, and restarting. Use `run_migrations=false`
  for the PR preview and backend release entry points; their backend deployment
  gate handles 018 automatically using the running Hub's database configuration.
- Write idempotent SQL (`IF NOT EXISTS` / `IF EXISTS`) — the runner
  records success per file, but reruns after partial failure execute
  the whole file again.

Note: `frontend/db/functions/*.sql` (realtime auth functions/policies
etc.) are NOT migrations — they are deployed per Supabase project via
`pnpm db:functions` and must be run against every new environment.

`017_conversation_directory.sql` 创建会话读取模型及变更捕获，并排队已有房间。应用后需用新版代码执行 `uv run python scripts/backfill_conversations.py`，再上线游标前端；部署顺序及可复现压测见 `../../docs/messages-conversation-sync.md`。

### Conversation capture startup / repair

Hub startup now validates an existing PostgreSQL conversation capture installation
without replacing triggers or altering RLS. Fresh databases still install capture
in the table-creation transaction. Existing installations must match the shipped
trigger functions, enabled events, schema/search path and RLS flags. A capture
function change requires a corresponding explicit migration before app rollout.
Migration 018 replaces the 017 definitions with reason-specific capture and logical-message projection. Stop old writers, migrate, backfill with new code, then roll out; mixed versions are not supported. See `../../docs/messages-conversation-sync.md` for validation and rollback.

Before rollout, the authorized database operator can run from `backend/`, with
the intended `DATABASE_URL` and `DATABASE_SCHEMA`:

```sh
uv run python scripts/repair_conversation_capture.py --check
```

If verification reports drift, first identify the cause and arrange a quiet writer
maintenance window. With the target schema already provisioned and the schema
owner/DDL role, run the narrowly scoped repair:

```sh
uv run python scripts/repair_conversation_capture.py --apply
uv run python scripts/repair_conversation_capture.py --check
```

The repair locks source and projection tables, recreates only capture functions
and triggers, enables RLS, and queues existing rooms/entries for reconciliation,
all in one transaction. It does not edit the migration ledger, replay migration
017, run other migrations, or create missing tables. Lock timeout is 5 seconds
and statement timeout 60 seconds; failure rolls everything back. Investigate
contention before another operator-controlled attempt. Shared `public.users`
means other schemas' writers may also need to be quiet. The Hub DB role must own
the projection tables or have BYPASSRLS, as before. After repair, run the normal
conversation backfill procedure to drain queued reconciliation before accepting
business recovery; the SQL check alone is not user-visible recovery proof.

Startup retries only SQLSTATE 40P01/40001/55P03, at most three whole transactions,
with rollback before backoff and a 5-second PostgreSQL lock timeout per attempt.
Permission, missing/old capture and other failures remain startup failures.
This does not serialize concurrent fresh schema creation or replace a controlled
migration window. The SQL migration workflow remains separate from app deploy;
the generic runner's file execution and ledger write are not one transaction.

`018_incremental_conversation_projection.sql` 增加消息/阅读明细队列、精简逻辑消息、共享房间摘要及账号阅读主体字段。迁移仅排队回填；必须先完成新版回填再恢复业务流量。

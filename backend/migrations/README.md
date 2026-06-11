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
- Write idempotent SQL (`IF NOT EXISTS` / `IF EXISTS`) — the runner
  records success per file, but reruns after partial failure execute
  the whole file again.

Note: `frontend/db/functions/*.sql` (realtime auth functions/policies
etc.) are NOT migrations — they are deployed per Supabase project via
`pnpm db:functions` and must be run against every new environment.

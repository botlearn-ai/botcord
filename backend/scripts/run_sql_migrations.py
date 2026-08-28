"""
Apply numbered SQL files under backend/migrations/ once per database.

Reads DATABASE_URL / DATABASE_SCHEMA from the environment (loading
backend/.env like hub.config does), without importing hub.config —
service-level startup gates there (e.g. required signing keys) must not
block standalone migrations.
Requires the `psql` client on PATH (e.g. Homebrew `libpq`).

Idempotency: records applied filenames in _botcord_schema_migrations.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2 import sql as psql

load_dotenv()

BACKEND_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = BACKEND_ROOT / "migrations"


def _database_url() -> str:
    # Mirrors hub.config._build_database_url (URL or DB_* components).
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASS")
    host = os.getenv("DB_HOST")
    port = os.getenv("DB_PORT", "5432")
    name = os.getenv("DB_NAME")
    if user and host and name:
        return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{name}"
    return "postgresql+asyncpg://botcord:botcord@localhost:5432/botcord"


def _database_schema() -> str | None:
    schema = os.getenv("DATABASE_SCHEMA")
    if schema and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ValueError(f"DATABASE_SCHEMA must be a valid SQL identifier, got: {schema!r}")
    return schema


def _sync_dsn() -> str:
    url = _database_url()
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + url[len("postgresql+asyncpg://") :]
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://") :]
    return url


def _set_search_path(cur, schema: str | None) -> None:
    if schema:
        cur.execute(
            psql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(psql.Identifier(schema))
        )
        cur.execute(
            psql.SQL("SET search_path TO {}, public").format(psql.Identifier(schema))
        )


def _run_psql_file(dsn: str, schema: str | None, path: Path) -> None:
    psql_bin = shutil.which("psql")
    if not psql_bin:
        print(
            "error: `psql` not found on PATH. Install PostgreSQL client tools "
            "(e.g. macOS: brew install libpq && brew link --force libpq).",
            file=sys.stderr,
        )
        sys.exit(1)

    cmd = [psql_bin, dsn, "-v", "ON_ERROR_STOP=1"]
    if schema:
        cmd.extend(["-c", f'SET search_path TO "{schema}", public'])
    cmd.extend(["-f", str(path)])
    subprocess.run(cmd, check=True)


def main() -> None:
    DATABASE_SCHEMA = _database_schema()

    dsn = _sync_dsn()
    sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        print("No .sql files in migrations/.")
        return

    conn = psycopg2.connect(dsn)
    try:
        conn.autocommit = True
        cur = conn.cursor()
        _set_search_path(cur, DATABASE_SCHEMA)
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS _botcord_schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute("SELECT version FROM _botcord_schema_migrations")
        applied = {row[0] for row in cur.fetchall()}
        cur.close()
    finally:
        conn.close()

    failed: list[str] = []
    for path in sql_files:
        version = path.name
        if version in applied:
            print(f"[skip]  {version}")
            continue

        print(f"[apply] {version}")
        try:
            _run_psql_file(dsn, DATABASE_SCHEMA, path)
        except subprocess.CalledProcessError as e:
            print(f"[error] {version} — psql exited with code {e.returncode}", file=sys.stderr)
            failed.append(version)
            continue
        except Exception as e:
            print(f"[error] {version} — {e}", file=sys.stderr)
            failed.append(version)
            continue

        conn = psycopg2.connect(dsn)
        try:
            conn.autocommit = True
            cur = conn.cursor()
            _set_search_path(cur, DATABASE_SCHEMA)
            cur.execute(
                "INSERT INTO _botcord_schema_migrations (version) VALUES (%s)",
                (version,),
            )
            cur.close()
        finally:
            conn.close()

        print(f"[ok]    {version}")

    if failed:
        print(f"\n{len(failed)} migration(s) failed: {', '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

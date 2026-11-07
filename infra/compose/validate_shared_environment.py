#!/usr/bin/env python3
"""Fail closed before a second Hub connects to a shared Supabase project.

The rendered Compose configuration is read from stdin so validation covers the
values Docker will actually use.  Errors name fields only; secret values are
never printed.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.parse import unquote, urlsplit


LOCAL_DATABASE_HOST = "postgres"


def _environment(config: dict[str, Any], service: str) -> dict[str, str]:
    try:
        environment = config["services"][service]["environment"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"missing {service} environment") from exc
    if not isinstance(environment, dict):
        raise ValueError(f"invalid {service} environment")
    return {str(key): "" if value is None else str(value) for key, value in environment.items()}


def _build_args(config: dict[str, Any], service: str) -> dict[str, str]:
    try:
        arguments = config["services"][service]["build"]["args"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"missing {service} build args") from exc
    if not isinstance(arguments, dict):
        raise ValueError(f"invalid {service} build args")
    return {str(key): "" if value is None else str(value) for key, value in arguments.items()}


def _database_target(value: str, field: str) -> tuple[str, int, str, str]:
    parsed = urlsplit(value)
    if parsed.scheme not in {"postgres", "postgresql", "postgresql+asyncpg"}:
        raise ValueError(f"{field} must be a PostgreSQL URL")
    if not parsed.hostname or not parsed.username or not parsed.path.strip("/"):
        raise ValueError(f"{field} must include host, user, and database")
    try:
        port = parsed.port or 5432
    except ValueError as exc:
        raise ValueError(f"{field} has an invalid port") from exc
    return (
        parsed.hostname.lower(),
        port,
        unquote(parsed.username),
        unquote(parsed.path.lstrip("/")),
    )


def _normalized_url(value: str, field: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field} must be an HTTP(S) URL")
    return value.rstrip("/")


def _require(environment: dict[str, str], *fields: str) -> None:
    missing = [field for field in fields if not environment.get(field, "").strip()]
    if missing:
        raise ValueError("missing required shared configuration: " + ", ".join(missing))


def _uses_shared_database(backend: dict[str, str]) -> bool:
    database_url = backend.get("DATABASE_URL", "")
    if database_url:
        try:
            if _database_target(database_url, "DATABASE_URL")[0] != LOCAL_DATABASE_HOST:
                return True
        except ValueError:
            return True
    return any(
        backend.get(field, "").strip()
        for field in (
            "SUPABASE_URL",
            "SUPABASE_JWT_JWKS_URL",
            "SUPABASE_JWT_SECRET",
            "SUPABASE_SERVICE_ROLE_KEY",
        )
    )


def validate(config: dict[str, Any], mode: str) -> None:
    backend = _environment(config, "botcord-backend")
    if mode == "core-up" and not _uses_shared_database(backend):
        return

    _require(backend, "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET")

    if not (backend.get("SUPABASE_JWT_JWKS_URL", "").strip() or backend.get("SUPABASE_JWT_SECRET", "").strip()):
        raise ValueError("SUPABASE_JWT_JWKS_URL or SUPABASE_JWT_SECRET is required")

    _database_target(backend["DATABASE_URL"], "DATABASE_URL")

    if backend.get("DATABASE_SCHEMA", "").strip() != "public":
        raise ValueError("DATABASE_SCHEMA must be public for the shared Supabase database")

    backend_supabase_url = _normalized_url(backend["SUPABASE_URL"], "SUPABASE_URL")

    if backend.get("FILE_STORAGE_BACKEND", "").strip().lower() != "supabase":
        raise ValueError("FILE_STORAGE_BACKEND must be supabase for the shared environment")

    for field in ("BOTCORD_SCHEMA_AUTO_CREATE", "BOTCORD_BACKGROUND_TASKS_ENABLED"):
        if backend.get(field, "").strip().lower() != "false":
            raise ValueError(f"{field} must be false for the shared environment")

    if mode == "core-up":
        return

    frontend = _environment(config, "botcord-frontend")
    build_args = _build_args(config, "botcord-frontend")
    _require(frontend, "SUPABASE_DB_URL", "SUPABASE_INTERNAL_URL")
    _require(build_args, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY")

    if _database_target(backend["DATABASE_URL"], "DATABASE_URL") != _database_target(
        frontend["SUPABASE_DB_URL"], "SUPABASE_DB_URL"
    ):
        raise ValueError("DATABASE_URL and SUPABASE_DB_URL must target the same database")

    supabase_urls = {
        backend_supabase_url,
        _normalized_url(frontend["SUPABASE_INTERNAL_URL"], "SUPABASE_INTERNAL_URL"),
        _normalized_url(build_args["NEXT_PUBLIC_SUPABASE_URL"], "NEXT_PUBLIC_SUPABASE_URL"),
    }
    if len(supabase_urls) != 1:
        raise ValueError("backend, frontend, and public Supabase URLs must match")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("up", "core-up"), required=True)
    arguments = parser.parse_args()
    try:
        config = json.load(sys.stdin)
        validate(config, arguments.mode)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"Shared environment validation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

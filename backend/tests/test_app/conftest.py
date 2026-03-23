"""Shared test configuration for app tests.

Provides a SQLite-compatible engine factory that maps the ``public``
schema to ``None`` so models with ``schema="public"`` work under SQLite.
"""

from sqlalchemy.ext.asyncio import create_async_engine as _create_async_engine

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


def create_test_engine(url: str = TEST_DB_URL):
    """Create an async engine with schema_translate_map for SQLite compat."""
    return _create_async_engine(
        url,
        execution_options={"schema_translate_map": {"public": None}},
    )

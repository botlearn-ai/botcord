"""Regression tests for removed legacy install-claim onboarding routes."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hub.models import Base

from .test_app_user_agents import TEST_SUPABASE_SECRET, _make_supabase_token


@pytest_asyncio.fixture
async def db_engine():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        execution_options={"schema_translate_map": {"public": None}},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_engine, monkeypatch):
    import app.auth
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.database import get_db
    from hub.main import app

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            yield c
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_legacy_bind_ticket_routes_removed(client: AsyncClient):
    token = _make_supabase_token("00000000-0000-0000-0000-000000000001")
    headers = {"Authorization": f"Bearer {token}"}

    post = await client.post("/api/users/me/agents/bind-ticket", headers=headers)
    get = await client.get("/api/users/me/agents/bind-ticket/bd_deadbeef0000", headers=headers)
    delete = await client.delete("/api/users/me/agents/bind-ticket/bd_deadbeef0000", headers=headers)

    assert post.status_code in (404, 405)
    assert get.status_code in (404, 405)
    assert delete.status_code in (404, 405)


@pytest.mark.asyncio
async def test_legacy_install_claim_route_removed(client: AsyncClient):
    resp = await client.post("/api/users/me/agents/install-claim", json={})

    assert resp.status_code in (404, 405)


@pytest.mark.asyncio
async def test_daemon_install_script_served(client: AsyncClient):
    resp = await client.get("/daemon/install.sh")

    assert resp.status_code == 200
    assert "botcord-daemon" in resp.text

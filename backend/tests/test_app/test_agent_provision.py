"""Tests for POST /api/users/me/agents/provision.

Covers the Hub BFF entrypoint for daemon-routed agent creation. Reuses
device-code setup from ``test_daemon_control`` to stand up a
``DaemonInstance`` row, then injects a fake WS connection into the daemon
registry so control-plane dispatch is synchronous and deterministic.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import Agent, Base, DaemonInstance, Role, SigningKey, User, UserRole


TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-agent-provision"


def _supabase_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth

    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from contextlib import asynccontextmanager
    import hub.routers.daemon_control as daemon_control_mod

    @asynccontextmanager
    async def _shared_session():
        yield db_session

    monkeypatch.setattr(daemon_control_mod, "async_session", _shared_session)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession):
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Test User",
        email="test@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=10,
    )
    db_session.add(user)

    role = Role(
        id=uuid.uuid4(),
        name="member",
        display_name="Member",
        is_system=True,
        priority=0,
    )
    db_session.add(role)
    await db_session.flush()

    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()

    return {
        "user_id": user_id,
        "supabase_uid": str(supabase_uuid),
        "token": _supabase_token(str(supabase_uuid)),
    }


class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed_with: tuple[int, str] | None = None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


async def _provision_instance(client: AsyncClient, seed_user) -> str:
    """Run the device-code flow end-to-end; return the daemon_instance_id."""
    r = await client.post("/daemon/auth/device-code")
    issued = r.json()
    r = await client.post(
        "/daemon/auth/device-approve",
        json={"user_code": issued["user_code"]},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    return r.json()["daemon_instance_id"]


async def _with_connected_daemon(
    instance_id: str,
    user_id: uuid.UUID,
    runtimes_snapshot: list | None = None,
    db_session: AsyncSession | None = None,
):
    """Register a fake WS and (optionally) seed a runtimes snapshot on the row."""
    from hub.routers.daemon_control import _DaemonConn, _registry_for_tests

    if runtimes_snapshot is not None and db_session is not None:
        res = await db_session.execute(
            select(DaemonInstance).where(DaemonInstance.id == instance_id)
        )
        inst = res.scalar_one()
        inst.runtimes_json = runtimes_snapshot
        inst.runtimes_probed_at = datetime.datetime.now(datetime.timezone.utc)
        await db_session.commit()

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,
        user_id=str(user_id),
        daemon_instance_id=instance_id,
        pending_acks={},
    )
    registry = _registry_for_tests()
    await registry.register(conn)
    return conn, fake_ws, registry


async def _auto_ack(conn, fake_ws: _FakeWS, *, ok: bool = True, err: dict | None = None):
    """Wait for the dispatcher to write a frame; reply with an ack."""
    for _ in range(100):
        if fake_ws.sent:
            break
        await asyncio.sleep(0.01)
    assert fake_ws.sent, "dispatcher never wrote to the fake WS"
    sent = json.loads(fake_ws.sent[-1])
    ack: dict = {"id": sent["id"], "ok": ok}
    if ok:
        ack["result"] = {"agentId": sent["params"]["credentials"]["agentId"]}
    else:
        ack["error"] = err or {"code": "boom", "message": "simulated"}
    fut = conn.pending_acks.get(sent["id"])
    assert fut is not None
    fut.set_result(ack)
    return sent


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provision_happy_path_writes_runtime_and_dispatches_frame(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, fake_ws, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        runtimes_snapshot=[{"id": "claude-code", "available": True}],
        db_session=db_session,
    )
    try:
        ack_task = asyncio.create_task(_auto_ack(conn, fake_ws))
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "claude-code",
                "cwd": "/tmp/blog",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        sent = await ack_task

        assert r.status_code == 201, r.text
        body = r.json()
        assert body["agent_id"].startswith("ag_")
        assert body["runtime"] == "claude-code"
        assert body["display_name"] == "writer"
        assert body["daemon_instance_id"] == instance_id

        # Control frame payload carries the runtime + credentials envelope.
        assert sent["type"] == "provision_agent"
        assert sent["params"]["runtime"] == "claude-code"
        assert sent["params"]["cwd"] == "/tmp/blog"
        creds = sent["params"]["credentials"]
        assert creds["agentId"] == body["agent_id"]
        assert creds["runtime"] == "claude-code"
        assert creds["cwd"] == "/tmp/blog"
        assert creds["privateKey"]  # base64
        assert creds["publicKey"]
        assert creds["token"]

        # Runtime persisted onto the Hub `agents` row.
        res = await db_session.execute(
            select(Agent).where(Agent.agent_id == body["agent_id"])
        )
        agent = res.scalar_one()
        assert agent.runtime == "claude-code"
        assert agent.user_id == seed_user["user_id"]

        # Signing key activated + hub-issued token stored.
        key_res = await db_session.execute(
            select(SigningKey).where(SigningKey.agent_id == body["agent_id"])
        )
        sk = key_res.scalar_one()
        assert sk.state.value == "active"
        assert agent.agent_token
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_marks_openclaw_profile_bound_in_cached_snapshot(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, fake_ws, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        runtimes_snapshot=[
            {
                "id": "openclaw-acp",
                "available": True,
                "endpoints": [
                    {
                        "name": "local",
                        "url": "ws://127.0.0.1:18789",
                        "reachable": True,
                        "agents": [{"id": "pm"}, {"id": "swe", "name": "SWE"}],
                    }
                ],
            }
        ],
        db_session=db_session,
    )
    try:
        ack_task = asyncio.create_task(_auto_ack(conn, fake_ws))
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "openclaw-acp",
                "openclaw_gateway": "local",
                "openclaw_agent": "swe",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await ack_task
        assert r.status_code == 201, r.text
        agent_id = r.json()["agent_id"]

        await db_session.commit()
        res = await db_session.execute(
            select(DaemonInstance).where(DaemonInstance.id == instance_id)
        )
        inst = res.scalar_one()
        runtimes = inst.runtimes_json
        if isinstance(runtimes, str):
            runtimes = json.loads(runtimes)
        agents = runtimes[0]["endpoints"][0]["agents"]
        assert agents == [
            {"id": "pm"},
            {
                "id": "swe",
                "name": "SWE",
                "botcordBinding": {"agentId": agent_id},
            },
        ]
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_marks_hermes_profile_occupied_in_cached_snapshot(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, fake_ws, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        runtimes_snapshot=[
            {
                "id": "hermes-agent",
                "available": True,
                "profiles": [
                    {"name": "coder", "home": "/tmp/hermes/coder"},
                    {"name": "reviewer", "home": "/tmp/hermes/reviewer"},
                ],
            }
        ],
        db_session=db_session,
    )
    try:
        ack_task = asyncio.create_task(_auto_ack(conn, fake_ws))
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "hermes-agent",
                "hermes_profile": "coder",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await ack_task
        assert r.status_code == 201, r.text
        agent_id = r.json()["agent_id"]

        await db_session.commit()
        res = await db_session.execute(
            select(DaemonInstance).where(DaemonInstance.id == instance_id)
        )
        inst = res.scalar_one()
        runtimes = inst.runtimes_json
        if isinstance(runtimes, str):
            runtimes = json.loads(runtimes)
        assert runtimes[0]["profiles"] == [
            {
                "name": "coder",
                "home": "/tmp/hermes/coder",
                "occupiedBy": agent_id,
                "occupiedByName": "writer",
            },
            {"name": "reviewer", "home": "/tmp/hermes/reviewer"},
        ]
    finally:
        await registry.unregister(conn)


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provision_rejects_when_daemon_offline(
    client: AsyncClient, seed_user
):
    instance_id = await _provision_instance(client, seed_user)
    r = await client.post(
        "/api/users/me/agents/provision",
        json={
            "daemon_instance_id": instance_id,
            "label": "writer",
            "runtime": "claude-code",
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"


@pytest.mark.asyncio
async def test_provision_rejects_runtime_not_in_snapshot(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, _, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        # Snapshot advertises only claude-code; user asks for codex.
        runtimes_snapshot=[{"id": "claude-code", "available": True}],
        db_session=db_session,
    )
    try:
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "codex",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        assert r.status_code == 409
        assert r.json()["detail"] == "runtime_unavailable"
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_rejects_unavailable_openclaw_profile_in_snapshot(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, _, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        runtimes_snapshot=[
            {
                "id": "openclaw-acp",
                "available": True,
                "endpoints": [
                    {
                        "name": "local",
                        "url": "ws://127.0.0.1:18789",
                        "reachable": True,
                        "agents": [
                            {
                                "id": "claude-code",
                                "availability": {
                                    "available": False,
                                    "code": "stale_config",
                                    "message": 'Agent "claude-code" no longer exists in configuration',
                                },
                            }
                        ],
                    }
                ],
            }
        ],
        db_session=db_session,
    )
    try:
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "openclaw-acp",
                "openclaw_gateway": "local",
                "openclaw_agent": "claude-code",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        assert r.status_code == 409
        assert r.json()["detail"] == "runtime_unavailable"
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_permits_runtime_when_snapshot_empty(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    """A daemon that has not yet pushed its first runtime_snapshot should
    still be provisionable — rejecting here would deadlock freshly-connected
    daemons. The daemon still rejects unknown runtimes on its own side."""
    instance_id = await _provision_instance(client, seed_user)
    conn, fake_ws, registry = await _with_connected_daemon(
        instance_id, seed_user["user_id"]
    )
    try:
        ack_task = asyncio.create_task(_auto_ack(conn, fake_ws))
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "claude-code",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await ack_task
        assert r.status_code == 201, r.text
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_rolls_back_when_daemon_returns_error_ack(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    instance_id = await _provision_instance(client, seed_user)
    conn, fake_ws, registry = await _with_connected_daemon(
        instance_id,
        seed_user["user_id"],
        runtimes_snapshot=[{"id": "claude-code", "available": True}],
        db_session=db_session,
    )
    try:
        err_task = asyncio.create_task(
            _auto_ack(
                conn,
                fake_ws,
                ok=False,
                err={"code": "keypair_mismatch", "message": "bad"},
            )
        )
        r = await client.post(
            "/api/users/me/agents/provision",
            json={
                "daemon_instance_id": instance_id,
                "label": "writer",
                "runtime": "claude-code",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await err_task
        assert r.status_code == 502
        detail = r.json()["detail"]
        assert detail["code"] == "daemon_provision_failed"
        assert detail["daemon_code"] == "keypair_mismatch"

        # Hub-side rollback: no Agent or SigningKey row should have survived.
        res = await db_session.execute(select(Agent))
        assert res.scalar_one_or_none() is None
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_provision_rejects_not_owned_instance(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    # Manually insert a daemon_instance owned by a DIFFERENT user.
    other_user_id = uuid.uuid4()
    other_user = User(
        id=other_user_id,
        display_name="Other",
        email="other@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
        max_agents=10,
    )
    db_session.add(other_user)
    await db_session.flush()
    inst = DaemonInstance(
        id="dm_notmine1234",
        user_id=other_user_id,
        label="their machine",
        refresh_token_hash="deadbeef" * 8,
    )
    db_session.add(inst)
    await db_session.commit()

    r = await client.post(
        "/api/users/me/agents/provision",
        json={
            "daemon_instance_id": "dm_notmine1234",
            "label": "sneaky",
            "runtime": "claude-code",
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "daemon_instance_not_found"

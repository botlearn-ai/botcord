"""Tests for the daemon control plane (/daemon/*).

Covers the device-code happy path, refresh token rotation, instance
revocation, and one frame-dispatch path against an in-memory daemon WS.
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
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import MessagePolicy
from hub.models import Agent, Base, DaemonDeviceCode, DaemonInstance, Role, User, UserRole

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-daemon-control"


def _make_supabase_token(sub: str, secret: str = TEST_SUPABASE_SECRET) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, secret, algorithm="HS256")


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
async def session_factory_for_async(db_session):
    """Return a callable that yields the same shared session.

    The daemon control router opens its own ``async_session()`` for the
    WS lifecycle / event handling. Tests force those to reuse the same
    in-memory SQLite session by patching ``async_session`` to always
    yield the test session.
    """
    return db_session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth

    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    # Make ``async_session()`` (used inside the WS handler) reuse the test
    # session, so writes from the WS path are visible to other queries.
    import hub.routers.daemon_control as daemon_control_mod
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _shared_session():
        # Yield the shared in-memory session; do NOT close it (the fixture owns it).
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
        "token": _make_supabase_token(str(supabase_uuid)),
    }


# ---------------------------------------------------------------------------
# Auth flows
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_device_code_happy_path(client: AsyncClient, seed_user, db_session: AsyncSession):
    # 1. Daemon issues a device code.
    r = await client.post("/daemon/auth/device-code")
    assert r.status_code == 200, r.text
    issued = r.json()
    assert issued["device_code"].startswith("dc_")
    assert "-" in issued["user_code"]
    assert issued["expires_in"] > 0

    # 2. Daemon polls — still pending.
    r = await client.post(
        "/daemon/auth/device-token", json={"device_code": issued["device_code"]}
    )
    assert r.status_code == 200
    assert r.json() == {"status": "pending"}

    # 3. Dashboard approves with user JWT.
    r = await client.post(
        "/daemon/auth/device-approve",
        json={"user_code": issued["user_code"], "label": "MacBook"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    approved = r.json()
    assert approved["ok"] is True
    assert approved["daemon_instance_id"].startswith("dm_")

    # 4. Daemon poll now returns the token bundle.
    r = await client.post(
        "/daemon/auth/device-token", json={"device_code": issued["device_code"]}
    )
    assert r.status_code == 200, r.text
    bundle = r.json()
    assert bundle["access_token"]
    assert bundle["refresh_token"].startswith("drt_")
    assert bundle["daemon_instance_id"] == approved["daemon_instance_id"]
    assert bundle["expires_in"] > 0

    # 5. The DaemonInstance row exists and is owned by the user.
    from sqlalchemy import select

    res = await db_session.execute(
        select(DaemonInstance).where(DaemonInstance.id == approved["daemon_instance_id"])
    )
    inst = res.scalar_one()
    assert str(inst.user_id) == str(seed_user["user_id"])
    assert inst.label == "MacBook"

    # 6. Repeated poll on consumed device-code is rejected.
    r = await client.post(
        "/daemon/auth/device-token", json={"device_code": issued["device_code"]}
    )
    assert r.status_code == 400


async def _provision_instance_via_device_code(
    client: AsyncClient, seed_user, *, label: str | None = None
) -> dict:
    """Walk the full device-code flow and return the issued token bundle.

    Used by tests that need a `DaemonInstance` row + token bundle as setup
    state. Mirrors the daemon's runtime behavior so tests exercise the only
    supported bootstrap path.
    """
    r = await client.post("/daemon/auth/device-code")
    assert r.status_code == 200, r.text
    issued = r.json()
    approve_body: dict = {"user_code": issued["user_code"]}
    if label:
        approve_body["label"] = label
    r = await client.post(
        "/daemon/auth/device-approve",
        json=approve_body,
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        "/daemon/auth/device-token", json={"device_code": issued["device_code"]}
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_refresh_rotates_token(client: AsyncClient, seed_user, db_session: AsyncSession):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    old_refresh = bundle["refresh_token"]
    instance_id = bundle["daemon_instance_id"]

    r = await client.post("/daemon/auth/refresh", json={"refresh_token": old_refresh})
    assert r.status_code == 200, r.text
    rotated = r.json()
    assert rotated["refresh_token"] != old_refresh
    assert rotated["daemon_instance_id"] == instance_id

    # Old refresh no longer works.
    r = await client.post("/daemon/auth/refresh", json={"refresh_token": old_refresh})
    assert r.status_code == 401

    # New refresh does.
    r = await client.post(
        "/daemon/auth/refresh", json={"refresh_token": rotated["refresh_token"]}
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_invalid_refresh_token_rejected(client: AsyncClient):
    r = await client.post(
        "/daemon/auth/refresh", json={"refresh_token": "drt_does_not_exist"}
    )
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Revocation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoke_blocks_refresh(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    r = await client.post(
        f"/daemon/instances/{instance_id}/revoke",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    revoked = r.json()
    assert revoked["ok"] is True
    assert revoked["was_online"] is False

    # Refresh now fails.
    r = await client.post(
        "/daemon/auth/refresh", json={"refresh_token": bundle["refresh_token"]}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_instances(client: AsyncClient, seed_user):
    # Issue two instances.
    for _ in range(2):
        await _provision_instance_via_device_code(client, seed_user)
    r = await client.get(
        "/daemon/instances",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["instances"]) == 2
    for entry in data["instances"]:
        assert entry["id"].startswith("dm_")
        assert entry["online"] is False


# ---------------------------------------------------------------------------
# Rename (label update)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rename_instance_updates_label(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(
        client, seed_user, label="old"
    )
    instance_id = bundle["daemon_instance_id"]

    r = await client.patch(
        f"/daemon/instances/{instance_id}",
        json={"label": "  My MacBook  "},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "My MacBook"

    r = await client.get(
        "/daemon/instances",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.json()["instances"][0]["label"] == "My MacBook"


@pytest.mark.asyncio
async def test_rename_instance_clears_label(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(
        client, seed_user, label="old"
    )
    instance_id = bundle["daemon_instance_id"]

    # Empty string normalizes to null.
    r = await client.patch(
        f"/daemon/instances/{instance_id}",
        json={"label": "   "},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["label"] is None

    # Explicit null also clears.
    r = await client.patch(
        f"/daemon/instances/{instance_id}",
        json={"label": None},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200
    assert r.json()["label"] is None


@pytest.mark.asyncio
async def test_rename_instance_rejects_oversized_label(
    client: AsyncClient, seed_user
):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    r = await client.patch(
        f"/daemon/instances/{instance_id}",
        json={"label": "x" * 65},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_rename_instance_owned_by_other_user_returns_404(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    # Create a second, unrelated user and use their token.
    other_supabase_uuid = uuid.uuid4()
    other_user = User(
        id=uuid.uuid4(),
        display_name="Other",
        email="other@example.com",
        status="active",
        supabase_user_id=other_supabase_uuid,
        max_agents=10,
    )
    db_session.add(other_user)
    await db_session.commit()
    other_token = _make_supabase_token(str(other_supabase_uuid))

    r = await client.patch(
        f"/daemon/instances/{instance_id}",
        json={"label": "stolen"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Dispatch (frame send) against a fake daemon connection
# ---------------------------------------------------------------------------


class _FakeWS:
    """Minimal stand-in for a connected daemon WebSocket."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed_with: tuple[int, str] | None = None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


@pytest.mark.asyncio
async def test_dispatch_frame_to_connected_daemon(
    client: AsyncClient, seed_user, monkeypatch
):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    # Wire up a fake connection in the registry.
    from hub.routers.daemon_control import _DaemonConn, _registry_for_tests

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )
    registry = _registry_for_tests()
    await registry.register(conn)
    try:
        # Dispatch a ping. Run dispatch concurrently with the "daemon" reply
        # so we don't deadlock waiting for the ack.
        async def _reply_when_sent() -> None:
            # Spin briefly until the frame has been sent.
            for _ in range(50):
                if fake_ws.sent:
                    break
                await asyncio.sleep(0.01)
            assert fake_ws.sent, "dispatch never wrote to the fake WS"
            sent_frame = json.loads(fake_ws.sent[0])
            assert sent_frame["type"] == "ping"
            assert sent_frame["sig"]
            assert sent_frame["ts"] > 0
            ack = {"id": sent_frame["id"], "ok": True, "result": {"pong": True}}
            fut = conn.pending_acks.get(sent_frame["id"])
            assert fut is not None
            fut.set_result(ack)

        reply_task = asyncio.create_task(_reply_when_sent())
        r = await client.post(
            f"/daemon/instances/{instance_id}/dispatch",
            json={"type": "ping", "params": {}, "timeout_ms": 2000},
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await reply_task
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["ack"]["result"] == {"pong": True}

        # Online flag should now show true.
        r = await client.get(
            "/daemon/instances",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        instances = r.json()["instances"]
        assert any(it["id"] == instance_id and it["online"] for it in instances)
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_dispatch_unsupported_type_rejected(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    r = await client.post(
        f"/daemon/instances/{instance_id}/dispatch",
        json={"type": "rm_minus_rf", "params": {}},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_dispatch_offline_returns_409(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]
    r = await client.post(
        f"/daemon/instances/{instance_id}/dispatch",
        json={"type": "ping", "params": {}},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Runtime discovery (§8.5)
# ---------------------------------------------------------------------------


def _probed_now_ms() -> int:
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)


@pytest.mark.asyncio
async def test_runtime_snapshot_event_persists_to_db(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    """A daemon-pushed runtime_snapshot lands in runtimes_json / runtimes_probed_at
    and surfaces through list_instances."""
    from sqlalchemy import select

    from hub.routers.daemon_control import _DaemonConn, _handle_daemon_event

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )

    probed_at = _probed_now_ms()
    runtimes = [
        {
            "id": "claude-code",
            "available": True,
            "version": "2.1.118",
            "path": "/usr/local/bin/claude",
        },
        {"id": "codex", "available": False, "error": "not found"},
    ]
    await _handle_daemon_event(
        conn,
        {
            "id": "frm_rs_1",
            "type": "runtime_snapshot",
            "params": {"runtimes": runtimes, "probedAt": probed_at},
        },
    )

    # Ack is ok.
    assert fake_ws.sent, "handler did not send an ack"
    ack = json.loads(fake_ws.sent[-1])
    assert ack == {"id": "frm_rs_1", "ok": True}

    # Row is updated.
    await db_session.commit()
    res = await db_session.execute(
        select(DaemonInstance).where(DaemonInstance.id == instance_id)
    )
    inst = res.scalar_one()
    # SQLAlchemy may return list or parsed JSON — normalize.
    stored = inst.runtimes_json
    if isinstance(stored, str):
        stored = json.loads(stored)
    assert stored == runtimes
    assert inst.runtimes_probed_at is not None

    # list_instances surfaces it.
    r = await client.get(
        "/daemon/instances",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    entry = next(it for it in payload["instances"] if it["id"] == instance_id)
    assert entry["runtimes"] == runtimes
    assert entry["runtimes_probed_at"] is not None


@pytest.mark.asyncio
async def test_runtime_snapshot_bad_params_rejected(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    """Malformed runtime_snapshot params produce bad_params and do not touch DB."""
    from sqlalchemy import select

    from hub.routers.daemon_control import _DaemonConn, _handle_daemon_event

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )

    await _handle_daemon_event(
        conn,
        {
            "id": "frm_rs_bad",
            "type": "runtime_snapshot",
            # Missing probedAt.
            "params": {"runtimes": []},
        },
    )
    assert fake_ws.sent
    ack = json.loads(fake_ws.sent[-1])
    assert ack["id"] == "frm_rs_bad"
    assert ack["ok"] is False
    assert ack["error"]["code"] == "bad_params"

    # Far-future probedAt also rejected.
    fake_ws.sent.clear()
    future_ms = _probed_now_ms() + 10 * 60 * 1000  # +10min — beyond 5min skew
    await _handle_daemon_event(
        conn,
        {
            "id": "frm_rs_future",
            "type": "runtime_snapshot",
            "params": {"runtimes": [], "probedAt": future_ms},
        },
    )
    ack = json.loads(fake_ws.sent[-1])
    assert ack["ok"] is False
    assert ack["error"]["code"] == "bad_params"

    # DB row runtimes_json remains null.
    await db_session.commit()
    res = await db_session.execute(
        select(DaemonInstance).where(DaemonInstance.id == instance_id)
    )
    inst = res.scalar_one()
    assert inst.runtimes_json is None
    assert inst.runtimes_probed_at is None


@pytest.mark.asyncio
async def test_runtime_snapshot_oversized_array_rejected(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    """A runtimes array over 64 entries is refused as bad_params."""
    from sqlalchemy import select

    from hub.routers.daemon_control import _DaemonConn, _handle_daemon_event

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )

    oversized = [{"id": f"rt_{i}", "available": False} for i in range(65)]
    await _handle_daemon_event(
        conn,
        {
            "id": "frm_rs_oversized",
            "type": "runtime_snapshot",
            "params": {"runtimes": oversized, "probedAt": _probed_now_ms()},
        },
    )
    ack = json.loads(fake_ws.sent[-1])
    assert ack["ok"] is False
    assert ack["error"]["code"] == "bad_params"

    await db_session.commit()
    res = await db_session.execute(
        select(DaemonInstance).where(DaemonInstance.id == instance_id)
    )
    inst = res.scalar_one()
    assert inst.runtimes_json is None


@pytest.mark.asyncio
async def test_list_instances_without_runtimes_returns_none(
    client: AsyncClient, seed_user
):
    """Newly-provisioned instance has runtimes=None in list_instances."""
    await _provision_instance_via_device_code(client, seed_user)
    r = await client.get(
        "/daemon/instances",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 200, r.text
    for entry in r.json()["instances"]:
        assert entry["runtimes"] is None
        assert entry["runtimes_probed_at"] is None


@pytest.mark.asyncio
async def test_refresh_runtimes_offline_returns_409(client: AsyncClient, seed_user):
    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]
    r = await client.post(
        f"/daemon/instances/{instance_id}/refresh-runtimes",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"


@pytest.mark.asyncio
async def test_refresh_runtimes_success_persists_and_returns(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    from sqlalchemy import select

    from hub.routers.daemon_control import _DaemonConn, _registry_for_tests

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )
    registry = _registry_for_tests()
    await registry.register(conn)
    try:
        probed_at = _probed_now_ms()
        runtimes = [
            {"id": "claude-code", "available": True, "version": "2.1.119"},
        ]

        async def _reply_when_sent() -> None:
            for _ in range(100):
                if fake_ws.sent:
                    break
                await asyncio.sleep(0.01)
            assert fake_ws.sent
            sent = json.loads(fake_ws.sent[0])
            assert sent["type"] == "list_runtimes"
            assert sent["sig"]
            ack = {
                "id": sent["id"],
                "ok": True,
                "result": {"runtimes": runtimes, "probedAt": probed_at},
            }
            fut = conn.pending_acks.get(sent["id"])
            assert fut is not None
            fut.set_result(ack)

        reply_task = asyncio.create_task(_reply_when_sent())
        r = await client.post(
            f"/daemon/instances/{instance_id}/refresh-runtimes",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await reply_task
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["runtimes"] == runtimes
        assert body["runtimes_probed_at"]

        # DB is updated.
        await db_session.commit()
        res = await db_session.execute(
            select(DaemonInstance).where(DaemonInstance.id == instance_id)
        )
        inst = res.scalar_one()
        stored = inst.runtimes_json
        if isinstance(stored, str):
            stored = json.loads(stored)
        assert stored == runtimes
        assert inst.runtimes_probed_at is not None
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_refresh_runtimes_daemon_ack_error_returns_502(
    client: AsyncClient, seed_user
):
    from hub.routers.daemon_control import _DaemonConn, _registry_for_tests

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )
    registry = _registry_for_tests()
    await registry.register(conn)
    try:
        async def _reply_error() -> None:
            for _ in range(100):
                if fake_ws.sent:
                    break
                await asyncio.sleep(0.01)
            assert fake_ws.sent
            sent = json.loads(fake_ws.sent[0])
            ack = {
                "id": sent["id"],
                "ok": False,
                "error": {"code": "probe_failed", "message": "which: broken"},
            }
            fut = conn.pending_acks.get(sent["id"])
            assert fut is not None
            fut.set_result(ack)

        reply_task = asyncio.create_task(_reply_error())
        r = await client.post(
            f"/daemon/instances/{instance_id}/refresh-runtimes",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await reply_task
        assert r.status_code == 502, r.text
        detail = r.json()["detail"]
        # detail is a dict with upstream codes when daemon returned error.
        assert detail["code"] == "upstream_error"
        assert detail["daemon_code"] == "probe_failed"
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_refresh_runtimes_daemon_disconnect_returns_502(
    client: AsyncClient, seed_user
):
    """If the daemon drops mid-request, the pending future raises and we
    must surface it as 502 rather than letting a 500 escape."""
    from hub.routers.daemon_control import _DaemonConn, _registry_for_tests

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    fake_ws = _FakeWS()
    conn = _DaemonConn(
        ws=fake_ws,  # type: ignore[arg-type]
        user_id=str(seed_user["user_id"]),
        daemon_instance_id=instance_id,
        pending_acks={},
    )
    registry = _registry_for_tests()
    await registry.register(conn)
    try:
        async def _drop_mid_request() -> None:
            for _ in range(100):
                if fake_ws.sent:
                    break
                await asyncio.sleep(0.01)
            assert fake_ws.sent
            sent = json.loads(fake_ws.sent[0])
            fut = conn.pending_acks.get(sent["id"])
            assert fut is not None
            # Mirror what daemon_control_ws's finally block does on disconnect.
            fut.set_exception(RuntimeError("daemon disconnected"))

        drop_task = asyncio.create_task(_drop_mid_request())
        r = await client.post(
            f"/daemon/instances/{instance_id}/refresh-runtimes",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        await drop_task
        assert r.status_code == 502, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "daemon_disconnected"
    finally:
        await registry.unregister(conn)


@pytest.mark.asyncio
async def test_load_agent_identity_snapshot_returns_active_bound_agents(
    client: AsyncClient, seed_user, db_session: AsyncSession
):
    """The hello frame's agents snapshot must list every active agent bound
    to the daemon — that's what lets the daemon reconcile identity.md on
    reconnect after the dashboard mutated it offline."""
    from hub.routers.daemon_control import _load_agent_identity_snapshot

    bundle = await _provision_instance_via_device_code(client, seed_user)
    instance_id = bundle["daemon_instance_id"]

    # Two active agents bound to this daemon, one bound but soft-deleted, one
    # active but bound to a different daemon — only the first two should appear.
    db_session.add_all(
        [
            Agent(
                agent_id="ag_keep1",
                display_name="Keep One",
                bio="Bio one",
                runtime="claude-code",
                user_id=seed_user["user_id"],
                daemon_instance_id=instance_id,
                message_policy=MessagePolicy.contacts_only,
                status="active",
            ),
            Agent(
                agent_id="ag_keep2",
                display_name="Keep Two",
                bio=None,
                runtime="codex",
                user_id=seed_user["user_id"],
                daemon_instance_id=instance_id,
                message_policy=MessagePolicy.contacts_only,
                status="active",
            ),
            Agent(
                agent_id="ag_deleted",
                display_name="Gone",
                user_id=seed_user["user_id"],
                daemon_instance_id=instance_id,
                message_policy=MessagePolicy.contacts_only,
                status="deleted",
            ),
            Agent(
                agent_id="ag_other_daemon",
                display_name="Elsewhere",
                user_id=seed_user["user_id"],
                daemon_instance_id="di_other",
                message_policy=MessagePolicy.contacts_only,
                status="active",
            ),
        ]
    )
    await db_session.commit()

    snapshot = await _load_agent_identity_snapshot(instance_id)
    by_id = {entry["agentId"]: entry for entry in snapshot}
    assert set(by_id) == {"ag_keep1", "ag_keep2"}
    assert by_id["ag_keep1"]["displayName"] == "Keep One"
    assert by_id["ag_keep1"]["bio"] == "Bio one"
    assert by_id["ag_keep2"]["bio"] is None
    # runtime is intentionally not on the wire — it's cached locally on the daemon.
    assert "runtime" not in by_id["ag_keep1"]

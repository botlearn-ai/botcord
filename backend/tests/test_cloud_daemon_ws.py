"""Tests for /cloud/daemon/ws — see docs/cloud-agent-technical-design.md §4."""

from __future__ import annotations

import asyncio
import datetime
import json
import uuid
from contextlib import asynccontextmanager

import jwt as pyjwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.config import JWT_ALGORITHM, JWT_SECRET
from hub.id_generators import (
    generate_cloud_agent_instance_id,
    generate_cloud_daemon_instance_id,
    generate_daemon_instance_id,
)
from hub.models import (
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
)
from hub.routers.cloud_daemon_control import (
    CLOUD_DAEMON_TOKEN_ISSUER,
    CLOUD_DAEMON_TOKEN_KIND,
    _CloudDaemonConn,
    _create_cloud_daemon_access_token,
    _handle_cloud_daemon_event,
    _registry_for_tests,
    _verify_cloud_daemon_access_token,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def shared_session_for_ws(db_session: AsyncSession, monkeypatch):
    """Make ``async_session()`` inside the WS handler reuse the test session."""
    import hub.routers.cloud_daemon_control as cdc

    @asynccontextmanager
    async def _shared():
        yield db_session

    monkeypatch.setattr(cdc, "async_session", _shared)
    return db_session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, shared_session_for_ws):
    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


class _FakeWS:
    """Minimal stand-in for a connected cloud daemon WebSocket."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed_with: tuple[int, str] | None = None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


# ---------------------------------------------------------------------------
# Seed helper
# ---------------------------------------------------------------------------


async def _seed_cloud_daemon(
    db: AsyncSession,
    *,
    daemon_kind: str = "cloud",
    cloud_status: str = "ready",
    daemon_revoked: bool = False,
) -> tuple[DaemonInstance, CloudDaemonInstance]:
    user_id = uuid.uuid4()
    daemon = DaemonInstance(
        id=generate_daemon_instance_id(),
        user_id=user_id,
        kind=daemon_kind,
        refresh_token_hash="z" * 64,
        revoked_at=(datetime.datetime.now(datetime.timezone.utc) if daemon_revoked else None),
    )
    db.add(daemon)
    await db.flush()
    cloud = CloudDaemonInstance(
        id=generate_cloud_daemon_instance_id(),
        user_id=user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        runtime="deepseek-tui",
        status=cloud_status,
        max_agents=3,
    )
    db.add(cloud)
    await db.commit()
    return daemon, cloud


# ---------------------------------------------------------------------------
# Token tests
# ---------------------------------------------------------------------------


def test_create_and_verify_cloud_daemon_token():
    token, expires_in = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id="cloud_dm_test1234",
        daemon_instance_id="dm_test5678",
        user_id=str(uuid.uuid4()),
    )
    assert expires_in > 0
    claims = _verify_cloud_daemon_access_token(token)
    assert claims["kind"] == CLOUD_DAEMON_TOKEN_KIND
    assert claims["iss"] == CLOUD_DAEMON_TOKEN_ISSUER
    assert claims["cloud_daemon_instance_id"] == "cloud_dm_test1234"
    assert claims["daemon_instance_id"] == "dm_test5678"


def test_verify_rejects_local_daemon_token_kind():
    """A local ``daemon-access`` JWT must NOT be accepted on the cloud plane."""
    payload = {
        "kind": "daemon-access",
        "sub": "dm_xxx",
        "user_id": str(uuid.uuid4()),
        "daemon_instance_id": "dm_xxx",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "botcord-daemon",
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    from hub.routers.cloud_daemon_control import _TokenError

    with pytest.raises(_TokenError):
        _verify_cloud_daemon_access_token(token)


def test_verify_rejects_missing_cloud_id():
    payload = {
        "kind": CLOUD_DAEMON_TOKEN_KIND,
        "iss": CLOUD_DAEMON_TOKEN_ISSUER,
        "user_id": str(uuid.uuid4()),
        "daemon_instance_id": "dm_xxx",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    from hub.routers.cloud_daemon_control import _TokenError

    with pytest.raises(_TokenError):
        _verify_cloud_daemon_access_token(token)


def test_verify_rejects_missing_user_id():
    payload = {
        "kind": CLOUD_DAEMON_TOKEN_KIND,
        "iss": CLOUD_DAEMON_TOKEN_ISSUER,
        "cloud_daemon_instance_id": "cloud_dm_xxx",
        "daemon_instance_id": "dm_xxx",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    from hub.routers.cloud_daemon_control import _TokenError

    with pytest.raises(_TokenError):
        _verify_cloud_daemon_access_token(token)


# ---------------------------------------------------------------------------
# Registry tests (independent from local /daemon/ws registry)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_registry_indexed_by_both_ids():
    registry = _registry_for_tests()
    conn = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id=str(uuid.uuid4()),
        cloud_daemon_instance_id="cloud_dm_aaaa",
        daemon_instance_id="dm_bbbb",
    )
    await registry.register(conn)
    try:
        assert registry.get_by_cloud("cloud_dm_aaaa") is conn
        assert registry.get_by_daemon("dm_bbbb") is conn
        assert registry.is_online("cloud_dm_aaaa")
    finally:
        await registry.unregister(conn)
    assert registry.get_by_cloud("cloud_dm_aaaa") is None
    assert registry.get_by_daemon("dm_bbbb") is None


@pytest.mark.asyncio
async def test_registry_displaces_previous_connection():
    registry = _registry_for_tests()
    first = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id="u1",
        cloud_daemon_instance_id="cloud_dm_dup",
        daemon_instance_id="dm_dup",
    )
    second = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id="u1",
        cloud_daemon_instance_id="cloud_dm_dup",
        daemon_instance_id="dm_dup",
    )
    assert await registry.register(first) is None
    try:
        previous = await registry.register(second)
        assert previous is first
        assert registry.get_by_cloud("cloud_dm_dup") is second
    finally:
        await registry.unregister(second)


@pytest.mark.asyncio
async def test_cloud_registry_does_not_collide_with_local_daemon_registry():
    """Local /daemon/ws and cloud /cloud/daemon/ws keep separate state."""
    from hub.routers.daemon_control import _registry_for_tests as local_registry_for_tests

    local_registry = local_registry_for_tests()
    cloud_registry = _registry_for_tests()

    daemon_id = "dm_shared_check"
    cloud_conn = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id="u",
        cloud_daemon_instance_id="cloud_dm_x",
        daemon_instance_id=daemon_id,
    )
    await cloud_registry.register(cloud_conn)
    try:
        assert cloud_registry.is_online("cloud_dm_x")
        # Local registry is keyed by daemon_instance_id and must NOT see
        # the cloud daemon, even though the underlying daemon row id is
        # the same shape.
        assert local_registry.is_online(daemon_id) is False
    finally:
        await cloud_registry.unregister(cloud_conn)


@pytest.mark.asyncio
async def test_instance_view_reflects_cloud_daemon_connection():
    """``/daemon/instances`` must report ``online=True`` for a cloud daemon
    that has an active ``/cloud/daemon/ws`` connection.

    Regression: ``_instance_to_view`` previously consulted only the local
    registry, so cloud daemons were stuck displaying offline in the
    dashboard even while their WS was live (and messages still flowed).
    """
    from hub.routers.cloud_daemon_control import is_cloud_daemon_online_by_daemon_id
    from hub.routers.daemon_control import _instance_online

    cloud_registry = _registry_for_tests()

    cloud_daemon_id = "cloud_dm_view"
    daemon_id = "dm_view_check"
    fake_instance = DaemonInstance(
        id=daemon_id,
        user_id=uuid.uuid4(),
        kind="cloud",
        refresh_token_hash="z" * 64,
    )

    # No connection yet — must be offline.
    assert is_cloud_daemon_online_by_daemon_id(daemon_id) is False
    assert _instance_online(fake_instance) is False

    conn = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id="u",
        cloud_daemon_instance_id=cloud_daemon_id,
        daemon_instance_id=daemon_id,
    )
    await cloud_registry.register(conn)
    try:
        assert is_cloud_daemon_online_by_daemon_id(daemon_id) is True
        assert _instance_online(fake_instance) is True
    finally:
        await cloud_registry.unregister(conn)

    # And back to offline after disconnect.
    assert is_cloud_daemon_online_by_daemon_id(daemon_id) is False
    assert _instance_online(fake_instance) is False


# ---------------------------------------------------------------------------
# runtime_snapshot persistence — exercises the cloud event handler directly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_runtime_snapshot_persists_to_daemon_instance(
    db_session: AsyncSession, shared_session_for_ws
):
    daemon, cloud = await _seed_cloud_daemon(db_session)
    fake_ws = _FakeWS()
    conn = _CloudDaemonConn(
        ws=fake_ws,
        user_id=str(daemon.user_id),
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
    )
    probed_at_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    await _handle_cloud_daemon_event(
        conn,
        {
            "id": "frame-1",
            "type": "runtime_snapshot",
            "params": {
                "runtimes": [{"id": "deepseek-tui", "available": True}],
                "probedAt": probed_at_ms,
            },
        },
    )
    # Ack was sent.
    assert fake_ws.sent
    ack = json.loads(fake_ws.sent[-1])
    assert ack == {"id": "frame-1", "ok": True}

    # Snapshot persisted onto the underlying daemon_instances row.
    refreshed = await db_session.scalar(
        select(DaemonInstance).where(DaemonInstance.id == daemon.id)
    )
    assert refreshed is not None
    assert refreshed.runtimes_json == [{"id": "deepseek-tui", "available": True}]
    assert refreshed.runtimes_probed_at is not None


@pytest.mark.asyncio
async def test_runtime_snapshot_with_bad_params_rejected(
    db_session: AsyncSession, shared_session_for_ws
):
    daemon, cloud = await _seed_cloud_daemon(db_session)
    fake_ws = _FakeWS()
    conn = _CloudDaemonConn(
        ws=fake_ws,
        user_id=str(daemon.user_id),
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
    )
    await _handle_cloud_daemon_event(
        conn,
        {"id": "frame-bad", "type": "runtime_snapshot", "params": {"runtimes": "nope"}},
    )
    assert fake_ws.sent
    err = json.loads(fake_ws.sent[-1])
    assert err["ok"] is False
    assert err["error"]["code"] == "bad_params"

    refreshed = await db_session.scalar(
        select(DaemonInstance).where(DaemonInstance.id == daemon.id)
    )
    assert refreshed is not None
    assert refreshed.runtimes_json is None


@pytest.mark.asyncio
async def test_unknown_event_type_rejected(
    db_session: AsyncSession, shared_session_for_ws
):
    daemon, cloud = await _seed_cloud_daemon(db_session)
    fake_ws = _FakeWS()
    conn = _CloudDaemonConn(
        ws=fake_ws,
        user_id=str(daemon.user_id),
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
    )
    await _handle_cloud_daemon_event(conn, {"id": "frame-x", "type": "rm_minus_rf"})
    assert fake_ws.sent
    err = json.loads(fake_ws.sent[-1])
    assert err["ok"] is False
    assert err["error"]["code"] == "unknown_type"


# ---------------------------------------------------------------------------
# WS upgrade tests — exercise the full handler via Starlette TestClient
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def app_with_shared_session(db_session, shared_session_for_ws):
    """Configure the FastAPI app so TestClient skips its Postgres setup.

    Lifespan (see :func:`hub.main.lifespan`) checks whether ``get_db`` is
    overridden and only seeds Postgres when it is NOT. Registering the
    override here lets TestClient(app) start against in-memory SQLite.
    """
    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield app
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_ws_rejects_missing_bearer(app_with_shared_session):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect as _WSD

    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(_WSD) as excinfo:
            with tc.websocket_connect("/cloud/daemon/ws"):
                pass
        assert excinfo.value.code == 4401


@pytest.mark.asyncio
async def test_ws_accepts_valid_token_and_sends_hello(
    db_session, app_with_shared_session
):
    daemon, cloud = await _seed_cloud_daemon(db_session)
    token, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
        user_id=str(daemon.user_id),
    )

    from starlette.testclient import TestClient

    with TestClient(app_with_shared_session) as tc:
        with tc.websocket_connect(
            "/cloud/daemon/ws",
            headers={"Authorization": f"Bearer {token}"},
        ) as ws:
            frame = ws.receive_json()
            assert frame["type"] == "hello"
            assert frame["params"]["cloud_daemon_instance_id"] == cloud.id
            assert "sig" in frame
            assert _registry_for_tests().is_online(cloud.id)

    assert _registry_for_tests().is_online(cloud.id) is False


@pytest.mark.asyncio
async def test_ws_rejects_when_daemon_is_local_kind(
    db_session, app_with_shared_session
):
    """A token whose daemon row has kind='local' must NOT be accepted."""
    daemon, cloud = await _seed_cloud_daemon(db_session, daemon_kind="local")
    token, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
        user_id=str(daemon.user_id),
    )

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect as _WSD

    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(_WSD) as excinfo:
            with tc.websocket_connect(
                "/cloud/daemon/ws",
                headers={"Authorization": f"Bearer {token}"},
            ):
                pass
        assert excinfo.value.code == 4401


@pytest.mark.asyncio
async def test_ws_rejects_when_token_user_mismatches_rows(
    db_session, app_with_shared_session
):
    daemon, cloud = await _seed_cloud_daemon(db_session)
    token, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
        user_id=str(uuid.uuid4()),
    )

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect as _WSD

    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(_WSD) as excinfo:
            with tc.websocket_connect(
                "/cloud/daemon/ws",
                headers={"Authorization": f"Bearer {token}"},
            ):
                pass
        assert excinfo.value.code == 4401


@pytest.mark.asyncio
async def test_ws_rejects_when_cloud_daemon_deleted(
    db_session, app_with_shared_session
):
    daemon, cloud = await _seed_cloud_daemon(db_session, cloud_status="deleted")
    token, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
        user_id=str(daemon.user_id),
    )

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect as _WSD

    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(_WSD) as excinfo:
            with tc.websocket_connect(
                "/cloud/daemon/ws",
                headers={"Authorization": f"Bearer {token}"},
            ):
                pass
        assert excinfo.value.code == 4403

"""Tests for GET /api/integrations/botlearn/ws — botcord-agent-session/0.1.

Verifies the app-facing Cloud Run public subset: hello/auth, scope + method
allowlists, origin gate, revocation, and that cloud_run.create flows through
CloudAgentService (so it cannot bypass quota/reservation/settlement).
"""

from __future__ import annotations

import datetime
import uuid
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.botlearn_auth import (
    BOTLEARN_SCOPE_RUNS_CANCEL,
    BOTLEARN_SCOPE_RUNS_CREATE,
    BOTLEARN_SCOPE_RUNS_READ,
    botcord_supabase_id_for_botlearn,
    issue_botlearn_session_token,
)
from hub.models import (
    Base,
    BotlearnInstallation,
    CloudAgentInstance,
    Role,
    User,
)
from hub.services.cloud_agent import CloudAgentService, CreateCloudAgentInput
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine

ALLOWED_ORIGIN = "https://app.botlearn.ai"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _configure_botlearn(monkeypatch, *, enabled: bool = True) -> None:
    import app.botlearn_auth as ba
    import app.routers.botlearn as br

    monkeypatch.setattr(ba, "BOTLEARN_INTEGRATION_ENABLED", enabled)
    monkeypatch.setattr(br, "BOTLEARN_INTEGRATION_ENABLED", enabled)
    monkeypatch.setattr(ba, "BOTLEARN_ALLOWED_ORIGINS", [ALLOWED_ORIGIN])


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        session.add(
            Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True)
        )
        await session.commit()
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def shared_session_for_ws(db_session: AsyncSession, monkeypatch):
    """Make ``async_session()`` inside the WS handler reuse the test session."""
    import app.routers.botlearn as br

    @asynccontextmanager
    async def _shared():
        yield db_session

    monkeypatch.setattr(br, "async_session", _shared)
    return db_session


@pytest_asyncio.fixture
async def service(db_session: AsyncSession):
    import app.routers.cloud_agents as cloud_agents_router

    original = cloud_agents_router.get_cloud_agent_service()
    svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=3,
        max_agents_per_daemon=2,
    )
    cloud_agents_router._set_default_service_for_tests(svc)
    yield svc
    cloud_agents_router._set_default_service_for_tests(original)


@pytest_asyncio.fixture
async def app_with_shared_session(db_session, shared_session_for_ws):
    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield app
    finally:
        app.dependency_overrides.clear()


async def _seed_cloud_agent(db: AsyncSession, service: CloudAgentService) -> dict:
    """Create a user + a ready Cloud Agent, return identifiers for the WS."""
    supabase_id = botcord_supabase_id_for_botlearn("ws-user")
    user = User(
        id=uuid.uuid4(),
        display_name="WS User",
        email="ws@botlearn.ai",
        status="active",
        supabase_user_id=supabase_id,
        max_agents=30,
    )
    db.add(user)
    await db.commit()
    view = await service.create_cloud_agent(
        db, user_id=user.id, body=CreateCloudAgentInput(name="WS Agent")
    )
    await db.commit()
    inst = BotlearnInstallation(
        id="bli_ws000001",
        user_id=user.id,
        botlearn_subject="ws-user",
        botlearn_email="ws@botlearn.ai",
        agent_id=view.agent_id,
        scopes_json=[
            BOTLEARN_SCOPE_RUNS_CREATE,
            BOTLEARN_SCOPE_RUNS_READ,
            BOTLEARN_SCOPE_RUNS_CANCEL,
        ],
    )
    db.add(inst)
    await db.commit()
    return {"user_id": user.id, "agent_id": view.agent_id, "installation": inst}


def _session_token(user_id, agent_id, installation_id, scopes):
    token, _ = issue_botlearn_session_token(
        user_id=user_id,
        botlearn_subject="ws-user",
        agent_id=agent_id,
        installation_id=installation_id,
        scopes=scopes,
    )
    return token


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_rejects_disallowed_origin(app_with_shared_session, monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    _configure_botlearn(monkeypatch)
    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(
                "/api/integrations/botlearn/ws",
                headers={"origin": "https://evil.example"},
            ):
                pass
        assert exc.value.code == 4003


@pytest.mark.asyncio
async def test_ws_hello_and_cloud_run_create_uses_service(
    app_with_shared_session, db_session, service, monkeypatch
):
    from starlette.testclient import TestClient

    _configure_botlearn(monkeypatch)
    seeded = await _seed_cloud_agent(db_session, service)
    token = _session_token(
        seeded["user_id"],
        seeded["agent_id"],
        seeded["installation"].id,
        [BOTLEARN_SCOPE_RUNS_CREATE, BOTLEARN_SCOPE_RUNS_READ],
    )

    with TestClient(app_with_shared_session) as tc:
        with tc.websocket_connect(
            "/api/integrations/botlearn/ws",
            headers={"origin": ALLOWED_ORIGIN},
        ) as ws:
            ws.send_json({"type": "hello", "token": token})
            hello_ok = ws.receive_json()
            assert hello_ok["type"] == "hello_ok"
            assert hello_ok["protocol"] == "botcord-agent-session/0.1"
            assert hello_ok["agent_id"] == seeded["agent_id"]

            ws.send_json(
                {
                    "type": "req",
                    "id": "r1",
                    "method": "cloud_run.create",
                    "params": {"prompt": "Summarize the workspace"},
                }
            )
            res = ws.receive_json()
            assert res["type"] == "res"
            assert res["ok"] is True, res
            run_id = res["result"]["run_id"]
            assert run_id.startswith("crun_")
            assert res["result"]["status"] == "queued"

            event = ws.receive_json()
            assert event["type"] == "event"
            assert event["event"] == "run.started"
            assert event["run_id"] == run_id

    # The run went through CloudAgentService: a reservation row exists.
    from hub.models import UsageReservation

    reservation = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run_id)
    )
    assert reservation is not None
    assert reservation.agent_id == seeded["agent_id"]


@pytest.mark.asyncio
async def test_ws_rejects_method_outside_scope(
    app_with_shared_session, db_session, service, monkeypatch
):
    from starlette.testclient import TestClient

    _configure_botlearn(monkeypatch)
    seeded = await _seed_cloud_agent(db_session, service)
    # Read-only scope: cloud_run.create requires cloud_runs:create.
    token = _session_token(
        seeded["user_id"],
        seeded["agent_id"],
        seeded["installation"].id,
        [BOTLEARN_SCOPE_RUNS_READ],
    )

    with TestClient(app_with_shared_session) as tc:
        with tc.websocket_connect(
            "/api/integrations/botlearn/ws",
            headers={"origin": ALLOWED_ORIGIN},
        ) as ws:
            ws.send_json({"type": "hello", "token": token})
            assert ws.receive_json()["type"] == "hello_ok"

            ws.send_json(
                {"type": "req", "id": "r1", "method": "cloud_run.create", "params": {"prompt": "x"}}
            )
            res = ws.receive_json()
            assert res["ok"] is False
            assert res["error"]["code"] == "insufficient_scope"


@pytest.mark.asyncio
async def test_ws_rejects_disallowed_method(
    app_with_shared_session, db_session, service, monkeypatch
):
    from starlette.testclient import TestClient

    _configure_botlearn(monkeypatch)
    seeded = await _seed_cloud_agent(db_session, service)
    token = _session_token(
        seeded["user_id"],
        seeded["agent_id"],
        seeded["installation"].id,
        [BOTLEARN_SCOPE_RUNS_CREATE, BOTLEARN_SCOPE_RUNS_READ],
    )

    with TestClient(app_with_shared_session) as tc:
        with tc.websocket_connect(
            "/api/integrations/botlearn/ws",
            headers={"origin": ALLOWED_ORIGIN},
        ) as ws:
            ws.send_json({"type": "hello", "token": token})
            assert ws.receive_json()["type"] == "hello_ok"

            # An internal control-plane frame must never be reachable here.
            ws.send_json(
                {"type": "req", "id": "r1", "method": "provision_agent", "params": {}}
            )
            res = ws.receive_json()
            assert res["ok"] is False
            assert res["error"]["code"] == "method_not_allowed"


@pytest.mark.asyncio
async def test_ws_rejects_revoked_installation(
    app_with_shared_session, db_session, service, monkeypatch
):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    _configure_botlearn(monkeypatch)
    seeded = await _seed_cloud_agent(db_session, service)
    token = _session_token(
        seeded["user_id"],
        seeded["agent_id"],
        seeded["installation"].id,
        [BOTLEARN_SCOPE_RUNS_READ],
    )
    # Revoke before connecting.
    seeded["installation"].revoked_at = _now()
    await db_session.commit()

    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(
                "/api/integrations/botlearn/ws",
                headers={"origin": ALLOWED_ORIGIN},
            ) as ws:
                ws.send_json({"type": "hello", "token": token})
                ws.receive_json()
        assert exc.value.code == 4001


@pytest.mark.asyncio
async def test_ws_rejects_bad_token(app_with_shared_session, monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    _configure_botlearn(monkeypatch)
    with TestClient(app_with_shared_session) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(
                "/api/integrations/botlearn/ws",
                headers={"origin": ALLOWED_ORIGIN},
            ) as ws:
                ws.send_json({"type": "hello", "token": "not-a-real-token"})
                ws.receive_json()
        assert exc.value.code == 4001

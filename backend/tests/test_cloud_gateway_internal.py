"""Tests for the cloud-gateway thin lifecycle API.

Covers the three endpoints introduced by
``docs/cloud-gateway-ingress-technical-design.md`` §7:

- ``POST /internal/cloud-gateway/agents/{agent_id}/ensure-running``
- ``GET  /internal/cloud-gateway/agents/{agent_id}/runtime``
- ``POST /internal/cloud-gateway/agents/{agent_id}/touch``

Tests use the standard in-memory SQLite test rig from
``test_cloud_daemon_ws.py``: seed an ``Agent`` + ``CloudAgentInstance``
+ ``CloudDaemonInstance`` row trio, register a fake connection so the
agent looks "online", then drive the FastAPI routes through an
``ASGITransport`` client with a stubbed ``CloudAgentService.resume_cloud_agent``.
"""

from __future__ import annotations

import datetime
import uuid
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub import config as hub_config
from hub.id_generators import (
    generate_agent_id,
    generate_cloud_agent_instance_id,
    generate_cloud_daemon_instance_id,
    generate_daemon_instance_id,
)
from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
)
from hub.routers.cloud_daemon_control import (
    _CloudDaemonConn,
    _registry_for_tests,
)
from hub.routers.cloud_gateway_internal import (
    get_cloud_agent_service,
    verify_runtime_session_token,
)
from hub.services.cloud_agent import CloudAgentError, CloudAgentView


TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
INGRESS_SECRET = "test-ingress-secret"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
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
async def shared_session_for_resume(db_session: AsyncSession, monkeypatch):
    """Force the service-layer ``async_session`` to reuse the test session."""
    import hub.services.cloud_agent as ca

    @asynccontextmanager
    async def _shared():
        yield db_session

    # CloudAgentService methods accept ``db`` arg directly; nothing to patch
    # for ensure-running. The fixture exists so future tests that exercise
    # the WS handler (which uses ``async_session()``) can share the session.
    return db_session


@pytest_asyncio.fixture(autouse=True)
async def _enable_private_endpoints(monkeypatch):
    monkeypatch.setattr(hub_config, "ALLOW_PRIVATE_ENDPOINTS", True)
    monkeypatch.setattr(hub_config, "CLOUD_GATEWAY_INGRESS_SECRET", INGRESS_SECRET)
    monkeypatch.setattr(hub_config, "INTERNAL_API_SECRET", None)
    yield


class _StubCloudAgentService:
    """Stub for :class:`CloudAgentService` that records resume calls.

    The thin API only depends on ``resume_cloud_agent`` returning a
    :class:`CloudAgentView`. Replacing the dependency keeps the test free
    of E2B provider plumbing.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[uuid.UUID, str]] = []
        self.next_view: CloudAgentView | None = None
        self.next_error: CloudAgentError | None = None

    async def resume_cloud_agent(
        self,
        db,  # noqa: ARG002 — same shape as real service
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> CloudAgentView:
        self.calls.append((user_id, agent_id))
        if self.next_error is not None:
            raise self.next_error
        assert self.next_view is not None, "stub view not configured"
        # Mirror the real method: refresh status from whatever the test
        # configured; the view is returned by value.
        return self.next_view


@pytest_asyncio.fixture
async def stub_service():
    return _StubCloudAgentService()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, stub_service: _StubCloudAgentService):
    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_cloud_agent_service] = lambda: stub_service
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


async def _seed_cloud_agent(
    db: AsyncSession,
    *,
    cai_status: str = "ready",
    cdi_status: str = "ready",
    hosting_kind: str = "cloud",
) -> tuple[Agent, CloudAgentInstance, CloudDaemonInstance]:
    user_id = uuid.uuid4()
    daemon = DaemonInstance(
        id=generate_daemon_instance_id(),
        user_id=user_id,
        kind="cloud",
        refresh_token_hash="z" * 64,
    )
    db.add(daemon)
    await db.flush()
    cloud = CloudDaemonInstance(
        id=generate_cloud_daemon_instance_id(),
        user_id=user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        runtime="deepseek-tui",
        status=cdi_status,
        max_agents=3,
    )
    db.add(cloud)
    # Cheap deterministic agent id from a random pubkey — we don't need
    # the keypair, only the agent row.
    pubkey_b64 = "AA" + uuid.uuid4().hex[:42]
    agent = Agent(
        agent_id=generate_agent_id(pubkey_b64),
        display_name="ingress-test",
        user_id=user_id,
        hosting_kind=hosting_kind,
        runtime="deepseek-tui",
        daemon_instance_id=daemon.id,
    )
    db.add(agent)
    await db.flush()
    cai = CloudAgentInstance(
        id=generate_cloud_agent_instance_id(),
        user_id=user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud.id,
        daemon_instance_id=daemon.id,
        runtime="deepseek-tui",
        model_profile="default",
        status=cai_status,
    )
    db.add(cai)
    await db.commit()
    return agent, cai, cloud


def _view_from(
    agent: Agent,
    cai: CloudAgentInstance,
    cdi: CloudDaemonInstance,
    *,
    status_override: str | None = None,
) -> CloudAgentView:
    return CloudAgentView(
        cloud_agent_instance_id=cai.id,
        agent_id=cai.agent_id,
        name=agent.display_name,
        bio=agent.bio,
        avatar_url=agent.avatar_url,
        user_id=cai.user_id,
        hosting_kind=agent.hosting_kind or "cloud",
        runtime=cai.runtime,
        model_profile=cai.model_profile,
        status=status_override or cai.status,
        cloud_daemon_instance_id=cdi.id,
        cloud_daemon_status=cdi.status,
        provider=cdi.provider,
        provider_sandbox_id=cdi.provider_sandbox_id,
        created_at=cai.created_at,
        updated_at=cai.updated_at,
        last_run_at=cai.last_run_at,
        error_code=None,
        error_message=None,
    )


async def _register_daemon_online(cdi: CloudDaemonInstance, daemon: DaemonInstance) -> _CloudDaemonConn:
    conn = _CloudDaemonConn(
        ws=_FakeWS(),
        user_id=str(cdi.user_id),
        cloud_daemon_instance_id=cdi.id,
        daemon_instance_id=daemon.id,
    )
    await _registry_for_tests().register(conn)
    return conn


# ---------------------------------------------------------------------------
# Auth tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ensure_running_rejects_missing_bearer(
    client: AsyncClient, db_session: AsyncSession
):
    agent, _, _ = await _seed_cloud_agent(db_session)
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_test"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_ensure_running_rejects_wrong_secret(
    client: AsyncClient, db_session: AsyncSession
):
    agent, _, _ = await _seed_cloud_agent(db_session)
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_test"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_ensure_running_disabled_when_private_endpoints_off(
    client: AsyncClient, db_session: AsyncSession, monkeypatch
):
    monkeypatch.setattr(hub_config, "ALLOW_PRIVATE_ENDPOINTS", False)
    agent, _, _ = await _seed_cloud_agent(db_session)
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_test"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_internal_secret_also_accepted(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    stub_service: _StubCloudAgentService,
):
    monkeypatch.setattr(hub_config, "INTERNAL_API_SECRET", "alt-secret")
    agent, cai, cdi = await _seed_cloud_agent(db_session)
    conn = await _register_daemon_online(cdi, await db_session.get(DaemonInstance, cai.daemon_instance_id))
    try:
        stub_service.next_view = _view_from(agent, cai, cdi)
        resp = await client.post(
            f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
            json={"gateway_id": "gw_alt"},
            headers={"Authorization": "Bearer alt-secret"},
        )
        assert resp.status_code == 200
    finally:
        await _registry_for_tests().unregister(conn)


# ---------------------------------------------------------------------------
# Behavior tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ensure_running_returns_runtime_when_ready(
    client: AsyncClient,
    db_session: AsyncSession,
    stub_service: _StubCloudAgentService,
):
    agent, cai, cdi = await _seed_cloud_agent(db_session)
    daemon = await db_session.get(DaemonInstance, cai.daemon_instance_id)
    conn = await _register_daemon_online(cdi, daemon)
    try:
        stub_service.next_view = _view_from(agent, cai, cdi)
        resp = await client.post(
            f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
            json={
                "gateway_id": "gw_tg_test",
                "reason": "third_party_inbound",
                "event_id": "evt_abc",
            },
            headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ready"
        assert body["agent_id"] == agent.agent_id
        assert body["cloud_daemon_instance_id"] == cdi.id
        runtime = body["runtime"]
        assert runtime is not None
        assert runtime["session_endpoint"] == hub_config.CLOUD_GATEWAY_RUNTIME_ENDPOINT
        assert runtime["expires_in"] > 0

        claims = verify_runtime_session_token(runtime["session_token"])
        assert claims["agent_id"] == agent.agent_id
        assert claims["gateway_id"] == "gw_tg_test"
        assert claims["event_id"] == "evt_abc"
        assert claims["cloud_daemon_instance_id"] == cdi.id
        # Service was called with the agent's owning user.
        assert stub_service.calls == [(agent.user_id, agent.agent_id)]
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_ensure_running_downgrades_ready_when_ws_offline(
    client: AsyncClient,
    db_session: AsyncSession,
    stub_service: _StubCloudAgentService,
):
    """``resume`` may report ready while the WS hasn't reconnected yet;
    ingress must see ``provisioning`` (no token) instead of a token it
    cannot use."""
    agent, cai, cdi = await _seed_cloud_agent(db_session)
    stub_service.next_view = _view_from(agent, cai, cdi, status_override="ready")
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_offline"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "provisioning"
    assert body["runtime"] is None


@pytest.mark.asyncio
async def test_ensure_running_failed_view_returns_error(
    client: AsyncClient,
    db_session: AsyncSession,
    stub_service: _StubCloudAgentService,
):
    agent, cai, cdi = await _seed_cloud_agent(db_session)
    failed_view = _view_from(agent, cai, cdi, status_override="failed")
    failed_view.error_code = "provider_create_failed"
    failed_view.error_message = "boom"
    stub_service.next_view = failed_view
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_fail"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["runtime"] is None
    assert body["error"] == {"code": "provider_create_failed", "message": "boom"}


@pytest.mark.asyncio
async def test_ensure_running_swallowed_service_error_returns_payload(
    client: AsyncClient,
    db_session: AsyncSession,
    stub_service: _StubCloudAgentService,
):
    agent, _cai, _cdi = await _seed_cloud_agent(db_session)
    stub_service.next_error = CloudAgentError(
        "provider_create_failed", "sandbox unavailable", http_status=502
    )
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_err"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["error"]["code"] == "provider_create_failed"


@pytest.mark.asyncio
async def test_ensure_running_404_when_agent_not_cloud(
    client: AsyncClient,
    db_session: AsyncSession,
):
    agent, _cai, _cdi = await _seed_cloud_agent(db_session, hosting_kind="daemon")
    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/ensure-running",
        json={"gateway_id": "gw_x"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_ensure_running_404_when_agent_missing(
    client: AsyncClient,
):
    resp = await client.post(
        "/internal/cloud-gateway/agents/ag_doesnotexist/ensure-running",
        json={"gateway_id": "gw_x"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_runtime_returns_paused_when_offline(
    client: AsyncClient, db_session: AsyncSession
):
    agent, _cai, _cdi = await _seed_cloud_agent(db_session)
    resp = await client.get(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/runtime",
        params={"gateway_id": "gw_get"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "paused"
    assert body["runtime"] is None


@pytest.mark.asyncio
async def test_get_runtime_returns_token_when_ready_and_online(
    client: AsyncClient, db_session: AsyncSession
):
    agent, cai, cdi = await _seed_cloud_agent(db_session)
    daemon = await db_session.get(DaemonInstance, cai.daemon_instance_id)
    conn = await _register_daemon_online(cdi, daemon)
    try:
        resp = await client.get(
            f"/internal/cloud-gateway/agents/{agent.agent_id}/runtime",
            params={"gateway_id": "gw_get"},
            headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ready"
        token = body["runtime"]["session_token"]
        claims = verify_runtime_session_token(token)
        assert claims["agent_id"] == agent.agent_id
        assert claims["gateway_id"] == "gw_get"
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_touch_updates_last_run_at(
    client: AsyncClient, db_session: AsyncSession
):
    agent, cai, _cdi = await _seed_cloud_agent(db_session)
    before = cai.last_run_at
    assert before is None

    resp = await client.post(
        f"/internal/cloud-gateway/agents/{agent.agent_id}/touch",
        json={"gateway_id": "gw_touch", "reason": "outbound_sent"},
        headers={"Authorization": f"Bearer {INGRESS_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == agent.agent_id
    assert body["acknowledged_at"] > 0

    refreshed = await db_session.get(CloudAgentInstance, cai.id)
    assert refreshed is not None
    assert refreshed.last_run_at is not None
    # Tolerate sub-second skew between server clock and assert.
    assert (
        datetime.datetime.now(datetime.timezone.utc) - refreshed.last_run_at
    ).total_seconds() < 5


@pytest.mark.asyncio
async def test_relay_runtime_status_forwards_typing_to_registered_ws():
    """Daemon-emitted typing status reaches the live ingress runtime WS."""
    import json

    from hub.routers.cloud_gateway_internal import (
        _register_inflight_runtime_ws,
        _unregister_inflight_runtime_ws,
        relay_runtime_status_to_ingress,
    )

    sent: list[str] = []

    class _FakeWs:
        async def send_text(self, payload: str) -> None:
            sent.append(payload)

    ws = _FakeWs()
    key = ("cloud_inst_typing", "evt_typing")
    await _register_inflight_runtime_ws(key, ws)
    try:
        ok = await relay_runtime_status_to_ingress(
            cloud_daemon_instance_id="cloud_inst_typing",
            params={
                "eventId": "evt_typing",
                "turnId": "turn_typing",
                "gatewayId": "gw_wc",
                "agentId": "ag_typing",
                "conversationId": "wechat:user:alice",
                "kind": "typing",
                "phase": "started",
                "traceId": "wechat:alice:1",
            },
        )
    finally:
        await _unregister_inflight_runtime_ws(key, ws)
    assert ok is True
    assert len(sent) == 1
    frame = json.loads(sent[0])
    assert frame["type"] == "gateway_outbound_typing"
    assert frame["event_id"] == "evt_typing"
    assert frame["gateway_id"] == "gw_wc"
    assert frame["agent_id"] == "ag_typing"
    assert frame["conversation_id"] == "wechat:user:alice"
    assert frame["phase"] == "started"
    assert frame["trace_id"] == "wechat:alice:1"


@pytest.mark.asyncio
async def test_relay_runtime_status_drops_when_no_registered_ws():
    """No registered WS for the event → relay is a silent no-op."""
    from hub.routers.cloud_gateway_internal import (
        relay_runtime_status_to_ingress,
    )

    ok = await relay_runtime_status_to_ingress(
        cloud_daemon_instance_id="cloud_inst_missing",
        params={
            "eventId": "evt_missing",
            "kind": "typing",
            "phase": "started",
        },
    )
    assert ok is False


@pytest.mark.asyncio
async def test_runtime_session_token_rejects_wrong_kind():
    import jwt as pyjwt

    token = pyjwt.encode(
        {
            "kind": "agent",
            "iss": "botcord-cloud-gateway",
            "agent_id": "ag_x",
            "gateway_id": "gw_x",
        },
        hub_config.JWT_SECRET,
        algorithm=hub_config.JWT_ALGORITHM,
    )
    with pytest.raises(ValueError):
        verify_runtime_session_token(token)

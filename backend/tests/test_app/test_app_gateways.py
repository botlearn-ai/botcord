"""Tests for /api/agents/{agent_id}/gateways (BFF — third-party gateways)."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from unittest.mock import AsyncMock

from hub.auth import create_agent_token
from hub.enums import MessagePolicy
from hub.models import (
    Agent,
    AgentGatewayConnection,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
    Role,
    User,
    UserRole,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_engine():
    engine = create_async_engine(
        TEST_DB_URL,
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
async def db_session(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        yield s


@pytest_asyncio.fixture
async def client(db_session, monkeypatch):
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(hub.config, "BETA_GATE_ENABLED", False)
    import app.auth

    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    """Owner with a daemon-hosted agent + a different user with a daemon agent.

    Also seeds a non-daemon-hosted OpenClaw agent owned by the same user so we
    can assert the 422 ``agent_not_daemon_hosted`` branch.
    """
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="U",
        email="u@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
    )
    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add_all([user, role])
    await db_session.flush()
    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id))

    daemon = DaemonInstance(
        id="dm_abcdef123456",
        user_id=user_id,
        label="laptop",
        refresh_token_hash="hash",
    )
    cloud_daemon_row = DaemonInstance(
        id="dm_cloud123456",
        user_id=user_id,
        label="cloud-codex",
        kind="cloud",
        refresh_token_hash="cloud-hash",
    )
    db_session.add_all([daemon, cloud_daemon_row])

    other_user_id = uuid.uuid4()
    other_user = User(
        id=other_user_id,
        display_name="Other",
        email="o@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
    )
    other_daemon = DaemonInstance(
        id="dm_otherbeefcafe",
        user_id=other_user_id,
        label="other",
        refresh_token_hash="hash2",
    )
    db_session.add_all([other_user, other_daemon])
    await db_session.flush()

    now = datetime.datetime.now(datetime.timezone.utc)
    daemon_agent = Agent(
        agent_id="ag_daemon",
        display_name="Daemon Agent",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        claimed_at=now,
        hosting_kind="daemon",
        daemon_instance_id="dm_abcdef123456",
    )
    openclaw_agent = Agent(
        agent_id="ag_openclaw",
        display_name="OpenClaw Agent",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        claimed_at=now,
        hosting_kind="openclaw",
    )
    cloud_agent = Agent(
        agent_id="ag_cloud",
        display_name="Cloud Agent",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        claimed_at=now,
        hosting_kind="cloud",
        daemon_instance_id="dm_cloud123456",
    )
    other_agent = Agent(
        agent_id="ag_other",
        display_name="Other Daemon",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=other_user_id,
        claimed_at=now,
        hosting_kind="daemon",
        daemon_instance_id="dm_otherbeefcafe",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_abcdef123456",
        user_id=user_id,
        daemon_instance_id="dm_cloud123456",
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_abcdef123456",
        user_id=user_id,
        agent_id="ag_cloud",
        cloud_daemon_instance_id="cloud_dm_abcdef123456",
        daemon_instance_id="dm_cloud123456",
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all(
        [
            daemon_agent,
            openclaw_agent,
            cloud_agent,
            other_agent,
            cloud_daemon,
            cloud_binding,
        ]
    )
    await db_session.commit()
    return {
        "token": _token(str(supabase_uuid)),
        "user_id": user_id,
        "daemon_id": "dm_abcdef123456",
        "cloud_daemon_row_id": "dm_cloud123456",
        "cloud_daemon_id": "cloud_dm_abcdef123456",
    }


def _patch_daemon(monkeypatch, *, online: bool, send=None):
    """Stub the gateways router's daemon hooks."""
    import app.routers.gateways as gw

    monkeypatch.setattr(gw, "is_daemon_online", lambda _id: online)
    if send is not None:
        monkeypatch.setattr(gw, "send_control_frame", send)


def _patch_cloud_daemon(monkeypatch, *, online: bool, send=None):
    """Stub the gateways router's cloud-daemon hooks."""
    import app.routers.gateways as gw

    monkeypatch.setattr(gw, "is_cloud_daemon_online", lambda _id: online)
    if send is not None:
        monkeypatch.setattr(gw, "send_cloud_control_frame", send)


def _patch_hub_gateway_send(monkeypatch, *, online: bool, send=None):
    """Stub the /hub/gateways/{id}/send daemon hooks."""
    import hub.routers.hub as hub_router

    monkeypatch.setattr(hub_router, "is_daemon_online", lambda _id: online)
    if send is not None:
        monkeypatch.setattr(hub_router, "send_control_frame", send)


async def _insert_gateway(
    db_session: AsyncSession,
    *,
    gateway_id: str = "gw_tg_send",
    user_id: uuid.UUID | None = None,
    provider: str = "telegram",
    agent_id: str = "ag_daemon",
    daemon_id: str = "dm_abcdef123456",
    enabled: bool = True,
    status: str = "active",
    config: dict | None = None,
) -> AgentGatewayConnection:
    row = AgentGatewayConnection(
        id=gateway_id,
        user_id=user_id or uuid.UUID("00000000-0000-0000-0000-000000000001"),
        agent_id=agent_id,
        daemon_instance_id=daemon_id,
        provider=provider,
        status=status,
        enabled=enabled,
        config_json=config or {
            "allowedChatIds": ["-1001"],
            "allowedSenderIds": ["42"],
        },
    )
    db_session.add(row)
    await db_session.commit()
    return row


# ---------------------------------------------------------------------------
# Auth / ownership / shape gates
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_empty_when_no_connections(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_daemon/gateways", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"gateways": []}


@pytest.mark.asyncio
async def test_list_404_for_other_users_agent(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_other/gateways", headers=headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_rejects_non_daemon_agent(client, seed, monkeypatch):
    _patch_daemon(monkeypatch, online=True)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_openclaw/gateways",
        headers=headers,
        json={"provider": "telegram", "bot_token": "t"},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "agent_not_daemon_hosted"


@pytest.mark.asyncio
async def test_create_returns_409_when_daemon_offline(client, seed, monkeypatch):
    _patch_daemon(monkeypatch, online=False)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={"provider": "telegram", "bot_token": "telegrambot:abc"},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"


@pytest.mark.asyncio
async def test_agent_gateway_send_dispatches_to_daemon(client, seed, db_session, monkeypatch):
    token, _ = create_agent_token("ag_daemon")
    await _insert_gateway(db_session, user_id=seed["user_id"])
    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append(
            {
                "daemon_instance_id": daemon_instance_id,
                "type": type_,
                "params": params,
                "timeout_ms": timeout_ms,
            }
        )
        return {
            "ok": True,
            "result": {"providerMessageId": "telegram:-1001:10"},
        }

    _patch_hub_gateway_send(monkeypatch, online=True, send=fake_send)
    r = await client.post(
        "/hub/gateways/gw_tg_send/send",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "conversationId": "telegram:group:-1001",
            "text": "hello",
            "idempotencyKey": "k1",
        },
    )

    assert r.status_code == 200, r.text
    assert r.json() == {
        "ok": True,
        "gateway_id": "gw_tg_send",
        "conversation_id": "telegram:group:-1001",
        "provider_message_id": "telegram:-1001:10",
    }
    assert calls == [
        {
            "daemon_instance_id": seed["daemon_id"],
            "type": "gateway_send",
            "params": {
                "agentId": "ag_daemon",
                "gatewayId": "gw_tg_send",
                "conversationId": "telegram:group:-1001",
                "text": "hello",
                "idempotencyKey": "k1",
            },
            "timeout_ms": 30000,
        }
    ]


@pytest.mark.asyncio
async def test_agent_gateway_send_rejects_unallowed_conversation(
    client, seed, db_session, monkeypatch
):
    token, _ = create_agent_token("ag_daemon")
    await _insert_gateway(db_session, user_id=seed["user_id"])
    fake_send = AsyncMock()
    _patch_hub_gateway_send(monkeypatch, online=True, send=fake_send)

    r = await client.post(
        "/hub/gateways/gw_tg_send/send",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversationId": "telegram:group:-9999", "text": "hello"},
    )

    assert r.status_code == 403
    assert r.json()["detail"] == "gateway_conversation_not_allowed"
    fake_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_agent_gateway_send_feishu_empty_allowlist_allows(
    client, seed, db_session, monkeypatch
):
    # Feishu inbound is allow-all on an empty allowlist; outbound mirrors it.
    token, _ = create_agent_token("ag_daemon")
    await _insert_gateway(
        db_session,
        gateway_id="gw_feishu_send",
        provider="feishu",
        user_id=seed["user_id"],
        config={"allowedChatIds": [], "allowedSenderIds": []},
    )
    fake_send = AsyncMock(return_value={"ok": True, "result": {}})
    _patch_hub_gateway_send(monkeypatch, online=True, send=fake_send)

    r = await client.post(
        "/hub/gateways/gw_feishu_send/send",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversationId": "feishu:user:oc_cdbee73a39d", "text": "hi"},
    )

    assert r.status_code == 200, r.text
    fake_send.assert_awaited()


@pytest.mark.asyncio
async def test_agent_gateway_send_telegram_empty_allowlist_denies(
    client, seed, db_session, monkeypatch
):
    # Telegram inbound is default-deny on an empty allowlist; outbound mirrors it.
    token, _ = create_agent_token("ag_daemon")
    await _insert_gateway(
        db_session,
        gateway_id="gw_tg_empty",
        provider="telegram",
        user_id=seed["user_id"],
        config={"allowedChatIds": [], "allowedSenderIds": []},
    )
    fake_send = AsyncMock()
    _patch_hub_gateway_send(monkeypatch, online=True, send=fake_send)

    r = await client.post(
        "/hub/gateways/gw_tg_empty/send",
        headers={"Authorization": f"Bearer {token}"},
        json={"conversationId": "telegram:group:-1001", "text": "hi"},
    )

    assert r.status_code == 403
    assert r.json()["detail"] == "gateway_conversation_not_allowed"
    fake_send.assert_not_awaited()


# ---------------------------------------------------------------------------
# Create — Telegram happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_telegram_persists_metadata_and_token_preview(
    client, seed, db_session, monkeypatch
):
    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append(
            {
                "daemon_instance_id": daemon_instance_id,
                "type": type_,
                "params": params,
            }
        )
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "telegram",
                "accountId": params["accountId"],
                "enabled": True,
                "tokenPreview": "1234...wxyz",
                "status": {"running": True, "authorized": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "label": "my bot",
            "bot_token": "1234:abcd",
            "config": {
                "allowedChatIds": ["111"],
                "allowedSenderIds": ["111"],
                "splitAt": 1800,
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "telegram"
    assert body["status"] == "active"
    assert body["enabled"] is True
    assert body["config"]["tokenPreview"] == "1234...wxyz"
    assert body["config"]["allowedChatIds"] == ["111"]
    assert body["config"]["allowedSenderIds"] == ["111"]
    assert body["config"]["splitAt"] == 1800
    assert body["daemon_instance_id"] == seed["daemon_id"]

    # Daemon got upsert_gateway with the bot token in `secret`, not in DB.
    assert len(calls) == 1
    p = calls[0]["params"]
    assert calls[0]["type"] == "upsert_gateway"
    assert p["type"] == "telegram"
    assert p["accountId"] == "ag_daemon"
    assert p["secret"] == {"botToken": "1234:abcd"}
    assert p["settings"]["allowedChatIds"] == ["111"]
    assert p["settings"]["allowedSenderIds"] == ["111"]

    # DB row carries no botToken.
    rows = (
        await db_session.execute(
            select(AgentGatewayConnection).where(
                AgentGatewayConnection.agent_id == "ag_daemon"
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert "botToken" not in (rows[0].config_json or {})
    assert rows[0].config_json.get("tokenPreview") == "1234...wxyz"


# ---------------------------------------------------------------------------
# Phase 2 — Cloud agent routes proxy to gateway-ingress, NOT the cloud daemon
# ---------------------------------------------------------------------------
#
# These tests live next to the daemon-path tests above. They mock the
# ingress HTTP client via the ``set_http_client`` seam on
# ``app.clients.cloud_gateway_ingress_client`` so no real network is needed.


class _FakeIngressResponse:
    """Minimal stand-in for ``httpx.Response`` used by the ingress client.

    We only implement the surface the client actually inspects:
    ``status_code``, ``content``, and ``json()``.
    """

    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body
        # ``content`` is checked for truthiness; bytes(0) or None both signal
        # "no body" so we keep it None when there's no payload.
        self.content = b"x" if body is not None else b""

    def json(self) -> dict:
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _FakeIngressClient:
    """Recording fake that satisfies ``httpx.AsyncClient.request``."""

    def __init__(self, responder):
        self._responder = responder
        self.calls: list[dict] = []

    async def request(self, method, url, headers=None, json=None, timeout=None):
        self.calls.append({"method": method, "url": url, "json": json})
        # responder may return a Response, raise, or be sync — keep contract minimal
        result = self._responder(method, url, json)
        if isinstance(result, Exception):
            raise result
        return result


def _install_ingress(monkeypatch, responder, *, configured: bool = True):
    import hub.config as hub_config
    from app.clients import cloud_gateway_ingress_client as client_mod

    if configured:
        monkeypatch.setattr(
            hub_config, "CLOUD_GATEWAY_INGRESS_BASE_URL", "http://ingress.test"
        )
        monkeypatch.setattr(
            hub_config, "CLOUD_GATEWAY_INGRESS_SECRET", "test-secret"
        )
    else:
        monkeypatch.setattr(hub_config, "CLOUD_GATEWAY_INGRESS_BASE_URL", None)
    fake = _FakeIngressClient(responder)
    client_mod.set_http_client(fake)
    monkeypatch.setattr(
        client_mod,
        "set_http_client",
        client_mod.set_http_client,  # keep symbol intact
    )
    # Auto-restore on teardown.
    monkeypatch.setattr(
        client_mod, "_test_http_client", fake, raising=False
    )
    monkeypatch.setattr(
        client_mod, "DEFAULT_TIMEOUT_SECONDS", 10.0
    )
    monkeypatch.setattr(client_mod, "set_http_client", client_mod.set_http_client)

    def _restore():
        client_mod.set_http_client(None)

    monkeypatch.setattr(client_mod, "_restore_after_test", _restore, raising=False)
    return fake


@pytest.mark.asyncio
async def test_create_telegram_for_cloud_agent_proxies_to_ingress(
    client, seed, db_session, monkeypatch
):
    """Cloud agent CREATE must call gateway-ingress, never the cloud daemon."""

    def responder(method, url, body):
        assert method == "POST"
        # Hub now drives Telegram cloud setup via loginStart→finalize so the
        # bot token never crosses the Hub mirror table. The first call mints
        # a loginId; the second uses it to finalize the connection.
        if "/gateways/telegram/login/start" in url:
            assert body["user_id"] == str(seed["user_id"])
            assert body["hosting_kind"] == "cloud"
            assert body["botToken"] == "1234:abcd"
            return _FakeIngressResponse(
                200,
                {
                    "ok": True,
                    "loginId": "tgl_cloud01",
                    "expiresAt": 1700000000,
                    "publicPayload": {
                        "tokenPreview": "1234...wxyz",
                        "botInfo": {"id": 99, "is_bot": True},
                    },
                },
            )
        assert url.endswith("/internal/gateway-ingress/agents/ag_cloud/gateways")
        assert body["user_id"] == str(seed["user_id"])
        assert body["hosting_kind"] == "cloud"
        assert body["loginId"] == "tgl_cloud01"
        # Hub no longer forwards the raw token here — ingress already holds it.
        assert "secret" not in body
        return _FakeIngressResponse(
            200,
            {
                "id": "gw_telegram_cloud01",
                "provider": "telegram",
                "agent_id": "ag_cloud",
                "user_id": str(seed["user_id"]),
                "label": "cloud tg",
                # Old ingress builds returned pending even after the runner
                # was registered. Hub should normalize the successful cloud
                # mirror to active during mixed-version rollout.
                "status": "pending",
                "enabled": True,
                "config_json": {
                    "allowedChatIds": ["111"],
                    "allowedSenderIds": ["111"],
                    "tokenPreview": "1234...wxyz",
                },
            },
        )

    fake = _install_ingress(monkeypatch, responder)
    # Ensure the cloud daemon channel is NOT consulted.
    _patch_daemon(monkeypatch, online=False)

    def _no_cloud(*a, **k):
        raise AssertionError("cloud daemon control frame must not be used for cloud agent")

    monkeypatch.setattr(
        "app.routers.gateways.send_cloud_control_frame", _no_cloud
    )

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "label": "cloud tg",
            "bot_token": "1234:abcd",
            "config": {
                "allowedChatIds": ["111"],
                "allowedSenderIds": ["111"],
            },
        },
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "telegram"
    assert body["status"] == "active"
    assert body["config"]["tokenPreview"] == "1234...wxyz"
    # loginStart + create
    assert len(fake.calls) == 2

    # Mirror row: only safe fields, never a botToken / secret payload.
    row = await db_session.scalar(
        select(AgentGatewayConnection).where(
            AgentGatewayConnection.agent_id == "ag_cloud"
        )
    )
    assert row is not None
    assert row.status == "active"
    assert "botToken" not in (row.config_json or {})
    assert row.config_json.get("tokenPreview") == "1234...wxyz"
    # daemon_instance_id mirror falls back to the cloud agent's
    # assigned daemon row (FK NOT NULL).
    assert row.daemon_instance_id == seed["cloud_daemon_row_id"]


@pytest.mark.asyncio
async def test_cloud_agent_setup_logs_setup_owner_gateway_ingress(
    client, seed, monkeypatch, caplog
):
    def responder(method, url, body):
        return _FakeIngressResponse(
            200,
            {
                "loginId": "wxl_xyz",
                "qrcode": "QR",
                "qrcodeUrl": "https://qr",
                "expiresAt": 1700000000,
            },
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    with caplog.at_level("INFO", logger="app.routers.gateways"):
        r = await client.post(
            "/api/agents/ag_cloud/gateways/wechat/login/start",
            headers=headers,
            json={},
        )
    assert r.status_code == 200, r.text

    setup_records = [
        rec for rec in caplog.records
        if rec.getMessage() == "cloud-gateway setup event"
    ]
    assert setup_records, "expected at least one setup event log"
    for rec in setup_records:
        assert getattr(rec, "setup_owner", None) == "gateway-ingress"


@pytest.mark.asyncio
async def test_cloud_agent_setup_propagates_ingress_error_code(
    client, seed, monkeypatch
):
    """ingress 4xx error codes must reach the user verbatim — that's the
    whole point of the Phase 2 split. ``login_missing`` is the canonical
    failure the dashboard branches on."""

    def responder(method, url, body):
        return _FakeIngressResponse(
            404,
            {"ok": False, "error": {"code": "login_missing", "message": "..."}},
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways/wechat/login/status",
        headers=headers,
        json={"loginId": "wxl_missing"},
    )
    assert r.status_code == 404, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["code"] == "login_missing"


@pytest.mark.asyncio
async def test_cloud_agent_setup_returns_502_when_ingress_unreachable(
    client, seed, monkeypatch
):
    import httpx

    def responder(method, url, body):
        return httpx.ConnectError("ingress down")

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways/wechat/login/start",
        headers=headers,
        json={},
    )
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["code"] == "cloud_gateway_ingress_unavailable"


@pytest.mark.asyncio
async def test_cloud_agent_setup_returns_503_when_ingress_unconfigured(
    client, seed, monkeypatch
):
    def responder(method, url, body):  # pragma: no cover — must not be called
        raise AssertionError("ingress client must short-circuit on missing config")

    _install_ingress(monkeypatch, responder, configured=False)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways/wechat/login/start",
        headers=headers,
        json={},
    )
    assert r.status_code == 503, r.text
    body = r.json()
    # FastAPI wraps str detail under "detail" / i18n payload top-level.
    assert "cloud_gateway_ingress_not_configured" in body.get(
        "detail", ""
    ) or body.get("error") == "cloud_gateway_ingress_not_configured"


@pytest.mark.asyncio
async def test_cloud_agent_does_not_require_cloud_daemon_online(
    client, seed, monkeypatch
):
    """Phase 2 core invariant: cloud daemon online check is NOT consulted on
    cloud-agent setup paths. We assert by making both daemons offline AND
    making any cloud-daemon-related lookup blow up loudly."""

    def responder(method, url, body):
        return _FakeIngressResponse(
            200,
            {
                "loginId": "wxl_ok",
                "qrcode": "QR",
                "qrcodeUrl": "https://qr",
                "expiresAt": 0,
            },
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    def _boom(*a, **k):
        raise AssertionError("cloud daemon must not be consulted for cloud setup")

    monkeypatch.setattr("app.routers.gateways.is_cloud_daemon_online", _boom)
    monkeypatch.setattr("app.routers.gateways._ensure_gateway_host_online", _boom)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways/wechat/login/start",
        headers=headers,
        json={},
    )
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(
    ("path", "request_body", "expected_ingress_suffix", "response_check"),
    [
        (
            "/api/agents/ag_cloud/gateways/wechat/login/start",
            {},
            "/internal/gateway-ingress/agents/ag_cloud/gateways/wechat/login/start",
            lambda body: body["loginId"] == "wxl_cloud"
            and body["qrcode"] == "QR"
            and body["qrcodeUrl"] == "https://qr",
        ),
        (
            "/api/agents/ag_cloud/gateways/wechat/login/status",
            {"loginId": "wxl_cloud"},
            "/internal/gateway-ingress/agents/ag_cloud/gateways/wechat/login/status",
            lambda body: body["status"] == "confirmed"
            and body["tokenPreview"] == "tok...view",
        ),
        (
            "/api/agents/ag_cloud/gateways/wechat/senders",
            {"loginId": "wxl_cloud", "timeoutSeconds": 1},
            "/internal/gateway-ingress/agents/ag_cloud/gateways/wechat/discover",
            lambda body: body["senders"] == [{"senderId": "alice", "preview": "hi"}],
        ),
        (
            "/api/agents/ag_cloud/gateways/feishu/login/start",
            {"domain": "feishu"},
            "/internal/gateway-ingress/agents/ag_cloud/gateways/feishu/login/start",
            lambda body: body["loginId"] == "fsl_cloud"
            and body["qrcodeUrl"] == "https://accounts.feishu.cn/verify",
        ),
        (
            "/api/agents/ag_cloud/gateways/feishu/login/status",
            {"loginId": "fsl_cloud"},
            "/internal/gateway-ingress/agents/ag_cloud/gateways/feishu/login/status",
            lambda body: body["status"] == "confirmed"
            and body["appId"] == "cli_cloud"
            and body["tokenPreview"] == "fei...view",
        ),
    ],
)
@pytest.mark.asyncio
async def test_cloud_agent_login_setup_routes_never_dispatch_daemon_or_lifecycle(
    client,
    seed,
    monkeypatch,
    path,
    request_body,
    expected_ingress_suffix,
    response_check,
):
    """Cloud-hosted setup is owned by gateway-ingress.

    Login/discovery setup must not wake the runtime sandbox and must not send
    daemon gateway_login_* control frames. Runtime lifecycle stays behind
    /internal/cloud-gateway/.../ensure-running and is used only after provider
    inbound events exist.
    """

    def responder(method, url, body):
        assert method == "POST"
        assert url.endswith(expected_ingress_suffix)
        assert "/internal/cloud-gateway/" not in url
        assert body["user_id"] == str(seed["user_id"])
        assert body["hosting_kind"] == "cloud"
        if url.endswith("/wechat/login/start"):
            return _FakeIngressResponse(
                200,
                {
                    "loginId": "wxl_cloud",
                    "expiresAt": 1700000000,
                    "publicPayload": {
                        "qrcode": "QR",
                        "qrcodeUrl": "https://qr",
                    },
                },
            )
        if url.endswith("/wechat/login/status"):
            return _FakeIngressResponse(
                200,
                {
                    "loginId": "wxl_cloud",
                    "status": "confirmed",
                    "expiresAt": 1700000000,
                    "publicPayload": {
                        "baseUrl": "https://ilinkai.weixin.qq.com",
                        "tokenPreview": "tok...view",
                    },
                },
            )
        if url.endswith("/wechat/discover"):
            return _FakeIngressResponse(
                200,
                {"candidates": [{"senderId": "alice", "preview": "hi"}]},
            )
        if url.endswith("/feishu/login/start"):
            return _FakeIngressResponse(
                200,
                {
                    "loginId": "fsl_cloud",
                    "expiresAt": 1700000000,
                    "publicPayload": {
                        "qrcodeUrl": "https://accounts.feishu.cn/verify",
                    },
                },
            )
        if url.endswith("/feishu/login/status"):
            return _FakeIngressResponse(
                200,
                {
                    "loginId": "fsl_cloud",
                    "status": "confirmed",
                    "expiresAt": 1700000000,
                    "publicPayload": {
                        "appId": "cli_cloud",
                        "domain": "feishu",
                        "userOpenId": "ou_cloud",
                        "tokenPreview": "fei...view",
                    },
                },
            )
        raise AssertionError(f"unexpected ingress url: {url}")

    fake = _install_ingress(monkeypatch, responder)

    def _no_daemon_control(*a, **k):
        raise AssertionError("cloud setup must not dispatch daemon control frames")

    def _no_lifecycle(*a, **k):
        raise AssertionError("setup must not call cloud runtime lifecycle")

    monkeypatch.setattr("app.routers.gateways.send_control_frame", _no_daemon_control)
    monkeypatch.setattr("app.routers.gateways.send_cloud_control_frame", _no_daemon_control)
    monkeypatch.setattr("app.routers.gateways.is_cloud_daemon_online", _no_lifecycle)
    monkeypatch.setattr(
        "app.routers.gateways.CloudAgentService.resume_cloud_agent",
        _no_lifecycle,
    )

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(path, headers=headers, json=request_body)

    assert r.status_code == 200, r.text
    assert response_check(r.json())
    assert len(fake.calls) == 1


@pytest.mark.asyncio
async def test_create_telegram_requires_bot_token(client, seed, monkeypatch):
    _patch_daemon(monkeypatch, online=True)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={"provider": "telegram"},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "missing_bot_token"


@pytest.mark.asyncio
async def test_create_wechat_requires_login_id(client, seed, monkeypatch):
    _patch_daemon(monkeypatch, online=True)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={"provider": "wechat"},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "missing_login_id"


@pytest.mark.parametrize(
    "config",
    [
        {"allowedChatIds": [], "allowedSenderIds": []},
        {"allowedChatIds": ["111"], "allowedSenderIds": []},
        {"allowedChatIds": [], "allowedSenderIds": ["111"]},
    ],
)
@pytest.mark.asyncio
async def test_create_telegram_requires_chat_and_sender_whitelists(
    client, seed, monkeypatch, config
):
    async def fake_send(*a, **kw):
        raise AssertionError("daemon contacted before whitelist validation")

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "1234:abcd",
            "config": config,
        },
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "missing_gateway_whitelist"


@pytest.mark.asyncio
async def test_create_wechat_requires_whitelist(client, seed, monkeypatch):
    async def fake_send(*a, **kw):
        raise AssertionError("daemon contacted before whitelist validation")

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "wechat",
            "loginId": "wxl_camel",
            "config": {"allowedSenderIds": []},
        },
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "missing_gateway_whitelist"


@pytest.mark.asyncio
async def test_create_wechat_forwards_login_id_no_token_in_db(
    client, seed, db_session, monkeypatch
):
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "wechat",
                "accountId": params["accountId"],
                "enabled": True,
                "tokenPreview": "wxab...mnop",
                "status": {"running": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "wechat",
            "label": "我的微信",
            "login_id": "wxl_abc",
            "config": {"allowedSenderIds": ["xxx@im.wechat"]},
        },
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["loginId"] == "wxl_abc"
    assert "secret" not in captured["params"]
    body = r.json()
    assert body["provider"] == "wechat"
    assert "tokenPreview" in body["config"]


@pytest.mark.asyncio
async def test_create_feishu_forwards_login_id_and_persists_public_metadata(
    client, seed, monkeypatch
):
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "feishu",
                "accountId": params["accountId"],
                "enabled": True,
                "tokenPreview": "feis...7890",
                "appId": "cli_feishu_123",
                "domain": "feishu",
                "userOpenId": "ou_alice",
                "status": {"running": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "feishu",
            "label": "飞书助手",
            "loginId": "fsl_abc",
            "config": {"allowedSenderIds": ["ou_alice"], "domain": "feishu"},
        },
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["loginId"] == "fsl_abc"
    assert captured["params"]["type"] == "feishu"
    assert "secret" not in captured["params"]
    body = r.json()
    assert body["provider"] == "feishu"
    assert body["config"]["appId"] == "cli_feishu_123"
    assert body["config"]["userOpenId"] == "ou_alice"
    assert body["config"]["tokenPreview"] == "feis...7890"


# ---------------------------------------------------------------------------
# Daemon failure mapping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_maps_daemon_provider_auth_failure_to_400(
    client, seed, monkeypatch
):
    async def fake_send(*a, **kw):
        return {
            "ok": False,
            "error": {"code": "provider_auth_failed", "message": "bad token"},
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "x",
            "config": {"allowedChatIds": ["111"], "allowedSenderIds": ["111"]},
        },
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "provider_auth_failed"


@pytest.mark.asyncio
async def test_create_maps_other_daemon_errors_to_502(client, seed, monkeypatch):
    async def fake_send(*a, **kw):
        return {"ok": False, "error": {"code": "boom", "message": "kaboom"}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "x",
            "config": {"allowedChatIds": ["111"], "allowedSenderIds": ["111"]},
        },
    )
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "daemon_gateway_failed"


@pytest.mark.asyncio
async def test_create_propagates_504_timeout(client, seed, monkeypatch):
    async def boom(*a, **kw):
        raise HTTPException(status_code=504, detail="daemon_ack_timeout")

    _patch_daemon(monkeypatch, online=True, send=boom)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "x",
            "config": {"allowedChatIds": ["111"], "allowedSenderIds": ["111"]},
        },
    )
    assert r.status_code == 504


# ---------------------------------------------------------------------------
# PATCH / DELETE / TEST
# ---------------------------------------------------------------------------


async def _seed_one_connection(db_session: AsyncSession, seed: dict) -> str:
    gw_id = "gw_telegram_aaaaaa111111"
    row = AgentGatewayConnection(
        id=gw_id,
        user_id=seed["user_id"],
        agent_id="ag_daemon",
        daemon_instance_id=seed["daemon_id"],
        provider="telegram",
        label="bot",
        enabled=True,
        status="active",
        config_json={
            "allowedChatIds": ["111"],
            "allowedSenderIds": ["111"],
            "tokenPreview": "1234...wxyz",
        },
    )
    db_session.add(row)
    await db_session.commit()
    return gw_id


@pytest.mark.asyncio
async def test_patch_updates_settings_without_token(client, seed, db_session, monkeypatch):
    gw_id = await _seed_one_connection(db_session, seed)

    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {"ok": True, "result": {"status": {"running": True}}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        f"/api/agents/ag_daemon/gateways/{gw_id}",
        headers=headers,
        json={"label": "renamed", "config": {"allowedSenderIds": ["222"]}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["label"] == "renamed"
    assert body["config"]["allowedChatIds"] == ["111"]
    assert body["config"]["allowedSenderIds"] == ["222"]
    # tokenPreview survives merge.
    assert body["config"]["tokenPreview"] == "1234...wxyz"
    # `secret` was NOT forwarded (no rotation requested).
    assert "secret" not in captured["params"]


@pytest.mark.asyncio
async def test_delete_removes_row_after_daemon_ack(client, seed, db_session, monkeypatch):
    gw_id = await _seed_one_connection(db_session, seed)

    async def fake_send(*a, **kw):
        return {"ok": True, "result": {"id": gw_id, "removed": True}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.delete(f"/api/agents/ag_daemon/gateways/{gw_id}", headers=headers)
    assert r.status_code == 204
    rows = (
        await db_session.execute(
            select(AgentGatewayConnection).where(AgentGatewayConnection.id == gw_id)
        )
    ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_delete_force_removes_row_even_when_daemon_offline(
    client, seed, db_session, monkeypatch
):
    """C1: ?force=1 must skip the daemon round-trip and delete the DB row even
    when the daemon is offline (which would otherwise return 409)."""
    gw_id = await _seed_one_connection(db_session, seed)

    send_called = {"n": 0}

    async def fake_send(*a, **kw):
        send_called["n"] += 1
        return {"ok": True, "result": {}}

    # Daemon is OFFLINE — without force this would 409.
    _patch_daemon(monkeypatch, online=False, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.delete(
        f"/api/agents/ag_daemon/gateways/{gw_id}?force=1", headers=headers
    )
    assert r.status_code == 204, r.text

    # Row must be gone.
    rows = (
        await db_session.execute(
            select(AgentGatewayConnection).where(AgentGatewayConnection.id == gw_id)
        )
    ).scalars().all()
    assert rows == []

    # Daemon was NOT contacted.
    assert send_called["n"] == 0


@pytest.mark.asyncio
async def test_test_endpoint_returns_daemon_result(client, seed, db_session, monkeypatch):
    gw_id = await _seed_one_connection(db_session, seed)

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        assert type_ == "test_gateway"
        return {"ok": True, "result": {"id": gw_id, "ok": True, "info": {"username": "bot"}}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        f"/api/agents/ag_daemon/gateways/{gw_id}/test", headers=headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["info"]["username"] == "bot"


# ---------------------------------------------------------------------------
# WeChat login proxies
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wechat_login_start_proxies_without_writing_db(
    client, seed, db_session, monkeypatch, caplog
):
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["type"] = type_
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "loginId": "wxl_xyz",
                "qrcode": "QR",
                "qrcodeUrl": "https://qr",
                "expiresAt": 1700000000,
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    with caplog.at_level("INFO", logger="app.routers.gateways"):
        r = await client.post(
            "/api/agents/ag_daemon/gateways/wechat/login/start",
            headers=headers,
            json={},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["loginId"] == "wxl_xyz"
    assert body["qrcode"] == "QR"
    assert captured["type"] == "gateway_login_start"
    assert captured["params"]["provider"] == "wechat"
    assert captured["params"]["accountId"] == "ag_daemon"

    # No connection rows should have been written.
    rows = (
        await db_session.execute(select(AgentGatewayConnection))
    ).scalars().all()
    assert rows == []

    # Phase 0 diagnostic logging: started + ok with structured extras.
    setup_records = [
        rec for rec in caplog.records
        if rec.getMessage() == "cloud-gateway setup event"
    ]
    outcomes = [getattr(rec, "outcome", None) for rec in setup_records]
    assert "started" in outcomes
    assert "ok" in outcomes
    ok_rec = next(rec for rec in setup_records if getattr(rec, "outcome", None) == "ok")
    assert getattr(ok_rec, "agent_id", None) == "ag_daemon"
    assert getattr(ok_rec, "provider", None) == "wechat"
    assert getattr(ok_rec, "login_id", None) == "wxl_xyz"
    assert getattr(ok_rec, "setup_owner", None) == "daemon"
    assert hasattr(ok_rec, "daemon_instance_id")
    assert hasattr(ok_rec, "cloud_daemon_instance_id")
    assert hasattr(ok_rec, "hosting_kind")
    assert getattr(ok_rec, "error_code", "missing") is None


@pytest.mark.asyncio
async def test_wechat_login_status_proxies(client, seed, monkeypatch):
    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        assert type_ == "gateway_login_status"
        assert params == {"provider": "wechat", "loginId": "wxl_xyz", "accountId": "ag_daemon"}
        return {
            "ok": True,
            "result": {
                "status": "confirmed",
                "baseUrl": "https://ilinkai.weixin.qq.com",
                "tokenPreview": "abcd...wxyz",
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/login/status",
        headers=headers,
        json={"login_id": "wxl_xyz"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed"
    assert body["tokenPreview"] == "abcd...wxyz"


@pytest.mark.asyncio
async def test_feishu_login_start_and_status_proxy(client, seed, monkeypatch):
    calls: list[tuple[str, dict]] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append((type_, params))
        if type_ == "gateway_login_start":
            return {
                "ok": True,
                "result": {
                    "loginId": "fsl_xyz",
                    "qrcode": "DEV",
                    "qrcodeUrl": "https://accounts.feishu.cn/verify",
                    "expiresAt": 1700000000,
                },
            }
        return {
            "ok": True,
            "result": {
                "status": "confirmed",
                "appId": "cli_feishu_123",
                "domain": "feishu",
                "userOpenId": "ou_alice",
                "tokenPreview": "feis...7890",
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    start = await client.post(
        "/api/agents/ag_daemon/gateways/feishu/login/start",
        headers=headers,
        json={"domain": "feishu"},
    )
    assert start.status_code == 200, start.text
    assert start.json()["loginId"] == "fsl_xyz"
    status = await client.post(
        "/api/agents/ag_daemon/gateways/feishu/login/status",
        headers=headers,
        json={"loginId": "fsl_xyz"},
    )
    assert status.status_code == 200, status.text
    assert status.json()["appId"] == "cli_feishu_123"
    assert calls[0] == (
        "gateway_login_start",
        {"provider": "feishu", "accountId": "ag_daemon", "domain": "feishu"},
    )
    assert calls[1] == (
        "gateway_login_status",
        {"provider": "feishu", "loginId": "fsl_xyz", "accountId": "ag_daemon"},
    )
@pytest.mark.asyncio
async def test_wechat_recent_senders_proxies(client, seed, monkeypatch):
    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        assert type_ == "gateway_recent_senders"
        assert params == {
            "provider": "wechat",
            "loginId": "wxl_xyz",
            "accountId": "ag_daemon",
            "timeoutSeconds": 8,
        }
        return {
            "ok": True,
            "result": {
                "senders": [
                    {"id": "alice@im.wechat", "label": "Alice"},
                ],
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/senders",
        headers=headers,
        json={"loginId": "wxl_xyz", "timeoutSeconds": 8},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["senders"] == [{"id": "alice@im.wechat", "label": "Alice"}]


@pytest.mark.asyncio
async def test_wechat_login_start_offline_returns_409(client, seed, monkeypatch, caplog):
    _patch_daemon(monkeypatch, online=False)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    with caplog.at_level("INFO", logger="app.routers.gateways"):
        r = await client.post(
            "/api/agents/ag_daemon/gateways/wechat/login/start",
            headers=headers,
            json={},
        )
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"

    # Phase 0: offline rejects before reaching the daemon path, so no setup
    # event log is expected (the require_online guard short-circuits earlier).
    # We still assert the harness did not crash trying to emit a log.
    setup_records = [
        rec for rec in caplog.records
        if rec.getMessage() == "cloud-gateway setup event"
    ]
    # No started event because _ensure_gateway_host_online raises before logging.
    assert setup_records == []


# ---------------------------------------------------------------------------
# C1 — camelCase contract compatibility (frontend dashboard shape)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_accepts_nested_secret_botToken_camelCase(
    client, seed, db_session, monkeypatch
):
    """Dashboard posts ``secret: {botToken}`` + ``loginId`` / ``baseUrl`` —
    the BFF must accept that shape, not just snake_case."""
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "telegram",
                "accountId": params["accountId"],
                "enabled": True,
                "tokenPreview": "1234...wxyz",
                "status": {"running": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "secret": {"botToken": "1234:abcd"},
            "config": {"allowedChatIds": ["111"], "allowedSenderIds": ["111"]},
        },
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["secret"] == {"botToken": "1234:abcd"}


@pytest.mark.asyncio
async def test_create_wechat_accepts_loginId_camelCase(client, seed, monkeypatch):
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "wechat",
                "accountId": params["accountId"],
                "enabled": True,
                "tokenPreview": "wxab...mnop",
                "status": {"running": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "wechat",
            "loginId": "wxl_camel",
            "config": {"allowedSenderIds": ["xxx@im.wechat"]},
        },
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["loginId"] == "wxl_camel"


@pytest.mark.asyncio
async def test_patch_accepts_nested_secret_camelCase(
    client, seed, db_session, monkeypatch
):
    gw_id = await _seed_one_connection(db_session, seed)

    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {"ok": True, "result": {"status": {"running": True}}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        f"/api/agents/ag_daemon/gateways/{gw_id}",
        headers=headers,
        json={"secret": {"botToken": "rotated:new"}},
    )
    assert r.status_code == 200, r.text
    assert captured["params"].get("secret") == {"botToken": "rotated:new"}


@pytest.mark.asyncio
async def test_wechat_login_status_accepts_camelCase_loginId(client, seed, monkeypatch):
    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        assert params == {"provider": "wechat", "loginId": "wxl_camel", "accountId": "ag_daemon"}
        return {"ok": True, "result": {"status": "pending"}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/login/status",
        headers=headers,
        json={"loginId": "wxl_camel"},  # camelCase, not login_id
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_wechat_login_start_accepts_camelCase_baseUrl(client, seed, monkeypatch):
    captured: dict = {}

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        captured["params"] = params
        return {
            "ok": True,
            "result": {
                "loginId": "wxl_x",
                "qrcode": "QR",
                "expiresAt": 0,
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/login/start",
        headers=headers,
        json={"baseUrl": "https://botcord-test.local", "gatewayId": "gw_x"},
    )
    assert r.status_code == 200, r.text
    assert captured["params"]["baseUrl"] == "https://botcord-test.local"
    assert captured["params"]["gatewayId"] == "gw_x"


# ---------------------------------------------------------------------------
# W4 — caller-supplied tokenPreview in config is dropped
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_drops_caller_supplied_tokenPreview_in_config(
    client, seed, monkeypatch
):
    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        # Daemon DOES NOT echo a tokenPreview here.
        return {
            "ok": True,
            "result": {
                "id": params["id"],
                "type": "telegram",
                "accountId": params["accountId"],
                "enabled": True,
                "status": {"running": True},
            },
        }

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "1234:abcd",
            "config": {
                "allowedChatIds": ["111"],
                "allowedSenderIds": ["111"],
                "tokenPreview": "ATTACKER...EVIL",
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Caller-supplied preview must be dropped; daemon returned none.
    assert "tokenPreview" not in body["config"]


@pytest.mark.asyncio
async def test_patch_preserves_existing_tokenPreview_when_daemon_returns_none(
    client, seed, db_session, monkeypatch
):
    """W4: a PATCH whose daemon ack lacks tokenPreview must keep the stored one."""
    gw_id = await _seed_one_connection(db_session, seed)

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        return {"ok": True, "result": {"status": {"running": True}}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        f"/api/agents/ag_daemon/gateways/{gw_id}",
        headers=headers,
        # Caller tries to overwrite tokenPreview via config — should be dropped.
        json={"config": {"tokenPreview": "INJECTED"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Stored preview survives; injected one is ignored.
    assert body["config"].get("tokenPreview") == "1234...wxyz"


@pytest.mark.asyncio
async def test_patch_rejects_empty_whitelist(client, seed, db_session, monkeypatch):
    gw_id = await _seed_one_connection(db_session, seed)

    async def fake_send(*a, **kw):
        raise AssertionError("daemon contacted before whitelist validation")

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        f"/api/agents/ag_daemon/gateways/{gw_id}",
        headers=headers,
        json={"config": {"allowedSenderIds": [], "allowedChatIds": []}},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "missing_gateway_whitelist"


# ---------------------------------------------------------------------------
# W9 — daemon_control timeout maps to 504
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_control_frame_raises_504_on_ack_timeout(monkeypatch):
    """When the daemon never acks within timeout_ms, send_control_frame must
    raise an HTTP 504 (so the BFF surfaces the right code to the dashboard)."""
    import asyncio
    from hub.routers import daemon_control as dc

    class _FakeWS:
        async def send_text(self, _payload: str) -> None:
            return None

    class _FakeConn:
        def __init__(self) -> None:
            self.ws = _FakeWS()
            self.pending_acks: dict[str, asyncio.Future] = {}

    fake_conn = _FakeConn()

    class _FakeRegistry:
        def get(self, _instance_id):
            return fake_conn

        def is_online(self, _instance_id):
            return True

    monkeypatch.setattr(dc, "_REGISTRY", _FakeRegistry())

    with pytest.raises(HTTPException) as ei:
        await dc.send_control_frame("dm_x", "list_runtimes", {}, timeout_ms=100)
    assert ei.value.status_code == 504
    assert ei.value.detail == "daemon_ack_timeout"


# ---------------------------------------------------------------------------
# W1 — SSRF guard rejects baseUrl pointing at private/loopback IPs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://api.telegram.org",         # not https
        "https://localhost",
        "https://127.0.0.1",
        "https://169.254.169.254",         # AWS metadata
        "https://10.0.0.5",
        "https://192.168.1.1",
        "https://172.16.5.5",
        # W9: allowlist — hostname-based SSRF vectors
        "https://metadata.google.internal",
        "https://metadata",
        "https://evil.internal",
        "https://my-service.svc.cluster.local",
    ],
)
@pytest.mark.asyncio
async def test_create_rejects_unsafe_base_url(client, seed, monkeypatch, bad_url):
    async def fake_send(*a, **k):  # should never be called — guard runs first
        raise AssertionError("daemon contacted before SSRF guard")

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "bot_token": "1234:abcd",
            "config": {"baseUrl": bad_url},
        },
    )
    assert r.status_code == 400, r.text


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://api.telegram.org",
        "https://localhost",
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://10.0.0.5",
        # W9: allowlist — hostname-based SSRF vectors must be rejected
        "https://metadata.google.internal",
        "https://metadata",
        "https://evil.internal",
        "https://my-service.svc.cluster.local",
    ],
)
@pytest.mark.asyncio
async def test_wechat_login_start_rejects_unsafe_base_url(client, seed, monkeypatch, bad_url):
    async def fake_send(*a, **k):
        raise AssertionError("daemon contacted before SSRF guard")

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/login/start",
        headers=headers,
        json={"baseUrl": bad_url},
    )
    assert r.status_code == 400, r.text


# ---------------------------------------------------------------------------
# W1/W2: rate limiting on create_gateway and test_gateway
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_gateway_rate_limited_after_burst(client, seed, monkeypatch):
    """11th rapid POST to create_gateway hits 429 (burst=10)."""
    import app.routers.gateways as gw

    # Reset the rate bucket so we start with a clean slate for this user/action.
    gw._RATE_BUCKETS.clear()

    async def fake_send(*a, **k):
        return {"ok": True, "result": {"tokenPreview": "abcd...wxyz", "status": {"running": True}}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}

    status_codes = []
    for i in range(11):
        r = await client.post(
            "/api/agents/ag_daemon/gateways",
            headers=headers,
            json={
                "provider": "telegram",
                "bot_token": f"111:tok{i}",
                "config": {
                    "allowedChatIds": ["111"],
                    "allowedSenderIds": ["111"],
                },
            },
        )
        status_codes.append(r.status_code)

    assert status_codes[-1] == 429, f"expected last to be 429, got {status_codes}"
    assert status_codes[0] != 429, "first request should not be rate limited"


@pytest.mark.asyncio
async def test_test_gateway_rate_limited_after_burst(client, seed, db_session, monkeypatch):
    """6th rapid POST to test_gateway hits 429 (burst=5)."""
    import app.routers.gateways as gw

    gw._RATE_BUCKETS.clear()

    gw_id = await _seed_one_connection(db_session, seed)

    async def fake_send(*a, **k):
        return {"ok": True, "result": {"ok": True}}

    _patch_daemon(monkeypatch, online=True, send=fake_send)
    headers = {"Authorization": f"Bearer {seed['token']}"}

    status_codes = []
    for _ in range(6):
        r = await client.post(
            f"/api/agents/ag_daemon/gateways/{gw_id}/test",
            headers=headers,
        )
        status_codes.append(r.status_code)

    assert status_codes[-1] == 429, f"expected last to be 429, got {status_codes}"
    assert status_codes[0] != 429, "first request should not be rate limited"


# Phase 4 — Hub mirror sync of ingress ``warning.message`` into ``last_error``,
# and proactive clear when ingress reports no warning.


@pytest.mark.asyncio
async def test_create_cloud_gateway_writes_ingress_warning_to_last_error(
    client, seed, db_session, monkeypatch
):
    """When ingress returns ``{warning: {message}}``, Hub mirror persists it."""
    import app.routers.gateways as gw

    gw._RATE_BUCKETS.clear()

    def responder(method, url, body):
        if "/gateways/telegram/login/start" in url:
            return _FakeIngressResponse(
                200,
                {
                    "ok": True,
                    "loginId": "tgl_warn1",
                    "expiresAt": 1700000000,
                    "publicPayload": {"tokenPreview": "1234...wxyz"},
                },
            )
        return _FakeIngressResponse(
            200,
            {
                "ok": True,
                "connection": {
                    "id": "gw_telegram_warning1",
                    "provider": "telegram",
                    "agent_id": "ag_cloud",
                    "user_id": str(seed["user_id"]),
                    "label": "cloud tg",
                    "status": "error",
                    "enabled": True,
                    "config_json": {
                        "allowedChatIds": ["111"],
                        "allowedSenderIds": ["111"],
                    },
                },
                "warning": {
                    "code": "adapter_start_failed",
                    "message": "telegram getUpdates returned non-ok",
                },
            },
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "label": "cloud tg",
            "bot_token": "1234:abcd",
            "config": {
                "allowedChatIds": ["111"],
                "allowedSenderIds": ["111"],
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_error"] == "telegram getUpdates returned non-ok"

    row = await db_session.scalar(
        select(AgentGatewayConnection).where(
            AgentGatewayConnection.id == "gw_telegram_warning1"
        )
    )
    assert row is not None
    assert row.last_error == "telegram getUpdates returned non-ok"


@pytest.mark.asyncio
async def test_create_cloud_gateway_redacts_token_in_warning_message(
    client, seed, db_session, monkeypatch
):
    """Defensive redact: a leaked-style token in warning.message is scrubbed
    before being written to mirror.last_error."""
    import app.routers.gateways as gw

    gw._RATE_BUCKETS.clear()

    leaked = "1234567890:AAEhBP0av5cYbnP9aFv7nPaUkUTabcdefghij"

    def responder(method, url, body):
        if "/gateways/telegram/login/start" in url:
            return _FakeIngressResponse(
                200,
                {
                    "ok": True,
                    "loginId": "tgl_warn2",
                    "expiresAt": 1700000000,
                    "publicPayload": {"tokenPreview": "1234...wxyz"},
                },
            )
        return _FakeIngressResponse(
            200,
            {
                "ok": True,
                "connection": {
                    "id": "gw_telegram_warning2",
                    "provider": "telegram",
                    "agent_id": "ag_cloud",
                    "user_id": str(seed["user_id"]),
                    "label": "cloud tg",
                    "status": "error",
                    "enabled": True,
                    "config_json": {
                        "allowedChatIds": ["111"],
                        "allowedSenderIds": ["111"],
                    },
                },
                "warning": {
                    "code": "adapter_start_failed",
                    "message": f"telegram start failed with token {leaked}",
                },
            },
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_cloud/gateways",
        headers=headers,
        json={
            "provider": "telegram",
            "label": "cloud tg",
            "bot_token": "1234:abcd",
            "config": {
                "allowedChatIds": ["111"],
                "allowedSenderIds": ["111"],
            },
        },
    )
    assert r.status_code == 200, r.text
    row = await db_session.scalar(
        select(AgentGatewayConnection).where(
            AgentGatewayConnection.id == "gw_telegram_warning2"
        )
    )
    assert row is not None
    assert leaked not in (row.last_error or "")
    assert "[REDACTED]" in (row.last_error or "")


@pytest.mark.asyncio
async def test_patch_cloud_gateway_clears_last_error_when_no_warning(
    client, seed, db_session, monkeypatch
):
    """A successful patch with no ingress warning clears any stale last_error."""
    import app.routers.gateways as gw

    gw._RATE_BUCKETS.clear()

    # Seed an existing cloud mirror row with a stale last_error.
    pre = AgentGatewayConnection(
        id="gw_telegram_clear1",
        user_id=seed["user_id"],
        agent_id="ag_cloud",
        daemon_instance_id=seed["cloud_daemon_row_id"],
        provider="telegram",
        label="cloud tg",
        enabled=True,
        status="error",
        config_json={
            "allowedChatIds": ["111"],
            "allowedSenderIds": ["111"],
        },
        last_error="old failure",
    )
    db_session.add(pre)
    await db_session.commit()

    def responder(method, url, body):
        return _FakeIngressResponse(
            200,
            {
                "ok": True,
                "connection": {
                    "id": "gw_telegram_clear1",
                    "provider": "telegram",
                    "agent_id": "ag_cloud",
                    "user_id": str(seed["user_id"]),
                    "label": "cloud tg",
                    "status": "active",
                    "enabled": True,
                    "config_json": {
                        "allowedChatIds": ["222"],
                        "allowedSenderIds": ["222"],
                    },
                },
            },
        )

    _install_ingress(monkeypatch, responder)
    _patch_daemon(monkeypatch, online=False)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        "/api/agents/ag_cloud/gateways/gw_telegram_clear1",
        headers=headers,
        json={"config": {
            "allowedChatIds": ["222"],
            "allowedSenderIds": ["222"],
        }},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_error"] is None

    await db_session.refresh(pre)
    assert pre.last_error is None
    assert pre.status == "active"

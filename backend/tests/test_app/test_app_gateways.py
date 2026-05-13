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

from hub.enums import MessagePolicy
from hub.models import (
    Agent,
    AgentGatewayConnection,
    Base,
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

    Also seeds a non-daemon-hosted plugin agent owned by the same user so we
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
    db_session.add(daemon)

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
    plugin_agent = Agent(
        agent_id="ag_plugin",
        display_name="Plugin Agent",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        claimed_at=now,
        hosting_kind="plugin",
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
    db_session.add_all([daemon_agent, plugin_agent, other_agent])
    await db_session.commit()
    return {
        "token": _token(str(supabase_uuid)),
        "user_id": user_id,
        "daemon_id": "dm_abcdef123456",
    }


def _patch_daemon(monkeypatch, *, online: bool, send=None):
    """Stub the gateways router's daemon hooks."""
    import app.routers.gateways as gw

    monkeypatch.setattr(gw, "is_daemon_online", lambda _id: online)
    if send is not None:
        monkeypatch.setattr(gw, "send_control_frame", send)


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
        "/api/agents/ag_plugin/gateways",
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
    client, seed, db_session, monkeypatch
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
async def test_wechat_login_start_offline_returns_409(client, seed, monkeypatch):
    _patch_daemon(monkeypatch, online=False)
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_daemon/gateways/wechat/login/start",
        headers=headers,
        json={},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"


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

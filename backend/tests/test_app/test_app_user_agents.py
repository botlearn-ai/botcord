"""Tests for /api/users/me/agents/* endpoints (Phase 2)."""

import base64
import datetime
import hashlib
import hmac
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from nacl.signing import SigningKey as NaClSigningKey
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from unittest.mock import AsyncMock, patch

from hub.enums import (
    BillingInterval,
    ParticipantType,
    SubscriptionProductStatus,
    SubscriptionStatus,
    TxStatus,
    TxType,
)
from hub.models import (
    Agent,
    AgentSubscription,
    Base,
    DaemonAgentCleanup,
    KeyState,
    MessagePolicy,
    Role,
    SigningKey,
    SubscriptionProduct,
    User,
    UserRole,
    WalletAccount,
    WalletTransaction,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


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
async def db_engine():
    """Create a shared in-memory SQLite engine using StaticPool.

    StaticPool reuses the same connection for all sessions, so both the
    test session and the independent jti session see the same tables.
    """
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
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, db_engine, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db
    import app.routers.users as users_mod

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    # Point the jti session factory at the same in-memory SQLite engine
    jti_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    monkeypatch.setattr(users_mod, "_jti_session_factory", jti_factory)
    monkeypatch.setattr(users_mod, "_short_code_session_factory", jti_factory)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession):
    """Create a test user with two agents (first is default)."""
    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Test User",
        email="test@example.com",
        avatar_url=None,
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

    agent_owner_role = Role(
        id=uuid.uuid4(),
        name="agent_owner",
        display_name="Agent Owner",
        is_system=True,
        priority=0,
    )
    db_session.add(agent_owner_role)
    await db_session.flush()

    user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id)
    db_session.add(user_role)
    owner_user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=agent_owner_role.id)
    db_session.add(owner_user_role)

    now = datetime.datetime.now(datetime.timezone.utc)

    agent1 = Agent(
        agent_id="ag_agent001",
        display_name="Agent One",
        bio="First agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=now,
        created_at=now,
    )
    agent2 = Agent(
        agent_id="ag_agent002",
        display_name="Agent Two",
        bio="Second agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=False,
        claimed_at=now,
        created_at=now + datetime.timedelta(seconds=1),
    )
    db_session.add(agent1)
    db_session.add(agent2)
    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "token": _make_supabase_token(supabase_uid),
        "agent1": agent1,
        "agent2": agent2,
        "agent_owner_role": agent_owner_role,
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/agents
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_my_agents_hides_deleted_by_default_and_can_include_them(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    deleted_at = datetime.datetime.now(datetime.timezone.utc)
    seed_user["agent2"].status = "deleted"
    seed_user["agent2"].deleted_at = deleted_at
    await db_session.commit()

    default_resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert default_resp.status_code == 200
    default_agents = default_resp.json()["agents"]
    assert [agent["agent_id"] for agent in default_agents] == ["ag_agent001"]

    include_resp = await client.get(
        "/api/users/me/agents?include_deleted=true",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert include_resp.status_code == 200
    agents_by_id = {
        agent["agent_id"]: agent
        for agent in include_resp.json()["agents"]
    }
    assert set(agents_by_id) == {"ag_agent001", "ag_agent002"}
    assert agents_by_id["ag_agent002"]["status"] == "deleted"
    assert agents_by_id["ag_agent002"]["deleted_at"] == deleted_at.isoformat()


# ---------------------------------------------------------------------------
# DELETE /api/users/me/agents/{agent_id}/binding
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unbind_agent_binding(client: AsyncClient, db_session: AsyncSession, seed_user: dict):
    """Unbinding the default agent promotes the next one."""
    token = seed_user["token"]
    original_claim_code = seed_user["agent1"].claim_code

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == "ag_agent001"
    assert body["unbound_at"]

    # Verify agent2 became default
    agents_resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    agents = agents_resp.json()["agents"]
    assert len(agents) == 1
    assert agents[0]["agent_id"] == "ag_agent002"
    assert agents[0]["is_default"] is True
    assert agents[0]["status"] == "active"

    agent_result = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_agent001"))
    agent = agent_result.scalar_one()
    assert agent.user_id is None
    assert agent.claimed_at is None
    assert agent.is_default is False
    assert agent.agent_token is None
    assert agent.token_expires_at is None
    assert agent.claim_code is not None
    assert agent.claim_code != original_claim_code

    role_result = await db_session.execute(
        select(UserRole)
        .where(
            UserRole.user_id == seed_user["user_id"],
            UserRole.role_id == seed_user["agent_owner_role"].id,
        )
    )
    assert role_result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_unbind_agent_revokes_bound_daemon_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    db_engine,
    seed_user: dict,
    monkeypatch,
):
    """Unbinding a daemon-managed agent asks the daemon to remove local state."""
    seed_user["agent1"].daemon_instance_id = "di_test"
    await db_session.commit()

    import asyncio as _asyncio
    import app.routers.users as users_mod
    import hub.routers.daemon_control as daemon_mod

    cleanup_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    monkeypatch.setattr(daemon_mod, "async_session", cleanup_factory)

    monkeypatch.setattr(users_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(daemon_mod, "is_daemon_online", lambda _id: True)

    captured: dict = {}
    sent = _asyncio.Event()

    async def fake_send(daemon_id, type_, params, timeout_ms=None):
        captured["daemon_id"] = daemon_id
        captured["type"] = type_
        captured["params"] = params
        sent.set()
        return {"id": "x", "ok": True}

    monkeypatch.setattr(daemon_mod, "send_control_frame", fake_send)

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == "ag_agent001"
    assert body["daemon_instance_id"] == "di_test"
    assert body["daemon_cleanup_queued"] is True
    await _asyncio.wait_for(sent.wait(), timeout=2.0)
    assert captured["daemon_id"] == "di_test"
    assert captured["type"] == "revoke_agent"
    assert captured["params"] == {
        "agentId": "ag_agent001",
        "deleteCredentials": True,
        "deleteState": True,
        "deleteWorkspace": False,
    }

    agent = (
        await db_session.execute(select(Agent).where(Agent.agent_id == "ag_agent001"))
    ).scalar_one()
    assert agent.user_id is None
    assert agent.daemon_instance_id is None

    cleanup = (
        await db_session.execute(
            select(DaemonAgentCleanup).where(
                DaemonAgentCleanup.daemon_instance_id == "di_test",
                DaemonAgentCleanup.agent_id == "ag_agent001",
            )
        )
    ).scalar_one()
    assert cleanup.status == "succeeded"
    assert cleanup.attempts == 1


@pytest.mark.asyncio
async def test_unbind_agent_skips_revoke_when_daemon_offline(
    client: AsyncClient,
    db_session: AsyncSession,
    db_engine,
    seed_user: dict,
    monkeypatch,
):
    seed_user["agent1"].daemon_instance_id = "di_offline"
    await db_session.commit()

    import asyncio as _asyncio
    import app.routers.users as users_mod
    import hub.routers.daemon_control as daemon_mod

    monkeypatch.setattr(users_mod, "is_daemon_online", lambda _id: False)

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["daemon_instance_id"] == "di_offline"
    assert body["daemon_cleanup_queued"] is True

    cleanup = (
        await db_session.execute(
            select(DaemonAgentCleanup).where(
                DaemonAgentCleanup.daemon_instance_id == "di_offline",
                DaemonAgentCleanup.agent_id == "ag_agent001",
            )
        )
    ).scalar_one()
    assert cleanup.status == "pending"
    assert cleanup.attempts == 0

    cleanup_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    monkeypatch.setattr(daemon_mod, "async_session", cleanup_factory)
    sent = _asyncio.Event()

    async def fake_send(daemon_id, type_, params, timeout_ms=None):
        assert daemon_id == "di_offline"
        assert type_ == "revoke_agent"
        assert params["agentId"] == "ag_agent001"
        sent.set()
        return {"id": "x", "ok": True}

    monkeypatch.setattr(daemon_mod, "send_control_frame", fake_send)
    await daemon_mod.process_pending_daemon_cleanups("di_offline")
    await _asyncio.wait_for(sent.wait(), timeout=2.0)

    await db_session.refresh(cleanup)
    assert cleanup.status == "succeeded"
    assert cleanup.attempts == 1


@pytest.mark.asyncio
async def test_pending_daemon_cleanup_cancelled_after_rebind(
    db_session: AsyncSession, db_engine, seed_user: dict, monkeypatch
):
    cleanup = DaemonAgentCleanup(
        daemon_instance_id="di_old",
        agent_id="ag_agent001",
    )
    db_session.add(cleanup)
    await db_session.commit()

    import hub.routers.daemon_control as daemon_mod
    from fastapi import HTTPException

    cleanup_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    monkeypatch.setattr(daemon_mod, "async_session", cleanup_factory)

    async def boom(*_a, **_kw):  # pragma: no cover - should never run
        raise HTTPException(500, detail="late cleanup should be cancelled")

    monkeypatch.setattr(daemon_mod, "send_control_frame", boom)
    await daemon_mod.process_pending_daemon_cleanups("di_old")

    await db_session.refresh(cleanup)
    assert cleanup.status == "cancelled"
    assert cleanup.last_error == "agent rebound before cleanup"


@pytest.mark.asyncio
async def test_legacy_delete_route_is_deprecated_unbind(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    resp = await client.delete(
        "/api/users/me/agents/ag_agent002",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.headers["deprecation"] == "true"
    body = resp.json()
    assert body["deprecated"] is True
    assert body["ok"] is True
    assert body["agent_id"] == "ag_agent002"
    assert body["unbound_at"]


@pytest.mark.asyncio
async def test_unbind_agent_not_found(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    resp = await client.delete(
        "/api/users/me/agents/ag_nonexistent/binding",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_unbind_agent_second_time_404(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    first = await client.delete(
        "/api/users/me/agents/ag_agent002/binding",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200

    second = await client.delete(
        "/api/users/me/agents/ag_agent002/binding",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 404


@pytest.mark.asyncio
async def test_unbind_agent_cross_user_404(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    other_supabase_uuid = uuid.uuid4()
    other_user_id = uuid.uuid4()
    db_session.add(
        User(
            id=other_user_id,
            display_name="Other User",
            status="active",
            supabase_user_id=other_supabase_uuid,
            max_agents=10,
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {_make_supabase_token(str(other_supabase_uuid))}"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_unbind_last_agent_removes_agent_owner_role(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    seed_user["agent2"].user_id = None
    seed_user["agent2"].claimed_at = None
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200

    role_result = await db_session.execute(
        select(UserRole)
        .where(
            UserRole.user_id == seed_user["user_id"],
            UserRole.role_id == seed_user["agent_owner_role"].id,
        )
    )
    assert role_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_unbind_agent_rejects_non_empty_wallet(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    db_session.add(
        WalletAccount(
            owner_id="ag_agent001",
            asset_code="COIN",
            available_balance_minor=1,
            locked_balance_minor=0,
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "wallet_not_empty"


@pytest.mark.asyncio
async def test_unbind_agent_rejects_product_with_active_subscribers(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    now = datetime.datetime.now(datetime.timezone.utc)
    db_session.add(
        SubscriptionProduct(
            product_id="sp_test001",
            owner_id="ag_agent001",
            owner_type=ParticipantType.agent,
            provider_agent_id="ag_agent001",
            name="Paid Room",
            amount_minor=100,
            billing_interval=BillingInterval.month,
            status=SubscriptionProductStatus.active,
        )
    )
    db_session.add(
        AgentSubscription(
            subscription_id="sub_test001",
            product_id="sp_test001",
            subscriber_agent_id="ag_agent002",
            provider_agent_id="ag_agent001",
            amount_minor=100,
            billing_interval=BillingInterval.month,
            status=SubscriptionStatus.active,
            current_period_start=now,
            current_period_end=now + datetime.timedelta(days=30),
            next_charge_at=now + datetime.timedelta(days=30),
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "product_has_subscribers"


@pytest.mark.asyncio
async def test_unbind_agent_cancels_subscriber_subscriptions(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    now = datetime.datetime.now(datetime.timezone.utc)
    db_session.add(
        Agent(
            agent_id="ag_provider",
            display_name="Provider",
            message_policy=MessagePolicy.contacts_only,
            is_default=False,
            claimed_at=now,
        )
    )
    db_session.add(
        SubscriptionProduct(
            product_id="sp_provider",
            owner_id="ag_provider",
            owner_type=ParticipantType.agent,
            provider_agent_id="ag_provider",
            name="Provider Plan",
            amount_minor=100,
            billing_interval=BillingInterval.month,
            status=SubscriptionProductStatus.active,
        )
    )
    db_session.add(
        AgentSubscription(
            subscription_id="sub_agent001",
            product_id="sp_provider",
            subscriber_agent_id="ag_agent001",
            provider_agent_id="ag_provider",
            amount_minor=100,
            billing_interval=BillingInterval.month,
            status=SubscriptionStatus.active,
            current_period_start=now,
            current_period_end=now + datetime.timedelta(days=30),
            next_charge_at=now + datetime.timedelta(days=30),
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200

    sub_result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == "sub_agent001")
    )
    subscription = sub_result.scalar_one()
    assert subscription.status == SubscriptionStatus.cancelled
    assert subscription.cancelled_at is not None


@pytest.mark.asyncio
async def test_unbind_agent_rejects_pending_payment(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    db_session.add(
        WalletTransaction(
            tx_id="tx_pending001",
            type=TxType.transfer,
            status=TxStatus.pending,
            asset_code="COIN",
            amount_minor=10,
            fee_minor=0,
            from_owner_id="ag_agent001",
            to_owner_id="ag_agent002",
            initiator_owner_id="ag_agent001",
            idempotency_key="pending-unbind-test",
        )
    )
    await db_session.commit()

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001/binding",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "pending_obligations"


# ---------------------------------------------------------------------------
# PATCH /api/users/me/agents/{agent_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_agent_set_default(client: AsyncClient, seed_user: dict):
    """Setting agent2 as default should unset agent1."""
    token = seed_user["token"]

    resp = await client.patch(
        "/api/users/me/agents/ag_agent002",
        json={"is_default": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "ag_agent002"
    assert data["is_default"] is True

    # Verify agent1 is no longer default
    agents_resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    agents = {a["agent_id"]: a for a in agents_resp.json()["agents"]}
    assert agents["ag_agent001"]["is_default"] is False
    assert agents["ag_agent002"]["is_default"] is True


@pytest.mark.asyncio
async def test_patch_agent_pushes_update_when_daemon_online(
    client: AsyncClient, db_session: AsyncSession, seed_user: dict, monkeypatch
):
    """When the agent is bound to a connected daemon, PATCH dispatches an
    `update_agent` control frame so identity.md is rewritten without waiting
    for the next reconnect."""
    # Wire the agent to a (fake) daemon instance and pretend it's online.
    seed_user["agent1"].daemon_instance_id = "di_test"
    await db_session.commit()

    import app.routers.users as users_mod

    monkeypatch.setattr(users_mod, "is_daemon_online", lambda _id: True)
    import asyncio as _asyncio

    captured: dict = {}
    sent = _asyncio.Event()

    async def fake_send(daemon_id, type_, params, timeout_ms=None):
        captured["daemon_id"] = daemon_id
        captured["type"] = type_
        captured["params"] = params
        sent.set()
        return {"id": "x", "ok": True}

    monkeypatch.setattr(users_mod, "send_control_frame", fake_send)

    resp = await client.patch(
        "/api/users/me/agents/ag_agent001",
        json={"display_name": "Renamed", "bio": "Fresh bio"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200, resp.text
    # Push is fire-and-forget — wait for the background task to land.
    await _asyncio.wait_for(sent.wait(), timeout=2.0)
    assert captured["daemon_id"] == "di_test"
    assert captured["type"] == "update_agent"
    assert captured["params"]["agentId"] == "ag_agent001"
    assert captured["params"]["displayName"] == "Renamed"
    assert captured["params"]["bio"] == "Fresh bio"


@pytest.mark.asyncio
async def test_patch_agent_swallows_push_error_when_online(
    client: AsyncClient, db_session: AsyncSession, seed_user: dict, monkeypatch
):
    """Even if the daemon is online but the dispatch raises (timeout, 502),
    the PATCH must still succeed — eventual consistency via hello snapshot."""
    seed_user["agent1"].daemon_instance_id = "di_flaky"
    await db_session.commit()

    import app.routers.users as users_mod
    from fastapi import HTTPException

    monkeypatch.setattr(users_mod, "is_daemon_online", lambda _id: True)

    async def boom(*_a, **_kw):
        raise HTTPException(504, detail="daemon_ack_timeout")

    monkeypatch.setattr(users_mod, "send_control_frame", boom)

    resp = await client.patch(
        "/api/users/me/agents/ag_agent001",
        json={"bio": "Anything"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_patch_agent_swallows_offline_daemon(
    client: AsyncClient, db_session: AsyncSession, seed_user: dict, monkeypatch
):
    """Offline daemon must not break the PATCH — eventual consistency is via
    the next hello snapshot."""
    seed_user["agent1"].daemon_instance_id = "di_offline"
    await db_session.commit()

    import app.routers.users as users_mod
    from fastapi import HTTPException

    monkeypatch.setattr(users_mod, "is_daemon_online", lambda _id: False)

    async def boom(*_a, **_kw):  # pragma: no cover - should never run
        raise HTTPException(409, detail="daemon_offline")

    monkeypatch.setattr(users_mod, "send_control_frame", boom)

    resp = await client.patch(
        "/api/users/me/agents/ag_agent001",
        json={"display_name": "Whatever"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind-ticket
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bind_ticket_returns_valid_ticket(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]

    resp = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert "bind_ticket" in data
    assert data["bind_code"].startswith("bd_")
    assert "nonce" in data
    assert "expires_at" in data
    assert isinstance(data["expires_at"], int)

    # Verify ticket structure: base64_payload.base64_signature
    parts = data["bind_ticket"].split(".")
    assert len(parts) == 2

    # Decode and verify payload
    payload_json = base64.urlsafe_b64decode(parts[0]).decode()
    payload = json.loads(payload_json)
    assert payload["uid"] == str(seed_user["user_id"])
    assert payload["nonce"] == data["nonce"]
    assert payload["exp"] == data["expires_at"]
    assert "iat" in payload
    assert "jti" in payload


@pytest.mark.asyncio
async def test_credential_reset_ticket_returns_valid_ticket(
    client: AsyncClient, seed_user: dict
):
    token = seed_user["token"]

    resp = await client.post(
        "/api/users/me/agents/ag_agent001/credential-reset-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["agent_id"] == "ag_agent001"
    assert data["reset_code"].startswith("rc_")
    assert isinstance(data["expires_at"], int)

    payload_json = base64.urlsafe_b64decode(data["reset_ticket"].split(".")[0]).decode()
    payload = json.loads(payload_json)
    assert payload["uid"] == str(seed_user["user_id"])
    assert payload["agent_id"] == "ag_agent001"
    assert payload["purpose"] == "credential_reset"
    assert payload["exp"] == data["expires_at"]
    assert "jti" in payload


@pytest.mark.asyncio
async def test_agent_bind_success_with_bind_code(
    client: AsyncClient, seed_user_for_claim: dict
):
    token = seed_user_for_claim["token"]
    issue = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert issue.status_code == 200
    bind_code = issue.json()["bind_code"]

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindcode001",
                "display_name": "Bound By Code",
                "agent_token": "tok_valid",
                "bind_code": bind_code,
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == "ag_bindcode001"
    assert data["display_name"] == "Bound By Code"


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/claim/resolve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_resolve_success(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Claiming an unclaimed agent binds it to the user."""
    token = seed_user["token"]

    # Create a new unclaimed agent
    unclaimed = Agent(
        agent_id="ag_unclaimed01",
        display_name="Unclaimed Agent",
        bio="Waiting to be claimed",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_testcode123",
    )
    db_session.add(unclaimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_testcode123"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == "ag_unclaimed01"
    assert data["display_name"] == "Unclaimed Agent"
    # User already has agents, so this should not be default
    assert data["is_default"] is False
    assert data["claimed_at"] is not None

    grant_result = await db_session.execute(
        select(WalletTransaction).where(
            WalletTransaction.to_owner_id == "ag_unclaimed01",
            WalletTransaction.type == TxType.grant,
        )
    )
    grant_tx = grant_result.scalar_one()
    assert grant_tx.amount_minor == 10000


@pytest.mark.asyncio
async def test_claim_resolve_already_claimed(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Cannot claim an agent that is already bound to a user."""
    token = seed_user["token"]

    claimed = Agent(
        agent_id="ag_claimed01",
        display_name="Claimed Agent",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_alreadyclaimed",
        user_id=uuid.uuid4(),  # already has an owner
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(claimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_alreadyclaimed"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409
    assert "already claimed" in resp.json()["error"].lower()


@pytest.mark.asyncio
async def test_claim_resolve_quota_exceeded(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Exceeding max_agents quota returns 400."""
    token = seed_user["token"]

    # Set max_agents to 2 (user already has 2 agents)
    user = seed_user["user"]
    user.max_agents = 2
    db_session.add(user)
    await db_session.flush()

    unclaimed = Agent(
        agent_id="ag_quota01",
        display_name="Quota Agent",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_quotatest",
    )
    db_session.add(unclaimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_quotatest"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "quota" in resp.json()["error"].lower()


# ---------------------------------------------------------------------------
# Helpers for bind ticket creation
# ---------------------------------------------------------------------------

TEST_JWT_SECRET = "change-me-in-production"


def _make_bind_ticket(
    user_id: str, secret: str = TEST_JWT_SECRET, ttl: int = 300
) -> str:
    """Create a valid bind ticket HMAC-signed with the given secret."""
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now + datetime.timedelta(seconds=ttl)
    payload = {
        "uid": user_id,
        "nonce": uuid.uuid4().hex,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).decode()
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode()
    return f"{payload_b64}.{sig_b64}"


def _mock_verify_agent_control(return_value: bool = True):
    """Patch _verify_agent_control to return a fixed bool."""
    return patch(
        "app.routers.users._verify_agent_control", return_value=return_value
    )


# ---------------------------------------------------------------------------
# Fixture: seed_user_for_claim — user with no agents yet, with bind secret patched
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def seed_user_for_claim(db_session: AsyncSession, monkeypatch):
    """Create a user with no agents for testing claim/bind flows."""
    import app.routers.users as users_mod
    import hub.config

    monkeypatch.setattr(users_mod, "BIND_PROOF_SECRET", None)
    monkeypatch.setattr(users_mod, "JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(hub.config, "BIND_PROOF_SECRET", None)
    monkeypatch.setattr(hub.config, "JWT_SECRET", TEST_JWT_SECRET)

    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Claim User",
        email="claim@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=3,
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

    user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id)
    db_session.add(user_role)
    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "token": _make_supabase_token(supabase_uid),
    }


# ---------------------------------------------------------------------------
# POST /api/users/me/agents — claim via agent_token
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_agent_with_token_success(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Successful claim with agent_token (mock verify returns True)."""
    token = seed_user_for_claim["token"]

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents",
            json={
                "agent_id": "ag_newagent0001",
                "display_name": "New Agent",
                "agent_token": "tok_valid",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == "ag_newagent0001"
    assert data["display_name"] == "New Agent"
    assert data["is_default"] is True  # first agent for this user
    assert data["claimed_at"] is not None

    wallet_resp = await client.get(
        "/api/wallet/summary",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Active-Agent": "ag_newagent0001",
        },
    )
    assert wallet_resp.status_code == 200
    assert wallet_resp.json()["available_balance_minor"] == "10000"


@pytest.mark.asyncio
async def test_claim_gift_skips_after_window(
    client: AsyncClient,
    seed_user_for_claim: dict,
    db_session: AsyncSession,
    monkeypatch,
):
    import hub.config

    token = seed_user_for_claim["token"]
    monkeypatch.setattr(
        hub.config,
        "CLAIM_GIFT_WINDOW_END_AT_EXCLUSIVE",
        datetime.datetime(2026, 4, 7, 0, 0, 0, tzinfo=datetime.timezone.utc),
    )

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents",
            json={
                "agent_id": "ag_windowclosed1",
                "display_name": "Window Closed",
                "agent_token": "tok_valid",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 201
    tx_count = await db_session.execute(
        select(func.count()).select_from(WalletTransaction).where(
            WalletTransaction.to_owner_id == "ag_windowclosed1",
            WalletTransaction.type == TxType.grant,
        )
    )
    assert tx_count.scalar_one() == 0


@pytest.mark.asyncio
async def test_claim_agent_already_claimed(
    client: AsyncClient, seed_user_for_claim: dict, db_session: AsyncSession
):
    """Agent already claimed returns 409."""
    token = seed_user_for_claim["token"]

    agent = Agent(
        agent_id="ag_claimed00001",
        display_name="Already Claimed",
        user_id=seed_user_for_claim["user_id"],
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents",
            json={
                "agent_id": "ag_claimed00001",
                "display_name": "Already Claimed",
                "agent_token": "tok_valid",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 409
    assert "already claimed" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_claim_agent_quota_exceeded(
    client: AsyncClient, seed_user_for_claim: dict, db_session: AsyncSession
):
    """Quota exceeded returns 400."""
    token = seed_user_for_claim["token"]
    user_id = seed_user_for_claim["user_id"]

    # Set max_agents to 1 and create one agent already
    seed_user_for_claim["user"].max_agents = 1
    agent = Agent(
        agent_id="ag_existing0001",
        display_name="Existing",
        user_id=user_id,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents",
            json={
                "agent_id": "ag_newquota0001",
                "display_name": "Over Quota",
                "agent_token": "tok_valid",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 400
    assert "quota" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_claim_agent_missing_token_and_proof(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Missing both agent_token and bind_proof returns 400."""
    token = seed_user_for_claim["token"]

    resp = await client.post(
        "/api/users/me/agents",
        json={
            "agent_id": "ag_notoken00001",
            "display_name": "No Token",
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 400
    detail = resp.json()["detail"].lower()
    assert "agent_token" in detail or "bind_proof" in detail


@pytest.mark.asyncio
async def test_claim_agent_invalid_agent_id(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Invalid agent_id format returns 400."""
    token = seed_user_for_claim["token"]

    resp = await client.post(
        "/api/users/me/agents",
        json={
            "agent_id": "bad_format_id",
            "display_name": "Bad ID",
            "agent_token": "tok_valid",
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 400
    assert "ag_" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# POST /api/users/me/agents — claim via bind_proof (Ed25519 flow)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_agent_with_bind_proof_success(
    client: AsyncClient, seed_user_for_claim: dict, db_session: AsyncSession
):
    """Successful claim with bind_proof: ticket verified, Ed25519 proof verified."""
    token = seed_user_for_claim["token"]
    user_id = str(seed_user_for_claim["user_id"])
    agent_id = "ag_proofagent01"

    # Create SigningKey for the agent
    signing_key = SigningKey(
        key_id="k_testkey001",
        agent_id=agent_id,
        pubkey="ed25519:dGVzdHB1YmtleQ==",  # dummy
        state=KeyState.active,
    )
    db_session.add(signing_key)
    await db_session.commit()

    ticket = _make_bind_ticket(user_id)

    # Mock the Ed25519 verification and token creation
    with patch("app.routers.users.verify_challenge_sig", return_value=True), \
         patch("app.routers.users.create_agent_token", return_value=("tok_new_agent", 9999)):
        resp = await client.post(
            "/api/users/me/agents",
            json={
                "agent_id": agent_id,
                "display_name": "Proof Agent",
                "bind_proof": {
                    "key_id": "k_testkey001",
                    "nonce": "testnonce123",
                    "sig": "testsig123",
                },
                "bind_ticket": ticket,
            },
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["display_name"] == "Proof Agent"
    assert data["is_default"] is True


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind — agent bind via ticket (no user auth)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_bind_success(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Successful bind with valid ticket + token."""
    user_id = str(seed_user_for_claim["user_id"])
    ticket = _make_bind_ticket(user_id)

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindagent001",
                "display_name": "Bound Agent",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == "ag_bindagent001"
    assert data["display_name"] == "Bound Agent"
    assert data["is_default"] is True  # first agent for this user
    assert data["claimed_at"] is not None


@pytest.mark.asyncio
async def test_agent_bind_invalid_ticket(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Invalid bind_ticket returns 401."""
    resp = await client.post(
        "/api/users/me/agents/bind",
        json={
            "agent_id": "ag_bindagent002",
            "display_name": "Bind Agent 2",
            "agent_token": "tok_valid",
            "bind_ticket": "invalid.ticket",
        },
    )

    assert resp.status_code == 401
    detail = resp.json()["detail"].lower()
    assert "invalid" in detail or "expired" in detail


@pytest.mark.asyncio
async def test_agent_bind_invalid_bind_code(
    client: AsyncClient, seed_user_for_claim: dict
):
    resp = await client.post(
        "/api/users/me/agents/bind",
        json={
            "agent_id": "ag_bindagent003",
            "display_name": "Bind Agent 3",
            "agent_token": "tok_valid",
            "bind_code": "bd_invalid",
        },
    )

    assert resp.status_code == 401
    assert "bind code" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_agent_bind_code_survives_failed_attempt(
    client: AsyncClient, seed_user_for_claim: dict
):
    """bind_code should NOT be burned when a later verification step fails."""
    token = seed_user_for_claim["token"]
    issue = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    bind_code = issue.json()["bind_code"]

    # First attempt: agent_token verification fails → 401, but bind_code survives
    with _mock_verify_agent_control(False):
        first = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindcodeburn1",
                "display_name": "Burn Code",
                "agent_token": "tok_bad",
                "bind_code": bind_code,
            },
        )
    assert first.status_code == 401

    # Second attempt: same bind_code with valid token → should succeed
    with _mock_verify_agent_control(True):
        second = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindcodeburn1",
                "display_name": "Burn Code",
                "agent_token": "tok_valid",
                "bind_code": bind_code,
            },
        )
    assert second.status_code == 201

    # Third attempt: bind_code now consumed → 401
    with _mock_verify_agent_control(True):
        third = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindcodeburn2",
                "display_name": "Burn Code 2",
                "agent_token": "tok_valid",
                "bind_code": bind_code,
            },
        )
    assert third.status_code == 401
    assert "bind code" in third.json()["detail"].lower() or "consumed" in third.json()["detail"].lower()


@pytest.mark.asyncio
async def test_agent_bind_ticket_replay_rejected(
    client: AsyncClient, seed_user_for_claim: dict
):
    """Replaying the same bind_ticket returns 401 on second use."""
    user_id = str(seed_user_for_claim["user_id"])
    ticket = _make_bind_ticket(user_id)

    # First use succeeds
    with _mock_verify_agent_control(True):
        resp1 = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_replay00001",
                "display_name": "First Bind",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )
    assert resp1.status_code == 201

    # Same ticket again (different agent) should be rejected
    with _mock_verify_agent_control(True):
        resp2 = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_replay00002",
                "display_name": "Replay Bind",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )
    assert resp2.status_code == 401


@pytest.mark.asyncio
async def test_agent_bind_ticket_survives_failed_attempt(
    client: AsyncClient, seed_user_for_claim: dict
):
    """bind_ticket jti should NOT be consumed when agent_token verification fails.

    After the first attempt fails (bad agent_token), the same ticket should
    still be usable on a second attempt with a valid agent_token.
    """
    user_id = str(seed_user_for_claim["user_id"])
    ticket = _make_bind_ticket(user_id)

    # First attempt: agent_token verification fails → 401, but ticket survives
    with _mock_verify_agent_control(False):
        resp1 = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_burntest0001",
                "display_name": "Burn Test",
                "agent_token": "tok_bad",
                "bind_ticket": ticket,
            },
        )
    assert resp1.status_code == 401
    assert "token" in resp1.json()["detail"].lower()

    # Second attempt: same ticket with valid token → should succeed
    with _mock_verify_agent_control(True):
        resp2 = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_burntest0001",
                "display_name": "Burn Test",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )
    assert resp2.status_code == 201

    # Third attempt: ticket now consumed → 401
    with _mock_verify_agent_control(True):
        resp3 = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_burntest0002",
                "display_name": "Burn Test 2",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )
    assert resp3.status_code == 401
    assert "already used" in resp3.json()["detail"].lower()


@pytest.mark.asyncio
async def test_agent_bind_already_claimed(
    client: AsyncClient, seed_user_for_claim: dict, db_session: AsyncSession
):
    """Agent already claimed returns 409."""
    user_id = str(seed_user_for_claim["user_id"])
    ticket = _make_bind_ticket(user_id)

    # Pre-create a claimed agent owned by another user
    other_user = User(
        id=uuid.uuid4(),
        display_name="Other User",
        email="other@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
        max_agents=10,
    )
    db_session.add(other_user)

    agent = Agent(
        agent_id="ag_bindclaim001",
        display_name="Already Bound",
        user_id=other_user.id,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    with _mock_verify_agent_control(True):
        resp = await client.post(
            "/api/users/me/agents/bind",
            json={
                "agent_id": "ag_bindclaim001",
                "display_name": "Already Bound",
                "agent_token": "tok_valid",
                "bind_ticket": ticket,
            },
        )

    assert resp.status_code == 409
    assert "already claimed" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_reset_agent_credential_success(
    client: AsyncClient, seed_user: dict, db_session: AsyncSession
):
    token = seed_user["token"]
    existing_seed = NaClSigningKey.generate()._seed
    existing_pubkey = base64.b64encode(bytes(NaClSigningKey(existing_seed).verify_key)).decode()
    db_session.add(
        SigningKey(
            key_id="k_existing_reset",
            agent_id="ag_agent001",
            pubkey=f"ed25519:{existing_pubkey}",
            state=KeyState.active,
        )
    )
    await db_session.commit()

    issue = await client.post(
        "/api/users/me/agents/ag_agent001/credential-reset-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert issue.status_code == 200
    reset_code = issue.json()["reset_code"]

    new_seed = NaClSigningKey.generate()._seed
    new_pubkey = base64.b64encode(bytes(NaClSigningKey(new_seed).verify_key)).decode()

    with patch("app.routers.users.create_agent_token", return_value=("tok_reset_new", 2222222222)):
        resp = await client.post(
            "/api/users/me/agents/reset-credential",
            json={
                "agent_id": "ag_agent001",
                "pubkey": f"ed25519:{new_pubkey}",
                "reset_code": reset_code,
            },
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "ag_agent001"
    assert data["display_name"] == "Agent One"
    assert data["agent_token"] == "tok_reset_new"
    assert data["key_id"].startswith("k_")

    keys = (
        await db_session.execute(
            select(SigningKey).where(SigningKey.agent_id == "ag_agent001")
        )
    ).scalars().all()
    assert len(keys) == 2
    assert sum(1 for key in keys if key.state == KeyState.active) == 1
    assert any(key.pubkey == f"ed25519:{new_pubkey}" and key.state == KeyState.active for key in keys)
    assert any(key.key_id == "k_existing_reset" and key.state == KeyState.revoked for key in keys)

    agent = (
        await db_session.execute(select(Agent).where(Agent.agent_id == "ag_agent001"))
    ).scalar_one()
    assert agent.agent_token == "tok_reset_new"


@pytest.mark.asyncio
async def test_reset_agent_credential_ticket_replay_rejected(
    client: AsyncClient, seed_user: dict, db_session: AsyncSession
):
    token = seed_user["token"]
    issue = await client.post(
        "/api/users/me/agents/ag_agent001/credential-reset-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    reset_ticket = issue.json()["reset_ticket"]

    pubkey_1 = base64.b64encode(bytes(NaClSigningKey.generate().verify_key)).decode()
    pubkey_2 = base64.b64encode(bytes(NaClSigningKey.generate().verify_key)).decode()

    with patch("app.routers.users.create_agent_token", return_value=("tok_reset_once", 2222222222)):
        first = await client.post(
            "/api/users/me/agents/reset-credential",
            json={
                "agent_id": "ag_agent001",
                "pubkey": f"ed25519:{pubkey_1}",
                "reset_ticket": reset_ticket,
            },
        )
    assert first.status_code == 200

    second = await client.post(
        "/api/users/me/agents/reset-credential",
        json={
            "agent_id": "ag_agent001",
            "pubkey": f"ed25519:{pubkey_2}",
            "reset_ticket": reset_ticket,
        },
    )
    assert second.status_code == 401
    assert "already used" in second.json()["detail"].lower()

"""Tests for human-as-owner subscription product / migrate-plan flows.

Covers the cases enumerated in
``docs/human-owner-subscription-redesign.md`` §5 (PR A unit tests):

- human-owned room: human directly changes plan (no identity switch) → 200
- agent-owned room: human-as-bound-user changes plan (no identity switch) → 200
- agent-owned room: cross-user actor changes plan → 403
- human-owned room: migrate-plan without ``provider_agent_id`` → 400
- human-owned room: ``provider_agent_id`` not owned by ctx.user → 403
- humans BFF PATCH with invalid product_id → 404; non-owner product → 403
- humans BFF dissolve pre-cancels bound subscriptions
"""

from __future__ import annotations

import datetime
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import (
    BillingInterval,
    MessagePolicy,
    ParticipantType,
    RoomJoinPolicy,
    RoomRole,
    RoomVisibility,
    SubscriptionProductStatus,
    SubscriptionStatus,
)
from hub.models import (
    Agent,
    AgentSubscription,
    Base,
    Role,
    Room,
    RoomMember,
    SubscriptionProduct,
    User,
    UserRole,
)

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _token(sub: str) -> str:
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
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(hub.config, "BETA_GATE_ENABLED", False)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def world(db_session: AsyncSession):
    """Two users, each with one bound active agent.

    user_a owns ag_a01 (bound), and is the human owner for one human-owned
    room and the agent-owner-via-bot for one agent-owned room.
    user_b owns ag_b01 (bound), unrelated.
    """
    role = Role(name="member", display_name="Member")
    db_session.add(role)
    await db_session.flush()

    user_a = User(supabase_user_id=uuid.uuid4(), display_name="Alice", email="a@x.com")
    user_b = User(supabase_user_id=uuid.uuid4(), display_name="Bob", email="b@x.com")
    db_session.add_all([user_a, user_b])
    await db_session.flush()
    db_session.add_all([
        UserRole(user_id=user_a.id, role_id=role.id),
        UserRole(user_id=user_b.id, role_id=role.id),
    ])

    now = datetime.datetime.now(datetime.timezone.utc)
    ag_a = Agent(
        agent_id="ag_a01",
        display_name="Alice Bot",
        message_policy=MessagePolicy.open,
        user_id=user_a.id,
        is_default=True,
        claimed_at=now,
        status="active",
    )
    ag_b = Agent(
        agent_id="ag_b01",
        display_name="Bob Bot",
        message_policy=MessagePolicy.open,
        user_id=user_b.id,
        is_default=True,
        claimed_at=now,
        status="active",
    )
    db_session.add_all([ag_a, ag_b])
    await db_session.flush()

    # Human-owned room: alice (hu_*) is the owner.
    human_room = Room(
        room_id="rm_human01",
        name="Alice's Human Room",
        description="",
        owner_id=user_a.human_id,
        owner_type=ParticipantType.human,
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
    )
    # Agent-owned room: ag_a01 is the owner. Alice can manage as bound user.
    agent_room = Room(
        room_id="rm_agent01",
        name="Alice Bot's Agent Room",
        description="",
        owner_id="ag_a01",
        owner_type=ParticipantType.agent,
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
    )
    db_session.add_all([human_room, agent_room])
    await db_session.flush()

    db_session.add_all([
        RoomMember(
            room_id="rm_human01",
            agent_id=user_a.human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.owner,
        ),
        RoomMember(
            room_id="rm_agent01",
            agent_id="ag_a01",
            participant_type=ParticipantType.agent,
            role=RoomRole.owner,
        ),
    ])
    await db_session.commit()
    await db_session.refresh(user_a)
    await db_session.refresh(user_b)

    return {
        "user_a": user_a,
        "user_b": user_b,
        "human_id_a": user_a.human_id,
        "ag_a": "ag_a01",
        "ag_b": "ag_b01",
        "token_a": _token(str(user_a.supabase_user_id)),
        "token_b": _token(str(user_b.supabase_user_id)),
        "human_room": "rm_human01",
        "agent_room": "rm_agent01",
    }


def _h(token: str, agent_id: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    if agent_id:
        headers["X-Active-Agent"] = agent_id
    return headers


# ---------------------------------------------------------------------------
# migrate-plan
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_owned_room_human_can_migrate_plan(client: AsyncClient, world: dict):
    """Human-owned room: viewer is the human owner with no X-Active-Agent.
    Must succeed when ``provider_agent_id`` points to one of their bound bots."""
    resp = await client.post(
        f"/api/dashboard/rooms/{world['human_room']}/subscription/migrate-plan",
        headers=_h(world["token_a"]),  # no X-Active-Agent
        json={
            "amount_minor": "1000",
            "billing_interval": "week",
            "provider_agent_id": world["ag_a"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["product_id"].startswith("sp_")
    assert body["room"]["required_subscription_product_id"] == body["product_id"]


@pytest.mark.asyncio
async def test_agent_owned_room_bound_user_can_migrate_plan_without_x_active_agent(
    client: AsyncClient, world: dict, db_session: AsyncSession,
):
    """Agent-owned room: viewer doesn't switch to the owner agent — they're
    still that agent's bound user, so capability resolves to owner."""
    resp = await client.post(
        f"/api/dashboard/rooms/{world['agent_room']}/subscription/migrate-plan",
        headers=_h(world["token_a"]),  # no X-Active-Agent
        json={"amount_minor": "500", "billing_interval": "month"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Provider for an agent-owned room is forced to the owner agent.
    new_pid = body["product_id"]
    product = (
        await db_session.execute(
            select(SubscriptionProduct).where(SubscriptionProduct.product_id == new_pid)
        )
    ).scalar_one()
    assert product.owner_id == world["ag_a"]
    assert product.owner_type == ParticipantType.agent
    assert product.provider_agent_id == world["ag_a"]


@pytest.mark.asyncio
async def test_agent_owned_room_other_user_forbidden(client: AsyncClient, world: dict):
    """Agent-owned room: a different user (who doesn't own the bot) → 403."""
    resp = await client.post(
        f"/api/dashboard/rooms/{world['agent_room']}/subscription/migrate-plan",
        headers=_h(world["token_b"]),
        json={"amount_minor": "500", "billing_interval": "month"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_human_owned_room_missing_provider_agent_id(client: AsyncClient, world: dict):
    """Human-owned room: must reject migrate-plan without ``provider_agent_id``."""
    resp = await client.post(
        f"/api/dashboard/rooms/{world['human_room']}/subscription/migrate-plan",
        headers=_h(world["token_a"]),
        json={"amount_minor": "1000", "billing_interval": "week"},
    )
    assert resp.status_code == 400
    assert "provider_agent_id" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_human_owned_room_provider_agent_not_owned(client: AsyncClient, world: dict):
    """Human-owned room: ``provider_agent_id`` belongs to a different user → 403."""
    resp = await client.post(
        f"/api/dashboard/rooms/{world['human_room']}/subscription/migrate-plan",
        headers=_h(world["token_a"]),
        json={
            "amount_minor": "1000",
            "billing_interval": "week",
            "provider_agent_id": world["ag_b"],  # owned by user_b
        },
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Human BFF PATCH /api/humans/me/rooms/{id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_humans_patch_required_product_404_for_unknown(client: AsyncClient, world: dict):
    resp = await client.patch(
        f"/api/humans/me/rooms/{world['human_room']}",
        headers=_h(world["token_a"]),
        json={"required_subscription_product_id": "sp_doesnotexist"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_humans_patch_required_product_403_when_owner_mismatch(
    client: AsyncClient, world: dict, db_session: AsyncSession,
):
    """A product owned by ag_b cannot be attached to alice's human-owned room."""
    db_session.add(
        SubscriptionProduct(
            product_id="sp_othersown",
            owner_id=world["ag_b"],
            owner_type=ParticipantType.agent,
            provider_agent_id=world["ag_b"],
            name="Bob Plan",
            amount_minor=100,
            billing_interval=BillingInterval.month,
            status=SubscriptionProductStatus.active,
        )
    )
    await db_session.commit()
    resp = await client.patch(
        f"/api/humans/me/rooms/{world['human_room']}",
        headers=_h(world["token_a"]),
        json={"required_subscription_product_id": "sp_othersown"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_humans_dissolve_precancels_bound_subscriptions(
    client: AsyncClient, world: dict, db_session: AsyncSession,
):
    """Dissolving a human-owned room via /api/humans/me/rooms/{id} should
    pre-cancel any bound subscriptions before the FK SET NULL kicks in."""
    now = datetime.datetime.now(datetime.timezone.utc)
    db_session.add(
        SubscriptionProduct(
            product_id="sp_paid",
            owner_id=world["human_id_a"],
            owner_type=ParticipantType.human,
            provider_agent_id=world["ag_a"],
            name="Alice Paid",
            amount_minor=1000,
            billing_interval=BillingInterval.week,
            status=SubscriptionProductStatus.active,
        )
    )
    db_session.add(
        AgentSubscription(
            subscription_id="sub_active",
            product_id="sp_paid",
            subscriber_agent_id=world["ag_b"],
            provider_agent_id=world["ag_a"],
            room_id=world["human_room"],
            amount_minor=1000,
            billing_interval=BillingInterval.week,
            status=SubscriptionStatus.active,
            current_period_start=now,
            current_period_end=now + datetime.timedelta(days=7),
            next_charge_at=now + datetime.timedelta(days=7),
        )
    )
    await db_session.commit()

    resp = await client.delete(
        f"/api/humans/me/rooms/{world['human_room']}",
        headers=_h(world["token_a"]),
    )
    assert resp.status_code == 200, resp.text

    sub = (
        await db_session.execute(
            select(AgentSubscription).where(AgentSubscription.subscription_id == "sub_active")
        )
    ).scalar_one()
    assert sub.status == SubscriptionStatus.cancelled
    assert sub.cancelled_at is not None

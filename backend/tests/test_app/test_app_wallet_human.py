"""Tests for /api/wallet endpoints invoked with `?as=human`.

Covers: human wallet summary/ledger, agent→human and human→agent transfers,
and human-side topups. PR2 semantics: `ctx.human_id` is resolved from the
Supabase-authenticated user; no X-Active-Agent header is required for human
mode.
"""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    MessageRecord,
    MessagePolicy,
    ParticipantType,
    Role,
    Room,
    RoomMember,
    RoomRole,
    User,
    UserRole,
    WalletAccount,
)

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str, secret: str = TEST_SUPABASE_SECRET) -> str:
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
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

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
async def seed(db_session: AsyncSession):
    """User with an agent. User has an auto-generated human_id."""
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="Human Wallet User",
        email="human@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
    )
    db_session.add(user)

    role = Role(
        id=uuid.uuid4(), name="member", display_name="Member",
        is_system=True, priority=0,
    )
    db_session.add(role)
    await db_session.flush()

    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id))

    agent = Agent(
        agent_id="ag_humanwal01",
        display_name="Human's Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)

    # Seed a pre-funded agent wallet so we can transfer agent → human
    db_session.add(WalletAccount(
        owner_id="ag_humanwal01",
        asset_code="COIN",
        available_balance_minor=5000,
        locked_balance_minor=0,
    ))

    await db_session.commit()
    await db_session.refresh(user)

    return {
        "token": _make_token(str(supabase_uuid)),
        "agent_id": "ag_humanwal01",
        "human_id": user.human_id,
    }


# ---------------------------------------------------------------------------
# Summary / lazy-create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_summary_lazy_creates_wallet(client, seed):
    """First GET with ?as=human creates a zero-balance human wallet."""
    resp = await client.get(
        "/api/wallet/summary?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == seed["human_id"]
    assert data["available_balance_minor"] == "0"
    assert data["locked_balance_minor"] == "0"


@pytest.mark.asyncio
async def test_invalid_as_value_rejected(client, seed):
    resp = await client.get(
        "/api/wallet/summary?as=bogus",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_as_agent_without_header_rejected(client, seed):
    """as=agent still requires X-Active-Agent."""
    resp = await client.get(
        "/api/wallet/summary?as=agent",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Transfer agent ↔ human
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_to_human_transfer(client, seed):
    """Agent wallet (5000) → human wallet. Balances shift accordingly."""
    resp = await client.post(
        "/api/wallet/transfers?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
        json={"to_agent_id": seed["human_id"], "amount_minor": "1500"},
    )
    assert resp.status_code == 201, resp.text
    tx = resp.json()
    assert tx["from_agent_id"] == seed["agent_id"]
    assert tx["to_agent_id"] == seed["human_id"]

    # Human summary reflects the credit
    resp = await client.get(
        "/api/wallet/summary?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.json()["available_balance_minor"] == "1500"

    # Agent summary reflects the debit
    resp = await client.get(
        "/api/wallet/summary?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
    )
    assert resp.json()["available_balance_minor"] == "3500"


@pytest.mark.asyncio
async def test_human_to_agent_transfer(client, seed):
    """Seed human wallet then transfer human → agent with ?as=human."""
    # Fund human wallet first via agent → human
    await client.post(
        "/api/wallet/transfers?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
        json={"to_agent_id": seed["human_id"], "amount_minor": "2000"},
    )

    # Now human → agent
    resp = await client.post(
        "/api/wallet/transfers?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"to_agent_id": seed["agent_id"], "amount_minor": "500"},
    )
    assert resp.status_code == 201, resp.text
    tx = resp.json()
    assert tx["from_agent_id"] == seed["human_id"]
    assert tx["to_agent_id"] == seed["agent_id"]

    # Human balance: 2000 - 500 = 1500
    resp = await client.get(
        "/api/wallet/summary?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.json()["available_balance_minor"] == "1500"


@pytest.mark.asyncio
async def test_room_transfer_records_notice_message(client, db_session, seed):
    """A room-scoped wallet transfer posts a transfer record into that room."""
    room_id = "rm_wallet_notice"
    db_session.add(Room(
        room_id=room_id,
        name="Wallet Notice Room",
        owner_id=seed["human_id"],
        owner_type=ParticipantType.human,
    ))
    db_session.add_all([
        RoomMember(
            room_id=room_id,
            agent_id=seed["human_id"],
            participant_type=ParticipantType.human,
            role=RoomRole.owner,
        ),
        RoomMember(
            room_id=room_id,
            agent_id=seed["agent_id"],
            participant_type=ParticipantType.agent,
            role=RoomRole.member,
        ),
    ])
    await db_session.commit()

    await client.post(
        "/api/wallet/transfers?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
        json={"to_agent_id": seed["human_id"], "amount_minor": "2000"},
    )

    resp = await client.post(
        "/api/wallet/transfers?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={
            "to_agent_id": seed["agent_id"],
            "amount_minor": "500",
            "room_id": room_id,
        },
    )

    assert resp.status_code == 201, resp.text
    tx = resp.json()
    records = list((await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.room_id == room_id,
            MessageRecord.source_type == "wallet_transfer_notice",
        )
    )).scalars().all())
    assert len(records) == 2
    assert {record.receiver_id for record in records} == {seed["human_id"], seed["agent_id"]}
    assert records[0].envelope_json
    assert "[BotCord Transfer]" in records[0].envelope_json
    assert tx["tx_id"] in records[0].envelope_json


@pytest.mark.asyncio
async def test_transfer_to_nonexistent_human_rejected(client, seed):
    resp = await client.post(
        "/api/wallet/transfers?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
        json={"to_agent_id": "hu_doesnotexist", "amount_minor": "100"},
    )
    assert resp.status_code == 400
    assert "human" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Topup as human (mock channel)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_topup_creates_pending(client, seed):
    resp = await client.post(
        "/api/wallet/topups?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"amount_minor": "800", "channel": "mock"},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["agent_id"] == seed["human_id"]
    assert data["status"] == "pending"
    assert data["amount_minor"] == "800"


# ---------------------------------------------------------------------------
# Ledger isolation: agent ledger ≠ human ledger
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ledger_scoped_to_owner(client, seed):
    # Transfer agent → human
    await client.post(
        "/api/wallet/transfers?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
        json={"to_agent_id": seed["human_id"], "amount_minor": "700"},
    )

    # Agent ledger: one debit entry
    resp = await client.get(
        "/api/wallet/ledger?as=agent",
        headers={
            "Authorization": f"Bearer {seed['token']}",
            "X-Active-Agent": seed["agent_id"],
        },
    )
    agent_entries = resp.json()["entries"]
    assert any(e["direction"] == "debit" and e["amount_minor"] == "700" for e in agent_entries)

    # Human ledger: one credit entry
    resp = await client.get(
        "/api/wallet/ledger?as=human",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    human_entries = resp.json()["entries"]
    assert any(e["direction"] == "credit" and e["amount_minor"] == "700" for e in human_entries)
    # And no debit — the human only received
    assert all(e["direction"] == "credit" for e in human_entries)

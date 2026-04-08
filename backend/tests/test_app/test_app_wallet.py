"""Tests for /api/wallet endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    MessagePolicy,
    Role,
    User,
    UserRole,
    WalletAccount,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
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
    from tests.test_app.conftest import create_test_engine; engine = create_test_engine()
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
async def seed_data(db_session: AsyncSession):
    """Create two users/agents with wallets for testing transfers."""
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Wallet User",
        email="wallet@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
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

    agent = Agent(
        agent_id="ag_wallet001",
        display_name="Wallet Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)

    # Second agent (for transfers)
    supabase_uuid2 = uuid.uuid4()
    user_id2 = uuid.uuid4()
    user2 = User(
        id=user_id2,
        display_name="Recipient User",
        email="recipient@example.com",
        status="active",
        supabase_user_id=supabase_uuid2,
    )
    db_session.add(user2)
    user_role2 = UserRole(id=uuid.uuid4(), user_id=user_id2, role_id=role.id)
    db_session.add(user_role2)

    agent2 = Agent(
        agent_id="ag_wallet002",
        display_name="Recipient Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id2,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent2)

    # Give agent1 some balance
    wallet = WalletAccount(
        agent_id="ag_wallet001",
        asset_code="COIN",
        available_balance_minor=10000,
        locked_balance_minor=0,
    )
    db_session.add(wallet)

    await db_session.commit()

    token = _make_token(str(supabase_uuid))
    token2 = _make_token(str(supabase_uuid2))

    return {
        "token": token,
        "token2": token2,
        "agent_id": "ag_wallet001",
        "agent_id2": "ag_wallet002",
        "supabase_uid": str(supabase_uuid),
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wallet_summary(client, seed_data):
    resp = await client.get(
        "/api/wallet/summary",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == seed_data["agent_id"]
    assert data["available_balance_minor"] == "10000"
    assert data["locked_balance_minor"] == "0"
    assert data["total_balance_minor"] == "10000"


@pytest.mark.asyncio
async def test_wallet_summary_no_auth(client, seed_data):
    resp = await client.get("/api/wallet/summary")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_transfer(client, seed_data):
    resp = await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "500",
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["type"] == "transfer"
    assert data["status"] == "completed"
    assert data["amount_minor"] == "500"
    assert data["from_agent_id"] == seed_data["agent_id"]
    assert data["to_agent_id"] == seed_data["agent_id2"]


@pytest.mark.asyncio
async def test_transfer_insufficient_balance(client, seed_data):
    resp = await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "999999",
        },
    )
    assert resp.status_code == 400
    assert "Insufficient" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_transfer_to_self(client, seed_data):
    resp = await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id"],
            "amount_minor": "100",
        },
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_ledger_after_transfer(client, seed_data):
    # Do a transfer first
    await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "200",
        },
    )

    resp = await client.get(
        "/api/wallet/ledger",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["entries"]) >= 1
    assert "entry_id" in data["entries"][0]
    assert "has_more" in data


@pytest.mark.asyncio
async def test_topup(client, seed_data):
    resp = await client.post(
        "/api/wallet/topups",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={"amount_minor": "1000", "channel": "mock"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == seed_data["agent_id"]
    assert data["amount_minor"] == "1000"
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_withdrawal_flow(client, seed_data):
    # Create withdrawal
    resp = await client.post(
        "/api/wallet/withdrawals",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={"amount_minor": "500"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "pending"
    withdrawal_id = data["withdrawal_id"]

    # List withdrawals
    resp = await client.get(
        "/api/wallet/withdrawals",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 200
    assert len(resp.json()["withdrawals"]) == 1

    # Cancel withdrawal
    resp = await client.post(
        f"/api/wallet/withdrawals/{withdrawal_id}/cancel",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_transaction_detail(client, seed_data):
    # Create a transfer to get a tx_id
    resp = await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "100",
        },
    )
    tx_id = resp.json()["tx_id"]

    # Fetch detail
    resp = await client.get(
        f"/api/wallet/transactions/{tx_id}",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["tx_id"] == tx_id


@pytest.mark.asyncio
async def test_transaction_detail_not_authorized(client, seed_data):
    # Create a transfer between agent1 -> agent2
    resp = await client.post(
        "/api/wallet/transfers",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "100",
        },
    )
    tx_id = resp.json()["tx_id"]

    # agent2 can see it (is to_agent_id)
    resp = await client.get(
        f"/api/wallet/transactions/{tx_id}",
        headers={
            "Authorization": f"Bearer {seed_data['token2']}",
            "X-Active-Agent": seed_data["agent_id2"],
        },
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_transaction_not_found(client, seed_data):
    resp = await client.get(
        "/api/wallet/transactions/tx_nonexistent",
        headers={
            "Authorization": f"Bearer {seed_data['token']}",
            "X-Active-Agent": seed_data["agent_id"],
        },
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_stripe_packages(client, seed_data):
    resp = await client.get("/api/wallet/stripe/packages")
    assert resp.status_code == 200
    assert "packages" in resp.json()


@pytest.mark.asyncio
async def test_list_wallet_ledger(client, seed_data):
    """GET /api/wallet/ledger returns entries with correct shape after a transfer."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    # Do a transfer to generate ledger entries
    await client.post(
        "/api/wallet/transfers",
        headers=headers,
        json={
            "to_agent_id": seed_data["agent_id2"],
            "amount_minor": "300",
        },
    )

    resp = await client.get("/api/wallet/ledger", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "entries" in data
    assert "has_more" in data
    assert "next_cursor" in data
    assert len(data["entries"]) >= 1

    entry = data["entries"][0]
    assert "entry_id" in entry
    assert "tx_id" in entry
    assert "direction" in entry
    assert "tx_type" in entry
    assert "reference_type" in entry
    assert "reference_id" in entry
    assert "amount_minor" in entry
    assert "balance_after_minor" in entry
    assert "created_at" in entry


@pytest.mark.asyncio
async def test_list_withdrawals(client, seed_data):
    """GET /api/wallet/withdrawals returns withdrawals with correct shape."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    # Create a withdrawal first
    create_resp = await client.post(
        "/api/wallet/withdrawals",
        headers=headers,
        json={"amount_minor": "200"},
    )
    assert create_resp.status_code == 201

    resp = await client.get("/api/wallet/withdrawals", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "withdrawals" in data
    assert len(data["withdrawals"]) >= 1

    wd = data["withdrawals"][0]
    assert "withdrawal_id" in wd
    assert "status" in wd
    assert "amount_minor" in wd


@pytest.mark.asyncio
async def test_cancel_withdrawal(client, seed_data):
    """POST /api/wallet/withdrawals/{id}/cancel cancels a pending withdrawal."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    # Create withdrawal
    create_resp = await client.post(
        "/api/wallet/withdrawals",
        headers=headers,
        json={"amount_minor": "400"},
    )
    assert create_resp.status_code == 201
    withdrawal_id = create_resp.json()["withdrawal_id"]

    # Cancel it
    resp = await client.post(
        f"/api/wallet/withdrawals/{withdrawal_id}/cancel",
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_stripe_checkout_session_not_configured(client, seed_data):
    """POST /api/wallet/stripe/checkout-session returns 400 when Stripe is not configured."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    resp = await client.post(
        "/api/wallet/stripe/checkout-session",
        headers=headers,
        json={
            "package_code": "starter",
            "idempotency_key": "test-idem-123",
        },
    )
    assert resp.status_code == 400
    assert "Stripe" in resp.json()["detail"] or "configured" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_stripe_session_status_missing_param(client, seed_data):
    """GET /api/wallet/stripe/session-status without session_id returns 422."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    resp = await client.get("/api/wallet/stripe/session-status", headers=headers)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_stripe_session_status_not_found(client, seed_data):
    """GET /api/wallet/stripe/session-status with nonexistent session returns 404."""
    headers = {
        "Authorization": f"Bearer {seed_data['token']}",
        "X-Active-Agent": seed_data["agent_id"],
    }
    resp = await client.get(
        "/api/wallet/stripe/session-status?session_id=cs_nonexistent",
        headers=headers,
    )
    assert resp.status_code == 404

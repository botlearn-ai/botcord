"""Tests for /api/subscriptions endpoints."""

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
    """Create two users/agents for subscription testing."""
    # Owner
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="Sub Owner",
        email="owner@example.com",
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

    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id))

    agent_owner = Agent(
        agent_id="ag_subowner001",
        display_name="Sub Owner Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent_owner)

    # Subscriber
    supabase_uuid2 = uuid.uuid4()
    user_id2 = uuid.uuid4()
    user2 = User(
        id=user_id2,
        display_name="Subscriber",
        email="subscriber@example.com",
        status="active",
        supabase_user_id=supabase_uuid2,
    )
    db_session.add(user2)
    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id2, role_id=role.id))

    agent_sub = Agent(
        agent_id="ag_subscriber001",
        display_name="Subscriber Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id2,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent_sub)

    # Give subscriber a balance for subscription charges
    wallet = WalletAccount(
        owner_id="ag_subscriber001",
        asset_code="COIN",
        available_balance_minor=50000,
        locked_balance_minor=0,
    )
    db_session.add(wallet)

    await db_session.commit()

    return {
        "owner_token": _make_token(str(supabase_uuid)),
        "sub_token": _make_token(str(supabase_uuid2)),
        "owner_agent_id": "ag_subowner001",
        "sub_agent_id": "ag_subscriber001",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_product(client, seed_data):
    resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Premium Plan",
            "description": "Premium features",
            "amount_minor": "1000",
            "billing_interval": "month",
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Premium Plan"
    assert data["amount_minor"] == "1000"
    assert data["billing_interval"] == "month"
    assert data["status"] == "active"
    assert data["owner_id"] == seed_data["owner_agent_id"]
    assert data["owner_type"] == "agent"
    assert data["provider_agent_id"] == seed_data["owner_agent_id"]


@pytest.mark.asyncio
async def test_list_products(client, seed_data):
    # Create a product first
    await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "List Test",
            "amount_minor": "500",
            "billing_interval": "week",
        },
    )

    resp = await client.get("/api/subscriptions/products")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["products"]) >= 1


@pytest.mark.asyncio
async def test_get_product(client, seed_data):
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Detail Test",
            "amount_minor": "800",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    resp = await client.get(f"/api/subscriptions/products/{product_id}")
    assert resp.status_code == 200
    assert resp.json()["product"]["product_id"] == product_id


@pytest.mark.asyncio
async def test_get_product_not_found(client, seed_data):
    resp = await client.get("/api/subscriptions/products/sp_nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_my_products(client, seed_data):
    await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "My Product",
            "amount_minor": "1200",
            "billing_interval": "month",
        },
    )

    resp = await client.get(
        "/api/subscriptions/products/me",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
    )
    assert resp.status_code == 200
    assert len(resp.json()["products"]) >= 1


@pytest.mark.asyncio
async def test_subscribe_and_cancel(client, seed_data):
    # Create product
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Subscribe Test",
            "amount_minor": "100",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    # Subscribe
    resp = await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
        json={},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "active"
    assert data["subscriber_agent_id"] == seed_data["sub_agent_id"]
    subscription_id = data["subscription_id"]

    # My subscriptions
    resp = await client.get(
        "/api/subscriptions/me",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
    )
    assert resp.status_code == 200
    assert len(resp.json()["subscriptions"]) == 1

    # Cancel
    resp = await client.post(
        f"/api/subscriptions/{subscription_id}/cancel",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_subscribe_to_own_product(client, seed_data):
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Self-Sub Test",
            "amount_minor": "100",
            "billing_interval": "week",
        },
    )
    product_id = create_resp.json()["product_id"]

    resp = await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={},
    )
    assert resp.status_code == 400
    assert "own product" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_archive_product(client, seed_data):
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Archive Test",
            "amount_minor": "1000",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    resp = await client.post(
        f"/api/subscriptions/products/{product_id}/archive",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "archived"


@pytest.mark.asyncio
async def test_archive_not_owner(client, seed_data):
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Not My Product",
            "amount_minor": "500",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    resp = await client.post(
        f"/api/subscriptions/products/{product_id}/archive",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
    )
    assert resp.status_code == 400
    assert "Not authorized" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_list_subscribers(client, seed_data):
    # Create product + subscription
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Subscribers Test",
            "amount_minor": "100",
            "billing_interval": "week",
        },
    )
    product_id = create_resp.json()["product_id"]

    await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
        json={},
    )

    # Owner lists subscribers
    resp = await client.get(
        f"/api/subscriptions/products/{product_id}/subscribers",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
    )
    assert resp.status_code == 200
    assert len(resp.json()["subscribers"]) == 1


@pytest.mark.asyncio
async def test_list_subscribers_not_owner(client, seed_data):
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers={
            "Authorization": f"Bearer {seed_data['owner_token']}",
            "X-Active-Agent": seed_data["owner_agent_id"],
        },
        json={
            "name": "Auth Test",
            "amount_minor": "200",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    resp = await client.get(
        f"/api/subscriptions/products/{product_id}/subscribers",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_list_my_subscriptions(client, seed_data):
    """GET /api/subscriptions/me returns subscriptions with correct shape."""
    sub_headers = {
        "Authorization": f"Bearer {seed_data['sub_token']}",
        "X-Active-Agent": seed_data["sub_agent_id"],
    }
    owner_headers = {
        "Authorization": f"Bearer {seed_data['owner_token']}",
        "X-Active-Agent": seed_data["owner_agent_id"],
    }

    # Create product
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers=owner_headers,
        json={
            "name": "My Sub Test",
            "amount_minor": "100",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    # Subscribe
    await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers=sub_headers,
        json={},
    )

    # List my subscriptions
    resp = await client.get("/api/subscriptions/me", headers=sub_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "subscriptions" in data
    assert len(data["subscriptions"]) >= 1

    sub = data["subscriptions"][0]
    assert "subscription_id" in sub
    assert "product_id" in sub
    assert "status" in sub
    assert sub["product_id"] == product_id
    assert sub["status"] == "active"


@pytest.mark.asyncio
async def test_cancel_subscription_directly(client, seed_data):
    """POST /api/subscriptions/{subscription_id}/cancel cancels a subscription."""
    sub_headers = {
        "Authorization": f"Bearer {seed_data['sub_token']}",
        "X-Active-Agent": seed_data["sub_agent_id"],
    }
    owner_headers = {
        "Authorization": f"Bearer {seed_data['owner_token']}",
        "X-Active-Agent": seed_data["owner_agent_id"],
    }

    # Create product
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers=owner_headers,
        json={
            "name": "Cancel Direct Test",
            "amount_minor": "200",
            "billing_interval": "week",
        },
    )
    product_id = create_resp.json()["product_id"]

    # Subscribe
    sub_resp = await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers=sub_headers,
        json={},
    )
    subscription_id = sub_resp.json()["subscription_id"]

    # Cancel
    resp = await client.post(
        f"/api/subscriptions/{subscription_id}/cancel",
        headers=sub_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_subscription_by_provider(client, seed_data):
    """POST /api/subscriptions/{subscription_id}/cancel by provider (product owner) succeeds."""
    sub_headers = {
        "Authorization": f"Bearer {seed_data['sub_token']}",
        "X-Active-Agent": seed_data["sub_agent_id"],
    }
    owner_headers = {
        "Authorization": f"Bearer {seed_data['owner_token']}",
        "X-Active-Agent": seed_data["owner_agent_id"],
    }

    # Create product
    create_resp = await client.post(
        "/api/subscriptions/products",
        headers=owner_headers,
        json={
            "name": "Provider Cancel Test",
            "amount_minor": "300",
            "billing_interval": "month",
        },
    )
    product_id = create_resp.json()["product_id"]

    # Subscribe as subscriber
    sub_resp = await client.post(
        f"/api/subscriptions/products/{product_id}/subscribe",
        headers=sub_headers,
        json={},
    )
    subscription_id = sub_resp.json()["subscription_id"]

    # Provider (owner) can also cancel the subscription
    resp = await client.post(
        f"/api/subscriptions/{subscription_id}/cancel",
        headers=owner_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_nonexistent_subscription(client, seed_data):
    """POST /api/subscriptions/{subscription_id}/cancel for nonexistent ID returns 400."""
    resp = await client.post(
        "/api/subscriptions/sub_nonexistent/cancel",
        headers={
            "Authorization": f"Bearer {seed_data['sub_token']}",
            "X-Active-Agent": seed_data["sub_agent_id"],
        },
    )
    assert resp.status_code == 400

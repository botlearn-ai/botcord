"""Tests for /api/dashboard/contact-requests endpoints."""

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
    Contact,
    ContactRequest,
    ContactRequestState,
    MessagePolicy,
    Role,
    Room,
    RoomMember,
    RoomRole,
    RoomVisibility,
    RoomJoinPolicy,
    User,
    UserRole,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


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
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    """Create two users, each with an agent."""
    uid1 = uuid.uuid4()
    supa1 = uuid.uuid4()
    uid2 = uuid.uuid4()
    supa2 = uuid.uuid4()

    u1 = User(id=uid1, display_name="User One", email="u1@x.com", status="active", supabase_user_id=supa1)
    u2 = User(id=uid2, display_name="User Two", email="u2@x.com", status="active", supabase_user_id=supa2)
    db_session.add_all([u1, u2])

    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()

    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid1, role_id=role.id))
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid2, role_id=role.id))

    a1 = Agent(agent_id="ag_alice001", display_name="Alice", message_policy=MessagePolicy.open,
               user_id=uid1, is_default=True, claimed_at=datetime.datetime.now(datetime.timezone.utc))
    a2 = Agent(agent_id="ag_bob0001", display_name="Bob", message_policy=MessagePolicy.open,
               user_id=uid2, is_default=True, claimed_at=datetime.datetime.now(datetime.timezone.utc))
    db_session.add_all([a1, a2])
    await db_session.commit()

    return {
        "token1": _make_token(str(supa1)),
        "token2": _make_token(str(supa2)),
        "agent1": "ag_alice001",
        "agent2": "ag_bob0001",
    }


def _headers(token: str, agent_id: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Active-Agent": agent_id}


@pytest.mark.asyncio
async def test_send_contact_request(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"], "message": "Hello!"},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["from_agent_id"] == seed["agent1"]
    assert data["to_agent_id"] == seed["agent2"]
    assert data["state"] == "pending"
    assert data["message"] == "Hello!"
    assert data["to_display_name"] == "Bob"


@pytest.mark.asyncio
async def test_send_self_request_fails(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent1"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_duplicate_request_409(client: AsyncClient, seed: dict):
    h = _headers(seed["token1"], seed["agent1"])
    await client.post("/api/dashboard/contact-requests", json={"to_agent_id": seed["agent2"]}, headers=h)
    resp = await client.post("/api/dashboard/contact-requests", json={"to_agent_id": seed["agent2"]}, headers=h)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_received_requests(client: AsyncClient, seed: dict):
    # Send request from alice to bob
    await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )

    # Bob lists received
    resp = await client.get(
        "/api/dashboard/contact-requests/received",
        headers=_headers(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["requests"]) == 1
    assert data["requests"][0]["from_agent_id"] == seed["agent1"]


@pytest.mark.asyncio
async def test_list_sent_requests(client: AsyncClient, seed: dict):
    await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )

    resp = await client.get(
        "/api/dashboard/contact-requests/sent",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["requests"]) == 1
    assert data["requests"][0]["to_agent_id"] == seed["agent2"]


@pytest.mark.asyncio
async def test_accept_request(client: AsyncClient, seed: dict):
    # Send
    send_resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    req_id = send_resp.json()["id"]

    # Accept
    resp = await client.post(
        f"/api/dashboard/contact-requests/{req_id}/accept",
        headers=_headers(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "accepted"


@pytest.mark.asyncio
async def test_reject_request(client: AsyncClient, seed: dict):
    send_resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    req_id = send_resp.json()["id"]

    resp = await client.post(
        f"/api/dashboard/contact-requests/{req_id}/reject",
        headers=_headers(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "rejected"


@pytest.mark.asyncio
async def test_resend_after_reject(client: AsyncClient, seed: dict):
    h = _headers(seed["token1"], seed["agent1"])
    send_resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=h,
    )
    req_id = send_resp.json()["id"]

    # Reject
    await client.post(
        f"/api/dashboard/contact-requests/{req_id}/reject",
        headers=_headers(seed["token2"], seed["agent2"]),
    )

    # Resend should succeed
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"], "message": "Please?"},
        headers=h,
    )
    assert resp.status_code == 201
    assert resp.json()["state"] == "pending"


@pytest.mark.asyncio
async def test_cannot_accept_others_request(client: AsyncClient, seed: dict):
    send_resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": seed["agent2"]},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    req_id = send_resp.json()["id"]

    # Alice (sender) tries to accept — should fail
    resp = await client.post(
        f"/api/dashboard/contact-requests/{req_id}/accept",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 403

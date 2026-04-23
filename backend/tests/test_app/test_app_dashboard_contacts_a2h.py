"""Agent-to-human contact request tests for /api/dashboard/contact-requests.

Covers the polymorphic extension introduced with migration
024_human_participant.sql: an active agent can send a contact request to
a human participant identified by ``hu_*``. The receiving side accepts
via ``/api/humans/me/contact-requests/*`` (owned by the humans router),
so these tests focus on dashboard-side behaviour:

* sending to a ``hu_*`` target creates a row with from_type=agent / to_type=human
* non-existent hu_ targets return 404
* duplicate pending requests return 409
* received/sent listings include the correct from_type/to_type and resolve
  human display names from the User table
* accepting an H→A request yields bidirectional Contact rows whose
  owner_type / peer_type correctly mark which side is the human.
"""

from __future__ import annotations

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
    Contact,
    ContactRequest,
    ContactRequestState,
    MessagePolicy,
    ParticipantType,
    Role,
    User,
    UserRole,
)

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


def _headers(token: str, agent_id: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Active-Agent": agent_id}


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    """Seed:

    * user1 → owns agent ag_alice001 (the sender / active agent)
    * user2 → has human_id hu_boboo001 (the A→H target)
    * user3 → owns agent ag_carol001 AND has human_id hu_carol001
      (used to verify H→A accept mixes types correctly).
    """
    uid1 = uuid.uuid4()
    supa1 = uuid.uuid4()
    uid2 = uuid.uuid4()
    supa2 = uuid.uuid4()
    uid3 = uuid.uuid4()
    supa3 = uuid.uuid4()

    u1 = User(id=uid1, display_name="Alice User", email="a@x.com", status="active",
              supabase_user_id=supa1)
    u2 = User(id=uid2, display_name="Bob Human", email="b@x.com", status="active",
              supabase_user_id=supa2, human_id="hu_boboo001")
    u3 = User(id=uid3, display_name="Carol", email="c@x.com", status="active",
              supabase_user_id=supa3, human_id="hu_carol001")
    db_session.add_all([u1, u2, u3])

    role = Role(id=uuid.uuid4(), name="member", display_name="Member",
                is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()

    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid1, role_id=role.id))
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid2, role_id=role.id))
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid3, role_id=role.id))

    now = datetime.datetime.now(datetime.timezone.utc)
    a1 = Agent(agent_id="ag_alice001", display_name="Alice", message_policy=MessagePolicy.open,
               user_id=uid1, is_default=True, claimed_at=now)
    a3 = Agent(agent_id="ag_carol001", display_name="Carol Agent",
               message_policy=MessagePolicy.open,
               user_id=uid3, is_default=True, claimed_at=now)
    db_session.add_all([a1, a3])
    await db_session.commit()

    return {
        "token1": _make_token(str(supa1)),
        "agent1": "ag_alice001",
        "token3": _make_token(str(supa3)),
        "agent3": "ag_carol001",
        "hu_bob": "hu_boboo001",
        "hu_carol": "hu_carol001",
        "display_bob": "Bob Human",
        "display_carol": "Carol",
    }


# ---------------------------------------------------------------------------
# send
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_to_human_creates_row_with_correct_types(client, seed, db_session):
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": seed["hu_bob"], "message": "Hi human"},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["from_agent_id"] == seed["agent1"]
    assert data["to_agent_id"] == seed["hu_bob"]
    assert data["from_type"] == "agent"
    assert data["to_type"] == "human"
    assert data["to_display_name"] == seed["display_bob"]
    assert data["state"] == "pending"

    # Double-check the row persisted with the right enum values.
    row = (
        await db_session.execute(select(ContactRequest).where(ContactRequest.id == data["id"]))
    ).scalar_one()
    assert row.from_type == ParticipantType.agent
    assert row.to_type == ParticipantType.human
    assert row.to_agent_id == seed["hu_bob"]


@pytest.mark.asyncio
async def test_send_requires_exactly_one_target(client, seed):
    h = _headers(seed["token1"], seed["agent1"])

    # Neither
    resp = await client.post("/api/dashboard/contact-requests", json={}, headers=h)
    assert resp.status_code == 400

    # Both
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_agent_id": "ag_x", "to_human_id": seed["hu_bob"]},
        headers=h,
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_send_to_nonexistent_human_404(client, seed):
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": "hu_ghost0001"},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_send_rejects_wrong_prefix(client, seed):
    # to_human_id must start with hu_
    resp = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": "ag_alice001"},
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_duplicate_human_request_returns_409(client, seed):
    h = _headers(seed["token1"], seed["agent1"])

    first = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": seed["hu_bob"]},
        headers=h,
    )
    assert first.status_code == 201

    dup = await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": seed["hu_bob"]},
        headers=h,
    )
    assert dup.status_code == 409


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sent_listing_includes_human_target(client, seed):
    h = _headers(seed["token1"], seed["agent1"])
    await client.post(
        "/api/dashboard/contact-requests",
        json={"to_human_id": seed["hu_bob"]},
        headers=h,
    )

    resp = await client.get("/api/dashboard/contact-requests/sent", headers=h)
    assert resp.status_code == 200
    reqs = resp.json()["requests"]
    assert len(reqs) == 1
    row = reqs[0]
    assert row["to_agent_id"] == seed["hu_bob"]
    assert row["to_type"] == "human"
    assert row["from_type"] == "agent"
    assert row["to_display_name"] == seed["display_bob"]


@pytest.mark.asyncio
async def test_received_listing_includes_human_sender_display_name(
    client, seed, db_session
):
    """Simulate an H→A ContactRequest inserted directly (the humans.py
    router is owned by another agent) and verify the dashboard received
    listing resolves the human's display name from the User row."""
    # Insert the H→A request directly.
    row = ContactRequest(
        from_agent_id=seed["hu_bob"],
        to_agent_id=seed["agent1"],
        from_type=ParticipantType.human,
        to_type=ParticipantType.agent,
        state=ContactRequestState.pending,
        message="ping from human",
    )
    db_session.add(row)
    await db_session.commit()

    resp = await client.get(
        "/api/dashboard/contact-requests/received",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    reqs = resp.json()["requests"]
    assert len(reqs) == 1
    item = reqs[0]
    assert item["from_agent_id"] == seed["hu_bob"]
    assert item["from_type"] == "human"
    assert item["to_type"] == "agent"
    assert item["from_display_name"] == seed["display_bob"]


# ---------------------------------------------------------------------------
# accept
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accept_h2a_creates_polymorphic_contact_rows(client, seed, db_session):
    """When an agent accepts an H→A request, both Contact rows must carry
    the right owner_type/peer_type so that queries downstream can tell
    whether each participant is a human or an agent."""
    # Seed an H→A request (humans.py would normally create it).
    row = ContactRequest(
        from_agent_id=seed["hu_bob"],
        to_agent_id=seed["agent1"],
        from_type=ParticipantType.human,
        to_type=ParticipantType.agent,
        state=ContactRequestState.pending,
        message=None,
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    resp = await client.post(
        f"/api/dashboard/contact-requests/{row.id}/accept",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "accepted"
    assert body["from_type"] == "human"
    assert body["to_type"] == "agent"

    # Two contact rows should exist, one for each direction.
    contacts = (await db_session.execute(select(Contact))).scalars().all()
    pairs = {
        (c.owner_id, c.owner_type, c.contact_agent_id, c.peer_type) for c in contacts
    }
    assert (
        seed["agent1"], ParticipantType.agent, seed["hu_bob"], ParticipantType.human
    ) in pairs
    assert (
        seed["hu_bob"], ParticipantType.human, seed["agent1"], ParticipantType.agent
    ) in pairs


@pytest.mark.asyncio
async def test_accept_a2a_still_creates_agent_pair(client, seed, db_session):
    """Regression: A↔A accept path must still produce agent/agent contacts."""
    # Seed an A→A request from agent3 to agent1.
    row = ContactRequest(
        from_agent_id=seed["agent3"],
        to_agent_id=seed["agent1"],
        from_type=ParticipantType.agent,
        to_type=ParticipantType.agent,
        state=ContactRequestState.pending,
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    resp = await client.post(
        f"/api/dashboard/contact-requests/{row.id}/accept",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200

    contacts = (await db_session.execute(select(Contact))).scalars().all()
    for c in contacts:
        assert c.owner_type == ParticipantType.agent
        assert c.peer_type == ParticipantType.agent


@pytest.mark.asyncio
async def test_accept_rejects_when_recipient_is_not_active_agent(
    client, seed, db_session
):
    """An A→H ContactRequest must NOT be acceptable via the dashboard
    (recipient is a human — acceptance lives on the humans-side router)."""
    row = ContactRequest(
        from_agent_id=seed["agent1"],
        to_agent_id=seed["hu_bob"],
        from_type=ParticipantType.agent,
        to_type=ParticipantType.human,
        state=ContactRequestState.pending,
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    # Active agent = ag_alice001 (the sender). Accept should 403 because
    # to_type is human, not agent — this isn't a dashboard-side accept.
    resp = await client.post(
        f"/api/dashboard/contact-requests/{row.id}/accept",
        headers=_headers(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 403

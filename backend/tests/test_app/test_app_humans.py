"""Tests for the Human-first BFF surface (/api/humans/*).

Scope covered here:
  * POST/GET /api/humans/me is idempotent and yields a stable ``hu_*`` id
  * Human creates a Room → Human appears in RoomMember with owner role
  * Human sends contact_request to a claimed Agent → queued, resolvable
  * Approve path materialises mutual Contact rows
  * Reject path flips state without creating Contact rows
  * Human sends contact_request to an unclaimed Agent → plain ContactRequest
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

from hub.models import (
    Agent,
    AgentApprovalQueue,
    ApprovalKind,
    ApprovalState,
    Base,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessagePolicy,
    ParticipantType,
    Role,
    Room,
    RoomMember,
    RoomRole,
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
    """Create one authenticated user + a Role, and assign it."""
    supabase_uid = uuid.uuid4()
    user = User(supabase_user_id=supabase_uid, display_name="Alice", email="alice@example.com")
    db_session.add(user)
    await db_session.flush()

    role = Role(name="member", display_name="Member")
    db_session.add(role)
    await db_session.flush()
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()
    await db_session.refresh(user)

    return {
        "user_id": user.id,
        "supabase_uid": str(supabase_uid),
        "human_id": user.human_id,
        "token": _token(str(supabase_uid)),
    }


# ---------------------------------------------------------------------------
# /api/humans/me
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_id_is_stable_and_prefixed(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}

    r1 = await client.post("/api/humans/me", headers=headers)
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["human_id"].startswith("hu_")
    assert body1["display_name"] == "Alice"

    r2 = await client.get("/api/humans/me", headers=headers)
    assert r2.status_code == 200
    assert r2.json()["human_id"] == body1["human_id"], "human_id must be stable across calls"


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_creates_and_lists_room(client, seed, db_session: AsyncSession):
    headers = {"Authorization": f"Bearer {seed['token']}"}

    # Create
    resp = await client.post(
        "/api/humans/me/rooms",
        headers=headers,
        json={"name": "Human HQ", "description": "salon"},
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["owner_id"] == seed["human_id"]
    assert created["owner_type"] == "human"
    assert created["my_role"] == "owner"

    # DB: RoomMember row with participant_type='human' + role=owner
    room_row = await db_session.execute(select(Room).where(Room.room_id == created["room_id"]))
    room = room_row.scalar_one()
    assert room.owner_id == seed["human_id"]
    assert room.owner_type == ParticipantType.human

    member_row = await db_session.execute(
        select(RoomMember).where(RoomMember.room_id == created["room_id"])
    )
    members = list(member_row.scalars().all())
    assert len(members) == 1
    assert members[0].agent_id == seed["human_id"]
    assert members[0].participant_type == ParticipantType.human
    assert members[0].role == RoomRole.owner

    # List returns it
    listing = await client.get("/api/humans/me/rooms", headers=headers)
    assert listing.status_code == 200
    names = [r["name"] for r in listing.json()["rooms"]]
    assert "Human HQ" in names


# ---------------------------------------------------------------------------
# Contact request → Agent (claimed)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contact_request_to_claimed_agent_queues_approval(
    client, seed, db_session: AsyncSession
):
    # Second user (Bob) who owns Agent X
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()

    agent = Agent(
        agent_id="ag_bob01234567",
        display_name="Bob's Agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=bob.id,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    headers = {"Authorization": f"Bearer {seed['token']}"}
    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers=headers,
        json={"peer_id": "ag_bob01234567", "message": "hey"},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "queued_for_approval"
    assert body["approval_id"]

    queue_row = await db_session.execute(select(AgentApprovalQueue))
    entries = list(queue_row.scalars().all())
    assert len(entries) == 1
    assert entries[0].kind == ApprovalKind.contact_request
    assert entries[0].state == ApprovalState.pending
    assert entries[0].owner_user_id == bob.id


@pytest.mark.asyncio
async def test_bob_approves_then_contacts_appear(client, seed, db_session: AsyncSession):
    # Bob + Agent (claimed), then Alice requests contact, then Bob approves.
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()
    db_session.add(
        Agent(
            agent_id="ag_bob01234567",
            display_name="Bob's Agent",
            message_policy=MessagePolicy.contacts_only,
            user_id=bob.id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    alice_headers = {"Authorization": f"Bearer {seed['token']}"}
    enq = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": "ag_bob01234567"},
    )
    approval_id = enq.json()["approval_id"]

    # Bob sees it in his pending list
    bob_token = _token(str(bob_supa))
    bob_headers = {"Authorization": f"Bearer {bob_token}"}

    listing = await client.get("/api/humans/me/pending-approvals", headers=bob_headers)
    assert listing.status_code == 200
    approvals = listing.json()["approvals"]
    assert len(approvals) == 1
    assert approvals[0]["id"] == approval_id
    assert approvals[0]["kind"] == "contact_request"

    # Alice cannot resolve Bob's approval
    wrong = await client.post(
        f"/api/humans/me/pending-approvals/{approval_id}/resolve",
        headers=alice_headers,
        json={"decision": "approve"},
    )
    assert wrong.status_code == 403

    # Bob approves
    resolve = await client.post(
        f"/api/humans/me/pending-approvals/{approval_id}/resolve",
        headers=bob_headers,
        json={"decision": "approve"},
    )
    assert resolve.status_code == 200
    assert resolve.json()["state"] == "approved"

    # Both sides of Contact materialised
    contacts_all = await db_session.execute(select(Contact))
    rows = list(contacts_all.scalars().all())
    pairs = {(c.owner_id, c.contact_agent_id) for c in rows}
    assert ("ag_bob01234567", seed["human_id"]) in pairs
    assert (seed["human_id"], "ag_bob01234567") in pairs

    # Second resolve returns 409
    again = await client.post(
        f"/api/humans/me/pending-approvals/{approval_id}/resolve",
        headers=bob_headers,
        json={"decision": "approve"},
    )
    assert again.status_code == 409


@pytest.mark.asyncio
async def test_reject_does_not_create_contacts(client, seed, db_session: AsyncSession):
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()
    db_session.add(
        Agent(
            agent_id="ag_bob01234567",
            display_name="Bob's Agent",
            message_policy=MessagePolicy.contacts_only,
            user_id=bob.id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    alice_headers = {"Authorization": f"Bearer {seed['token']}"}
    enq = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": "ag_bob01234567"},
    )
    approval_id = enq.json()["approval_id"]

    bob_headers = {"Authorization": f"Bearer {_token(str(bob_supa))}"}
    resolve = await client.post(
        f"/api/humans/me/pending-approvals/{approval_id}/resolve",
        headers=bob_headers,
        json={"decision": "reject"},
    )
    assert resolve.status_code == 200
    assert resolve.json()["state"] == "rejected"

    contacts_all = await db_session.execute(select(Contact))
    assert list(contacts_all.scalars().all()) == []


# ---------------------------------------------------------------------------
# Contact request → unclaimed Agent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contact_request_to_unclaimed_agent_is_direct(
    client, seed, db_session: AsyncSession
):
    db_session.add(
        Agent(
            agent_id="ag_loose00001",
            display_name="Loose",
            message_policy=MessagePolicy.open,
            user_id=None,
            claimed_at=None,
        )
    )
    await db_session.commit()

    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": "ag_loose00001"},
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "requested"

    # No approval queued
    assert list(
        (await db_session.execute(select(AgentApprovalQueue))).scalars().all()
    ) == []

    # ContactRequest row exists with from_type='human'
    reqs = list((await db_session.execute(select(ContactRequest))).scalars().all())
    assert len(reqs) == 1
    assert reqs[0].from_type == ParticipantType.human
    assert reqs[0].to_type == ParticipantType.agent
    assert reqs[0].state == ContactRequestState.pending


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_self_contact_rejected(client, seed):
    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": seed["human_id"]},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_bad_peer_prefix_rejected(client, seed):
    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": "xxx"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# crypto short-circuit for hu_* sender
# ---------------------------------------------------------------------------


def test_verify_envelope_sig_short_circuits_for_human():
    from hub.crypto import verify_envelope_sig
    from hub.schemas import MessageEnvelope, Signature

    env = MessageEnvelope(
        v="a2a/0.1",
        msg_id=str(uuid.uuid4()),
        ts=int(datetime.datetime.now().timestamp()),
        **{"from": "hu_abcd12345678"},
        to="rm_room00000001",
        type="message",
        ttl_sec=60,
        payload={"text": "hi"},
        payload_hash="sha256:0",
        sig=Signature(alg="ed25519", key_id="dashboard", value=""),
    )
    # pubkey is ignored when sender is Human
    assert verify_envelope_sig(env, "") is True

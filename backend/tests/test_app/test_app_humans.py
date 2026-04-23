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

import base64
import datetime
import hashlib
import time
import uuid
from unittest.mock import AsyncMock

import jcs
from nacl.signing import SigningKey

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import RoomJoinPolicy, RoomVisibility
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


# ---------------------------------------------------------------------------
# Mixed ag_/hu_ member_ids on room creation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_room_with_mixed_participant_types(
    client, seed, db_session: AsyncSession
):
    """POST /api/humans/me/rooms must branch on the id prefix and stamp
    participant_type accordingly for every initial member."""
    # Seed a second Human (Bob) + an Agent.
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()
    bob_human_id = bob.human_id

    db_session.add(
        Agent(
            agent_id="ag_tool00001",
            display_name="Helper",
            message_policy=MessagePolicy.open,
            user_id=None,
        )
    )
    await db_session.commit()

    headers = {"Authorization": f"Bearer {seed['token']}"}
    resp = await client.post(
        "/api/humans/me/rooms",
        headers=headers,
        json={
            "name": "Mixed Room",
            "member_ids": [
                "ag_tool00001",
                bob_human_id,
                # Duplicate the creator's own id — must be skipped.
                seed["human_id"],
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    room_id = resp.json()["room_id"]

    rows = await db_session.execute(
        select(RoomMember).where(RoomMember.room_id == room_id)
    )
    members = {m.agent_id: m for m in rows.scalars().all()}
    assert set(members.keys()) == {seed["human_id"], "ag_tool00001", bob_human_id}
    assert members[seed["human_id"]].participant_type == ParticipantType.human
    assert members[seed["human_id"]].role == RoomRole.owner
    assert members["ag_tool00001"].participant_type == ParticipantType.agent
    assert members[bob_human_id].participant_type == ParticipantType.human


@pytest.mark.asyncio
async def test_create_room_rejects_unknown_prefix(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    resp = await client.post(
        "/api/humans/me/rooms",
        headers=headers,
        json={"name": "Bad", "member_ids": ["xx_something"]},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/humans/me/rooms/{room_id}/members
# ---------------------------------------------------------------------------


async def _create_room_as(client: AsyncClient, token: str, name: str = "Room") -> str:
    resp = await client.post(
        "/api/humans/me/rooms",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": name},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["room_id"]


@pytest.mark.asyncio
async def test_invite_agent_via_members_endpoint(
    client, seed, db_session: AsyncSession
):
    # Seed an unclaimed agent so the invite is direct (no approval queue).
    db_session.add(
        Agent(
            agent_id="ag_tool00001",
            display_name="Helper",
            message_policy=MessagePolicy.open,
            user_id=None,
        )
    )
    await db_session.commit()

    room_id = await _create_room_as(client, seed["token"], "Agent invite room")
    resp = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": "ag_tool00001"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["room_id"] == room_id
    assert body["participant_id"] == "ag_tool00001"
    assert body["participant_type"] == "agent"
    assert body["role"] == "member"

    # DB check
    row = await db_session.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == "ag_tool00001",
        )
    )
    m = row.scalar_one()
    assert m.participant_type == ParticipantType.agent


@pytest.mark.asyncio
async def test_invite_human_via_members_endpoint(
    client, seed, db_session: AsyncSession
):
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.commit()
    bob_human_id = bob.human_id

    room_id = await _create_room_as(client, seed["token"], "Human invite room")
    resp = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": bob_human_id, "role": "admin"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["participant_type"] == "human"
    assert body["role"] == "admin"

    row = await db_session.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == bob_human_id,
        )
    )
    m = row.scalar_one()
    assert m.participant_type == ParticipantType.human
    assert m.role == RoomRole.admin


@pytest.mark.asyncio
async def test_invite_members_endpoint_requires_owner_or_admin(
    client, seed, db_session: AsyncSession
):
    """A Human who is a plain member (not owner/admin) cannot invite."""
    # Carol (room owner) + Alice (seed user, non-member).
    carol_supa = uuid.uuid4()
    carol = User(supabase_user_id=carol_supa, display_name="Carol")
    db_session.add(carol)
    await db_session.commit()
    carol_human_id = carol.human_id

    # Carol creates the room and adds Alice as a plain member.
    carol_token = _token(str(carol_supa))
    room_id = await _create_room_as(client, carol_token, "Carol's salon")

    db_session.add(
        RoomMember(
            room_id=room_id,
            agent_id=seed["human_id"],
            participant_type=ParticipantType.human,
            role=RoomRole.member,
        )
    )
    # And a target agent for Alice to attempt to invite.
    db_session.add(
        Agent(
            agent_id="ag_target0001",
            display_name="Target",
            message_policy=MessagePolicy.open,
            user_id=None,
        )
    )
    await db_session.commit()

    resp = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": "ag_target0001"},
    )
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_invite_members_endpoint_rejects_bad_prefix(client, seed):
    room_id = await _create_room_as(client, seed["token"])
    resp = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": "bogus"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_invite_members_endpoint_409_on_duplicate(
    client, seed, db_session: AsyncSession
):
    db_session.add(
        Agent(
            agent_id="ag_dup0000001",
            display_name="Dup",
            message_policy=MessagePolicy.open,
            user_id=None,
        )
    )
    await db_session.commit()

    room_id = await _create_room_as(client, seed["token"])
    # First invite succeeds
    r1 = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": "ag_dup0000001"},
    )
    assert r1.status_code == 201
    # Second invite collides
    r2 = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"participant_id": "ag_dup0000001"},
    )
    assert r2.status_code == 409


# ---------------------------------------------------------------------------
# Contact requests (Human-side accept/reject + listings)
# ---------------------------------------------------------------------------


async def _seed_second_human(db_session: AsyncSession, display_name: str = "Bob") -> tuple[uuid.UUID, str, str]:
    supa = uuid.uuid4()
    u = User(supabase_user_id=supa, display_name=display_name)
    db_session.add(u)
    await db_session.commit()
    await db_session.refresh(u)
    return u.id, u.human_id, _token(str(supa))


@pytest.mark.asyncio
async def test_h2h_request_received_listing(
    client, seed, db_session: AsyncSession
):
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    # Alice requests contact with Bob directly via the existing endpoint.
    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id, "message": "hi"},
    )
    assert resp.status_code == 202
    assert resp.json()["status"] == "requested"

    # Bob sees it in received.
    received = await client.get(
        "/api/humans/me/contact-requests/received",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert received.status_code == 200
    reqs = received.json()["requests"]
    assert len(reqs) == 1
    assert reqs[0]["from_participant_id"] == seed["human_id"]
    assert reqs[0]["from_type"] == "human"
    assert reqs[0]["to_type"] == "human"
    assert reqs[0]["message"] == "hi"
    # Display-name resolution: Alice's User row.
    assert reqs[0]["from_display_name"] == "Alice"
    assert reqs[0]["to_display_name"] == "Bob"

    # Alice sees the same request in sent.
    sent = await client.get(
        "/api/humans/me/contact-requests/sent",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert sent.status_code == 200
    sent_rows = sent.json()["requests"]
    assert len(sent_rows) == 1
    assert sent_rows[0]["to_participant_id"] == bob_human_id


@pytest.mark.asyncio
async def test_h2h_accept_creates_mutual_contacts(
    client, seed, db_session: AsyncSession
):
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    resp = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id},
    )
    assert resp.status_code == 202

    # Bob inspects the pending request and finds its id from the listing.
    received = await client.get(
        "/api/humans/me/contact-requests/received",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    req_id = received.json()["requests"][0]["id"]

    # Bob accepts.
    accept = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/accept",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert accept.status_code == 200
    assert accept.json()["state"] == "accepted"

    # Both Contact rows materialised with correct polymorphic types.
    rows = list(
        (await db_session.execute(select(Contact))).scalars().all()
    )
    by_owner = {(c.owner_id, c.contact_agent_id): c for c in rows}
    bob_side = by_owner[(bob_human_id, seed["human_id"])]
    alice_side = by_owner[(seed["human_id"], bob_human_id)]
    assert bob_side.owner_type == ParticipantType.human
    assert bob_side.peer_type == ParticipantType.human
    assert alice_side.owner_type == ParticipantType.human
    assert alice_side.peer_type == ParticipantType.human

    # Second accept → 409
    again = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/accept",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert again.status_code == 409


@pytest.mark.asyncio
async def test_h2h_request_surfaces_in_pending_approvals(
    client, seed, db_session: AsyncSession
):
    """Human → Human contact requests must merge into /me/pending-approvals so
    the recipient only needs to poll a single endpoint, and resolve via the
    same surface must materialise mutual Contact rows."""
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    send = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id, "message": "ping"},
    )
    assert send.status_code == 202
    assert send.json()["status"] == "requested"

    listing = await client.get(
        "/api/humans/me/pending-approvals",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert listing.status_code == 200
    approvals = listing.json()["approvals"]
    assert len(approvals) == 1
    entry = approvals[0]
    assert entry["id"].startswith("cr_")
    assert entry["kind"] == "contact_request"
    assert entry["agent_id"] == bob_human_id
    assert entry["payload"]["from_participant_id"] == seed["human_id"]
    assert entry["payload"]["from_type"] == "human"
    assert entry["payload"]["from_display_name"] == "Alice"
    assert entry["payload"]["message"] == "ping"

    # Alice cannot resolve Bob's approval.
    wrong = await client.post(
        f"/api/humans/me/pending-approvals/{entry['id']}/resolve",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"decision": "approve"},
    )
    assert wrong.status_code == 403

    approve = await client.post(
        f"/api/humans/me/pending-approvals/{entry['id']}/resolve",
        headers={"Authorization": f"Bearer {bob_token}"},
        json={"decision": "approve"},
    )
    assert approve.status_code == 200
    assert approve.json()["state"] == "approved"

    rows = list((await db_session.execute(select(Contact))).scalars().all())
    pairs = {(c.owner_id, c.contact_agent_id) for c in rows}
    assert (bob_human_id, seed["human_id"]) in pairs
    assert (seed["human_id"], bob_human_id) in pairs

    # Second resolve → 409 on the merged surface.
    again = await client.post(
        f"/api/humans/me/pending-approvals/{entry['id']}/resolve",
        headers={"Authorization": f"Bearer {bob_token}"},
        json={"decision": "approve"},
    )
    assert again.status_code == 409

    # And the listing is now empty.
    empty = await client.get(
        "/api/humans/me/pending-approvals",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert empty.json()["approvals"] == []


@pytest.mark.asyncio
async def test_h2h_reject_via_pending_approvals_does_not_create_contacts(
    client, seed, db_session: AsyncSession
):
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id},
    )
    listing = await client.get(
        "/api/humans/me/pending-approvals",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    cr_id = listing.json()["approvals"][0]["id"]

    reject = await client.post(
        f"/api/humans/me/pending-approvals/{cr_id}/resolve",
        headers={"Authorization": f"Bearer {bob_token}"},
        json={"decision": "reject"},
    )
    assert reject.status_code == 200
    assert reject.json()["state"] == "rejected"

    rows = list((await db_session.execute(select(Contact))).scalars().all())
    assert rows == []


@pytest.mark.asyncio
async def test_h2a_accept_creates_mutual_contacts_with_correct_types(
    client, seed, db_session: AsyncSession
):
    """Human ← Agent contact request. Accept must stamp the peer_type pair
    (agent, human) / (human, agent) on the two mirror Contact rows."""
    # Seed an unclaimed Agent that will initiate the request.
    db_session.add(
        Agent(
            agent_id="ag_init00001",
            display_name="Initiator",
            message_policy=MessagePolicy.open,
            user_id=None,
        )
    )
    # Directly insert the ContactRequest row — simulating an agent-initiated
    # request, which would normally land via /hub/send contact_request.
    req = ContactRequest(
        from_agent_id="ag_init00001",
        from_type=ParticipantType.agent,
        to_agent_id=seed["human_id"],
        to_type=ParticipantType.human,
        state=ContactRequestState.pending,
        message="hi human",
    )
    db_session.add(req)
    await db_session.commit()
    await db_session.refresh(req)
    req_id = req.id

    # Human accepts via the new endpoint.
    accept = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/accept",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert accept.status_code == 200, accept.text
    assert accept.json()["state"] == "accepted"

    rows = list(
        (await db_session.execute(select(Contact))).scalars().all()
    )
    pairs = {
        (c.owner_id, c.owner_type, c.contact_agent_id, c.peer_type) for c in rows
    }
    assert (
        seed["human_id"],
        ParticipantType.human,
        "ag_init00001",
        ParticipantType.agent,
    ) in pairs
    assert (
        "ag_init00001",
        ParticipantType.agent,
        seed["human_id"],
        ParticipantType.human,
    ) in pairs


@pytest.mark.asyncio
async def test_reject_transitions_state_only(
    client, seed, db_session: AsyncSession
):
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id},
    )
    received = await client.get(
        "/api/humans/me/contact-requests/received",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    req_id = received.json()["requests"][0]["id"]

    reject = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/reject",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert reject.status_code == 200
    assert reject.json()["state"] == "rejected"

    contacts = list((await db_session.execute(select(Contact))).scalars().all())
    assert contacts == []

    rows = list((await db_session.execute(select(ContactRequest))).scalars().all())
    assert len(rows) == 1
    assert rows[0].state == ContactRequestState.rejected

    # Second resolve → 409
    again = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/reject",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert again.status_code == 409


@pytest.mark.asyncio
async def test_non_recipient_cannot_accept_request(
    client, seed, db_session: AsyncSession
):
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")
    _, _, carol_token = await _seed_second_human(db_session, "Carol")

    await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id},
    )
    received = await client.get(
        "/api/humans/me/contact-requests/received",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    req_id = received.json()["requests"][0]["id"]

    # Carol (unrelated) tries to accept → 403.
    resp = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/accept",
        headers={"Authorization": f"Bearer {carol_token}"},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# W-R2-1: Symmetric duplicate-check semantics on /me/contacts/request
# (parity with app/routers/dashboard.py::send_contact_request)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_h2h_resend_after_reject_reuses_row(
    client, seed, db_session: AsyncSession
):
    """After Bob rejects Alice's H2H request, Alice can resend and the same
    ContactRequest row flips back to ``pending`` (no duplicate row)."""
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")
    alice_headers = {"Authorization": f"Bearer {seed['token']}"}

    # 1) Alice → Bob
    r1 = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": bob_human_id, "message": "first try"},
    )
    assert r1.status_code == 202
    assert r1.json()["status"] == "requested"

    # 2) Bob rejects.
    received = await client.get(
        "/api/humans/me/contact-requests/received",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    req_id = received.json()["requests"][0]["id"]
    rej = await client.post(
        f"/api/humans/me/contact-requests/{req_id}/reject",
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert rej.status_code == 200

    # 3) Alice resends — must succeed with the same underlying row.
    r2 = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": bob_human_id, "message": "second try"},
    )
    assert r2.status_code == 202, r2.text
    assert r2.json()["status"] == "requested"
    assert r2.json()["request_id"] == req_id

    # Exactly one ContactRequest row exists, now pending again with
    # the latest message attached.
    rows = list((await db_session.execute(select(ContactRequest))).scalars().all())
    assert len(rows) == 1
    assert rows[0].state == ContactRequestState.pending
    assert rows[0].message == "second try"


@pytest.mark.asyncio
async def test_h2h_reverse_pending_hints_accept_incoming(
    client, seed, db_session: AsyncSession
):
    """If Bob has already sent Alice a pending H2H request, Alice sending
    the mirror request back must 409 with the 'accept incoming' hint
    instead of silently creating a second row."""
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    # Bob → Alice first.
    r1 = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {bob_token}"},
        json={"peer_id": seed["human_id"]},
    )
    assert r1.status_code == 202
    assert r1.json()["status"] == "requested"

    # Alice → Bob should now hit the reverse-pending branch.
    r2 = await client.post(
        "/api/humans/me/contacts/request",
        headers={"Authorization": f"Bearer {seed['token']}"},
        json={"peer_id": bob_human_id},
    )
    assert r2.status_code == 409, r2.text
    assert "accept" in r2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_h2h_duplicate_pending_returns_already_requested(
    client, seed, db_session: AsyncSession
):
    """Alice → Bob twice in a row while the first is still pending must
    short-circuit with ``already_requested`` (no IntegrityError path)."""
    _, bob_human_id, _ = await _seed_second_human(db_session, "Bob")
    alice_headers = {"Authorization": f"Bearer {seed['token']}"}

    r1 = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": bob_human_id},
    )
    assert r1.status_code == 202
    assert r1.json()["status"] == "requested"

    r2 = await client.post(
        "/api/humans/me/contacts/request",
        headers=alice_headers,
        json={"peer_id": bob_human_id},
    )
    assert r2.status_code == 202
    assert r2.json()["status"] == "already_requested"

    rows = list((await db_session.execute(select(ContactRequest))).scalars().all())
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# W-R2-2: Subscription-gated room admits the Human owner
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sub_gated_room_admits_human_owner_exempt(
    client, seed, db_session: AsyncSession
):
    """In a Human-owned sub-gated room, the owner is exempt from the
    subscription check. Other Humans are still blocked with a clear
    'humans not yet supported' 403.

    Construction: Alice owns a sub-gated room; Bob is a co-admin. Bob tries
    to re-add Alice (the owner) to the room — this is the only realistic
    path to exercise the owner-exempt branch without the earlier self-invite
    short-circuit. We first remove Alice's member row to simulate an edge
    re-entry scenario; the sub-gate check must let her back in.
    """
    alice_human_id = seed["human_id"]
    _, bob_human_id, bob_token = await _seed_second_human(db_session, "Bob")

    room_id = "rm_subgate0001"
    db_session.add(
        Room(
            room_id=room_id,
            name="Sub Gate",
            description="",
            owner_id=alice_human_id,
            owner_type=ParticipantType.human,
            visibility=RoomVisibility.private,
            join_policy=RoomJoinPolicy.invite_only,
            required_subscription_product_id="sp_fakeproduct",
        )
    )
    db_session.add(
        RoomMember(
            room_id=room_id,
            agent_id=bob_human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.admin,
        )
    )
    await db_session.commit()

    bob_headers = {"Authorization": f"Bearer {bob_token}"}

    # Case A: Bob (admin) tries to invite a third Human → blocked by sub-gate
    # with the human-limitation message.
    _, carol_human_id, _ = await _seed_second_human(db_session, "Carol")
    bad = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers=bob_headers,
        json={"participant_id": carol_human_id},
    )
    assert bad.status_code == 403, bad.text
    assert "subscription" in bad.json()["detail"].lower()

    # Case B: Bob invites Alice (the room's Human owner). She has no
    # AgentSubscription row, but the owner-exempt branch must let her
    # through the sub-gate and succeed with 201.
    ok = await client.post(
        f"/api/humans/me/rooms/{room_id}/members",
        headers=bob_headers,
        json={"participant_id": alice_human_id},
    )
    assert ok.status_code == 201, ok.text
    body = ok.json()
    assert body["participant_id"] == alice_human_id
    assert body["participant_type"] == "human"


# ---------------------------------------------------------------------------
# crypto short-circuit
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


# ---------------------------------------------------------------------------
# A2A helpers for test_a2a_contact_request_approval_creates_correct_contacts
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify_agent(
    client: AsyncClient,
    sk: SigningKey,
    pubkey_str: str,
    display_name: str,
    db: AsyncSession | None = None,
) -> tuple[str, str, str]:
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": "test"},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    agent_id, key_id, challenge = data["agent_id"], data["key_id"], data["challenge"]
    sig_b64 = base64.b64encode(
        sk.sign(base64.b64decode(challenge)).signature
    ).decode()
    resp2 = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp2.status_code == 200, resp2.text
    # /hub/send requires claimed_at to be set — mark the agent as self-claimed
    if db is not None:
        result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
        agent = result.scalar_one()
        agent.claimed_at = datetime.datetime.now(datetime.timezone.utc)
        await db.commit()
    return agent_id, key_id, resp2.json()["agent_token"]


def _build_contact_request_envelope(
    sk: SigningKey, key_id: str, from_id: str, to_id: str, message: str = ""
) -> dict:
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    payload = {"message": message}
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        "contact_request", "", "3600", payload_hash,
    ]
    sig_b64 = base64.b64encode(
        sk.sign("\n".join(parts).encode()).signature
    ).decode()
    return {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": ts,
        "from": from_id, "to": to_id, "type": "contact_request",
        "reply_to": None, "ttl_sec": 3600,
        "payload": payload, "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


# ---------------------------------------------------------------------------
# A2A contact_request → approval queue → approve → peer_type=agent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a2a_contact_request_approval_creates_correct_contacts(
    client, seed, db_session: AsyncSession
):
    """A2A contact_request to a claimed agent: approve → Contact rows have peer_type=agent."""
    bob_supa = uuid.uuid4()
    bob = User(supabase_user_id=bob_supa, display_name="Bob")
    db_session.add(bob)
    await db_session.flush()
    db_session.add(
        Agent(
            agent_id="ag_claimed01234",
            display_name="Claimed",
            message_policy=MessagePolicy.contacts_only,
            user_id=bob.id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    sk, pub = _make_keypair()
    ext_id, ext_key, ext_token = await _register_and_verify_agent(
        client, sk, pub, "external", db=db_session
    )

    env = _build_contact_request_envelope(sk, ext_key, ext_id, "ag_claimed01234", "hello")
    resp = await client.post(
        "/hub/send",
        json=env,
        headers={"Authorization": f"Bearer {ext_token}"},
    )
    assert resp.status_code in (200, 202), resp.text

    queue = await db_session.execute(
        select(AgentApprovalQueue).where(AgentApprovalQueue.agent_id == "ag_claimed01234")
    )
    entries = list(queue.scalars().all())
    assert len(entries) == 1, "Expected exactly one approval queue entry"
    entry = entries[0]
    assert entry.kind == ApprovalKind.contact_request
    assert entry.state == ApprovalState.pending
    assert entry.owner_user_id == bob.id

    bob_headers = {"Authorization": f"Bearer {_token(str(bob_supa))}"}
    resolve = await client.post(
        f"/api/humans/me/pending-approvals/{entry.id}/resolve",
        headers=bob_headers,
        json={"decision": "approve"},
    )
    assert resolve.status_code == 200, resolve.text
    assert resolve.json()["state"] == "approved"

    contacts = await db_session.execute(select(Contact))
    rows = {
        (c.owner_id, c.contact_agent_id, c.peer_type)
        for c in contacts.scalars().all()
    }
    assert ("ag_claimed01234", ext_id, ParticipantType.agent) in rows, \
        f"claimed→ext contact must have peer_type=agent; got rows={rows}"
    assert (ext_id, "ag_claimed01234", ParticipantType.agent) in rows, \
        f"ext→claimed contact must have peer_type=agent; got rows={rows}"

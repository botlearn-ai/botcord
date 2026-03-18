"""Tests for unified Room management, room message fan-out, DM rooms, and topic support."""

import base64
import hashlib
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock, patch

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
async def client(db_session: AsyncSession):
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(
    client: AsyncClient, sk: SigningKey, pubkey_str: str, display_name: str = "test-agent"
):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": "test agent"},
    )
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()

    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200
    token = resp.json()["agent_token"]
    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_agent(client: AsyncClient, name: str = "agent"):
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    # Set open policy
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    return sk, agent_id, key_id, token


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    reply_to: str | None = None,
    ttl_sec: int = 3600,
    payload: dict | None = None,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, reply_to or "", str(ttl_sec), payload_hash,
    ]
    signing_input = "\n".join(parts).encode()
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()

    return {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": from_id,
        "to": to_id,
        "type": msg_type,
        "reply_to": reply_to,
        "ttl_sec": ttl_sec,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


# ===========================================================================
# Room CRUD tests
# ===========================================================================


@pytest.mark.asyncio
async def test_create_group_like_room(client: AsyncClient):
    """Create a room with default_send=True (group-like)."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "My Group", "default_send": True},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["room_id"].startswith("rm_")
    assert data["name"] == "My Group"
    assert data["owner_id"] == agent_id
    assert data["default_send"] is True
    assert data["visibility"] == "private"
    assert data["join_policy"] == "invite_only"
    assert data["member_count"] == 1
    assert len(data["members"]) == 1
    assert data["members"][0]["role"] == "owner"


@pytest.mark.asyncio
async def test_create_channel_like_room(client: AsyncClient):
    """Create a room with default_send=False (channel-like)."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "My Channel",
            "default_send": False,
            "visibility": "public",
            "join_policy": "open",
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["default_send"] is False
    assert data["visibility"] == "public"
    assert data["join_policy"] == "open"


@pytest.mark.asyncio
async def test_create_room_with_initial_members(client: AsyncClient):
    """Create a room with initial members."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "charlie")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "Team Room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["member_count"] == 3
    member_ids = {m["agent_id"] for m in data["members"]}
    assert member_ids == {a_id, b_id, c_id}


@pytest.mark.asyncio
async def test_create_room_invalid_member(client: AsyncClient):
    """Creating a room with non-existent member_ids fails."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "Bad Room", "member_ids": ["ag_nonexistent"]},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_get_room(client: AsyncClient):
    """Get room details as a member."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "My Room"},
        headers=_auth_header(token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.get(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["room_id"] == room_id


@pytest.mark.asyncio
async def test_get_room_non_member(client: AsyncClient):
    """Non-member cannot view room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Private Room"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.get(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_update_room(client: AsyncClient):
    """Owner/admin can update room info."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Old Name"},
        headers=_auth_header(token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"name": "New Name", "description": "Updated"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"
    assert resp.json()["description"] == "Updated"


@pytest.mark.asyncio
async def test_room_rule_roundtrip_and_clear(client: AsyncClient):
    """Room rule is persisted, listed, and can be cleared."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Rule Room", "rule": "  Follow the runbook.  ", "visibility": "public"},
        headers=_auth_header(token),
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    room_id = created["room_id"]
    assert created["rule"] == "Follow the runbook."

    get_resp = await client.get(f"/hub/rooms/{room_id}", headers=_auth_header(token))
    assert get_resp.status_code == 200
    assert get_resp.json()["rule"] == "Follow the runbook."

    list_resp = await client.get("/hub/rooms/me", headers=_auth_header(token))
    assert list_resp.status_code == 200
    listed = next(r for r in list_resp.json()["rooms"] if r["room_id"] == room_id)
    assert listed["rule"] == "Follow the runbook."

    discover_resp = await client.get("/hub/rooms", params={"name": "Rule"}, headers=_auth_header(token))
    assert discover_resp.status_code == 200
    assert discover_resp.json()["rooms"][0]["rule"] == "Follow the runbook."

    update_resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"rule": "Only incident updates."},
        headers=_auth_header(token),
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["rule"] == "Only incident updates."

    clear_resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"rule": "   "},
        headers=_auth_header(token),
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["rule"] is None


@pytest.mark.asyncio
async def test_dissolve_room(client: AsyncClient):
    """Owner can dissolve a room."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Temp Room"},
        headers=_auth_header(token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Verify gone
    resp = await client.get(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_dissolve_room_non_owner(client: AsyncClient):
    """Non-owner cannot dissolve."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


# ===========================================================================
# Member management tests
# ===========================================================================


@pytest.mark.asyncio
async def test_admin_invite_member(client: AsyncClient):
    """Owner/admin can invite a new member."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    assert resp.json()["member_count"] == 2


@pytest.mark.asyncio
async def test_self_join_public_open(client: AsyncClient):
    """Self-join to a public + open room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Public Room", "visibility": "public", "join_policy": "open"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Bob self-joins (no body or agent_id=self)
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 201
    assert resp.json()["member_count"] == 2


@pytest.mark.asyncio
async def test_self_join_private_rejected(client: AsyncClient):
    """Self-join to a private room fails."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Private Room"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_self_join_invite_only_rejected(client: AsyncClient):
    """Self-join to a public + invite_only room fails."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Public Invite", "visibility": "public", "join_policy": "invite_only"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_remove_member(client: AsyncClient):
    """Owner can remove a member."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/{b_id}",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    assert resp.json()["member_count"] == 1


@pytest.mark.asyncio
async def test_remove_owner_rejected(client: AsyncClient):
    """Cannot remove the owner."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Promote bob to admin so he can try
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/{a_id}",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_leave_room(client: AsyncClient):
    """Non-owner can leave a room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/leave",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_leave_room_owner_rejected(client: AsyncClient):
    """Owner cannot leave."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/leave",
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_max_members_enforced(client: AsyncClient):
    """Room with max_members rejects adding beyond limit."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "charlie")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Small Room", "max_members": 2, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 400
    assert "full" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_duplicate_member(client: AsyncClient):
    """Adding an already-existing member returns 409."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 409


# ===========================================================================
# Role & ownership tests
# ===========================================================================


@pytest.mark.asyncio
async def test_transfer_ownership(client: AsyncClient):
    """Owner can transfer ownership to a member."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    assert resp.json()["owner_id"] == b_id


@pytest.mark.asyncio
async def test_transfer_non_owner_rejected(client: AsyncClient):
    """Non-owner cannot transfer."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": a_id},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_promote_to_admin(client: AsyncClient):
    """Owner can promote a member to admin."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    members = {m["agent_id"]: m["role"] for m in resp.json()["members"]}
    assert members[b_id] == "admin"


@pytest.mark.asyncio
async def test_demote_admin_to_member(client: AsyncClient):
    """Owner can demote an admin to member."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Promote first
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Demote
    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "member"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    members = {m["agent_id"]: m["role"] for m in resp.json()["members"]}
    assert members[b_id] == "member"


@pytest.mark.asyncio
async def test_promote_non_owner_rejected(client: AsyncClient):
    """Non-owner cannot promote."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "charlie")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": c_id, "role": "admin"},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_promote_owner_rejected(client: AsyncClient):
    """Cannot promote/demote the owner."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": a_id, "role": "member"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 400


# ===========================================================================
# Mute tests
# ===========================================================================


@pytest.mark.asyncio
async def test_mute_toggle(client: AsyncClient):
    """Member can toggle mute."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": True},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 200
    assert resp.json()["muted"] is True

    resp = await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": False},
        headers=_auth_header(b_token),
    )
    assert resp.json()["muted"] is False


@pytest.mark.asyncio
async def test_muted_member_skipped_in_fanout(client: AsyncClient):
    """Muted member does not receive fan-out messages."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "charlie")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Charlie mutes
    await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": True},
        headers=_auth_header(c_token),
    )

    # Alice sends to room
    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Bob should have messages, Charlie should not
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    charlie_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(c_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] >= 1
    assert charlie_inbox.json()["count"] == 0


# ===========================================================================
# Discovery tests
# ===========================================================================


@pytest.mark.asyncio
async def test_discover_public_rooms(client: AsyncClient):
    """Public rooms appear in discovery."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    await client.post(
        "/hub/rooms",
        json={"name": "Public Room", "visibility": "public"},
        headers=_auth_header(token),
    )
    await client.post(
        "/hub/rooms",
        json={"name": "Private Room"},
        headers=_auth_header(token),
    )

    resp = await client.get("/hub/rooms")
    assert resp.status_code == 200
    rooms = resp.json()["rooms"]
    assert len(rooms) == 1
    assert rooms[0]["name"] == "Public Room"


@pytest.mark.asyncio
async def test_discover_rooms_name_filter(client: AsyncClient):
    """Name filter works for discovery."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    await client.post(
        "/hub/rooms",
        json={"name": "Alpha", "visibility": "public"},
        headers=_auth_header(token),
    )
    await client.post(
        "/hub/rooms",
        json={"name": "Beta", "visibility": "public"},
        headers=_auth_header(token),
    )

    resp = await client.get("/hub/rooms", params={"name": "Alpha"})
    assert resp.status_code == 200
    assert len(resp.json()["rooms"]) == 1
    assert resp.json()["rooms"][0]["name"] == "Alpha"


@pytest.mark.asyncio
async def test_discover_excludes_private(client: AsyncClient):
    """Private rooms do not appear in discovery."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner")

    await client.post(
        "/hub/rooms",
        json={"name": "Secret", "visibility": "private"},
        headers=_auth_header(token),
    )

    resp = await client.get("/hub/rooms")
    assert resp.status_code == 200
    assert len(resp.json()["rooms"]) == 0


# ===========================================================================
# Room message fan-out tests
# ===========================================================================


@pytest.mark.asyncio
async def test_room_fanout_normal(client: AsyncClient):
    """Sending to a room fans out to all members except sender."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_room_fanout_non_member(client: AsyncClient):
    """Non-member cannot send to a room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_room_fanout_default_send_false(client: AsyncClient):
    """Member with default_send=False cannot send (channel-like)."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Broadcast", "default_send": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Bob (member) cannot send
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 403

    # Alice (owner) can send
    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_room_fanout_admin_can_send_when_default_send_false(client: AsyncClient):
    """Admin can send even when default_send=False."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Broadcast", "default_send": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Bob (admin) can now send
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_room_fanout_block_skips(client: AsyncClient):
    """Blocked members are skipped in fan-out."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Bob blocks Alice
    await client.post(
        f"/registry/agents/{b_id}/blocks",
        json={"blocked_agent_id": a_id},
        headers=_auth_header(b_token),
    )

    # Alice sends to room
    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Bob should not have messages
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 0


@pytest.mark.asyncio
async def test_room_not_found(client: AsyncClient):
    """Sending to a non-existent room → 404."""
    sk, agent_id, key_id, token = await _create_agent(client, "alice")

    envelope = _build_envelope(sk, key_id, agent_id, "rm_nonexistent")
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(token),
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_room_fanout_message_has_room_id(client: AsyncClient):
    """Fan-out messages have room_id set in inbox."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )

    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1
    assert bob_inbox.json()["messages"][0]["room_id"] == room_id


# ===========================================================================
# DM Room tests
# ===========================================================================


@pytest.mark.asyncio
async def test_dm_room_auto_created(client: AsyncClient):
    """Sending a direct message auto-creates a DM room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Check DM room exists in list
    rooms_resp = await client.get(
        "/hub/rooms/me", headers=_auth_header(a_token),
    )
    rooms = rooms_resp.json()["rooms"]
    dm_rooms = [r for r in rooms if r["room_id"].startswith("rm_dm_")]
    assert len(dm_rooms) == 1


@pytest.mark.asyncio
async def test_dm_room_idempotent(client: AsyncClient):
    """Sending multiple DM messages creates only one DM room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        for _ in range(3):
            envelope = _build_envelope(sk_a, a_key, a_id, b_id)
            await client.post(
                "/hub/send", json=envelope, headers=_auth_header(a_token),
            )

    rooms_resp = await client.get(
        "/hub/rooms/me", headers=_auth_header(a_token),
    )
    dm_rooms = [r for r in rooms_resp.json()["rooms"] if r["room_id"].startswith("rm_dm_")]
    assert len(dm_rooms) == 1


@pytest.mark.asyncio
async def test_dm_room_order_independent(client: AsyncClient):
    """DM room_id is the same regardless of who sends first."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Alice sends to Bob
    envelope1 = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope1, headers=_auth_header(a_token),
        )

    # Bob sends to Alice
    envelope2 = _build_envelope(sk_b, b_key, b_id, a_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope2, headers=_auth_header(b_token),
        )

    # Both should see the same single DM room
    a_rooms = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    b_rooms = await client.get("/hub/rooms/me", headers=_auth_header(b_token))
    a_dm = [r for r in a_rooms.json()["rooms"] if r["room_id"].startswith("rm_dm_")]
    b_dm = [r for r in b_rooms.json()["rooms"] if r["room_id"].startswith("rm_dm_")]
    assert len(a_dm) == 1
    assert len(b_dm) == 1
    assert a_dm[0]["room_id"] == b_dm[0]["room_id"]


@pytest.mark.asyncio
async def test_dm_room_id_format(client: AsyncClient):
    """DM room_id has format rm_dm_{sorted_id0}_{sorted_id1}."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )

    ids = sorted([a_id, b_id])
    expected = f"rm_dm_{ids[0]}_{ids[1]}"

    rooms_resp = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    dm_rooms = [r for r in rooms_resp.json()["rooms"] if r["room_id"].startswith("rm_dm_")]
    assert dm_rooms[0]["room_id"] == expected


@pytest.mark.asyncio
async def test_contact_request_no_dm_room(client: AsyncClient):
    """contact_request type messages do not create a DM room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(
        sk_a, a_key, a_id, b_id,
        msg_type="contact_request",
        payload={"message": "Hi, add me!"},
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # No DM room should exist
    rooms_resp = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    dm_rooms = [r for r in rooms_resp.json()["rooms"] if r["room_id"].startswith("rm_dm_")]
    assert len(dm_rooms) == 0


# ===========================================================================
# Topic tests
# ===========================================================================


@pytest.mark.asyncio
async def test_send_with_topic(client: AsyncClient):
    """Messages can be sent with a topic label."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send",
            json=envelope,
            headers=_auth_header(a_token),
            params={"topic": "design"},
        )
    assert resp.status_code == 202

    # Check inbox has topic
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1
    assert bob_inbox.json()["messages"][0]["topic"] == "design"


@pytest.mark.asyncio
async def test_history_topic_filter(client: AsyncClient):
    """History can be filtered by topic."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Send with topic "design"
    env1 = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env1, headers=_auth_header(a_token),
            params={"topic": "design"},
        )

    # Send without topic
    env2 = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env2, headers=_auth_header(a_token),
        )

    # Filter by topic
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"topic": "design"},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1
    assert resp.json()["messages"][0]["topic"] == "design"


@pytest.mark.asyncio
async def test_history_room_and_topic_combined(client: AsyncClient):
    """History can filter by both room_id and topic."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    env = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env, headers=_auth_header(a_token),
            params={"topic": "urgent"},
        )

    resp = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id, "topic": "urgent"},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1


@pytest.mark.asyncio
async def test_dm_topic(client: AsyncClient):
    """DM messages can also have topic."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
            params={"topic": "project-x"},
        )
    assert resp.status_code == 202

    # Check history
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"topic": "project-x"},
    )
    assert resp.json()["count"] == 1
    assert resp.json()["messages"][0]["topic"] == "project-x"


# ===========================================================================
# List rooms tests
# ===========================================================================


@pytest.mark.asyncio
async def test_list_my_rooms(client: AsyncClient):
    """Agent can list all rooms they belong to."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Create room 1
    await client.post(
        "/hub/rooms",
        json={"name": "Room 1"},
        headers=_auth_header(a_token),
    )
    # Create room 2 with both
    await client.post(
        "/hub/rooms",
        json={"name": "Room 2", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )

    resp = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    assert resp.status_code == 200
    assert len(resp.json()["rooms"]) == 2


@pytest.mark.asyncio
async def test_list_my_rooms_includes_dm(client: AsyncClient):
    """DM rooms appear in list."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Create a DM room by sending a message
    envelope = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )

    resp = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    rooms = resp.json()["rooms"]
    dm_rooms = [r for r in rooms if r["room_id"].startswith("rm_dm_")]
    assert len(dm_rooms) == 1


@pytest.mark.asyncio
async def test_list_my_rooms_includes_group_and_broadcast(client: AsyncClient):
    """Both group-like and broadcast-like rooms appear in list."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")

    # Group-like
    await client.post(
        "/hub/rooms",
        json={"name": "Group", "default_send": True},
        headers=_auth_header(a_token),
    )
    # Broadcast-like
    await client.post(
        "/hub/rooms",
        json={"name": "Broadcast", "default_send": False},
        headers=_auth_header(a_token),
    )

    resp = await client.get("/hub/rooms/me", headers=_auth_header(a_token))
    assert len(resp.json()["rooms"]) == 2


# ===========================================================================
# Inbox / History integration tests
# ===========================================================================


@pytest.mark.asyncio
async def test_inbox_room_id_filter(client: AsyncClient):
    """Inbox can be filtered by room_id."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    # Send room message
    env = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env, headers=_auth_header(a_token),
        )

    # Also send a DM so there are two messages
    dm_env = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=dm_env, headers=_auth_header(a_token),
        )

    # Filter inbox by room_id
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(b_token),
        params={"room_id": room_id, "ack": "false"},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1
    assert resp.json()["messages"][0]["room_id"] == room_id


@pytest.mark.asyncio
async def test_inbox_includes_room_rule_and_text_hint(client: AsyncClient):
    """Inbox exposes room_rule and renders a rule hint into flat text."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Ops Room",
            "rule": "Only post deploy status updates.",
            "member_ids": [b_id],
        },
        headers=_auth_header(a_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    env = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "deploy started"})
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        send_resp = await client.post("/hub/send", json=env, headers=_auth_header(a_token))
    assert send_resp.status_code == 202

    inbox = await client.get("/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"})
    assert inbox.status_code == 200
    assert inbox.json()["count"] == 1
    message = inbox.json()["messages"][0]
    assert message["room_id"] == room_id
    assert message["room_rule"] == "Only post deploy status updates."
    assert "[房间规则] Only post deploy status updates." in message["text"]


@pytest.mark.asyncio
async def test_history_room_id_in_response(client: AsyncClient):
    """History messages include room_id."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    env = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env, headers=_auth_header(a_token),
        )

    resp = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] >= 1
    for msg in resp.json()["messages"]:
        assert msg["room_id"] == room_id


@pytest.mark.asyncio
async def test_history_room_access_control(client: AsyncClient):
    """Non-member cannot query history for a room."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Private Room"},
        headers=_auth_header(a_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.get(
        "/hub/history",
        headers=_auth_header(b_token),
        params={"room_id": room_id},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_inbox_room_id_in_dm(client: AsyncClient):
    """DM messages have room_id set in inbox response."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )

    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1
    msg = bob_inbox.json()["messages"][0]
    assert msg["room_id"] is not None
    assert msg["room_id"].startswith("rm_dm_")


# ===========================================================================
# Additional edge-case tests
# ===========================================================================


@pytest.mark.asyncio
async def test_create_room_max_members_exceeded_at_creation(client: AsyncClient):
    """Creating a room where initial members exceed max_members → 400."""
    sk_a, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, _ = await _create_agent(client, "bob")
    _, c_id, _, _ = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "tiny", "max_members": 2, "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 400
    assert "max_members" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_room_creator_in_member_ids_deduped(client: AsyncClient):
    """If creator lists themselves in member_ids, they are not double-added."""
    sk_a, a_id, _, a_token = await _create_agent(client, "alice")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "dedup-test", "member_ids": [a_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["member_count"] == 1
    assert data["members"][0]["agent_id"] == a_id
    assert data["members"][0]["role"] == "owner"


@pytest.mark.asyncio
async def test_update_room_non_member_rejected(client: AsyncClient):
    """Non-member cannot update a room → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "private-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"name": "hacked"},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_update_room_member_rejected(client: AsyncClient):
    """Regular member cannot update a room → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"name": "renamed-by-member"},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403
    assert "Admin or owner" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_admin_can_update_room(client: AsyncClient):
    """Admin can update a room."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"name": "renamed-by-admin"},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "renamed-by-admin"


@pytest.mark.asyncio
async def test_admin_remove_admin_rejected(client: AsyncClient):
    """Only the owner can remove an admin. Another admin cannot."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote both to admin
    for aid in [b_id, c_id]:
        await client.post(
            f"/hub/rooms/{room_id}/promote",
            json={"agent_id": aid, "role": "admin"},
            headers=_auth_header(a_token),
        )

    # Bob (admin) tries to remove Carol (admin) → 403
    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/{c_id}",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403
    assert "owner" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_remove_nonexistent_member(client: AsyncClient):
    """Removing a non-existent member → 404."""
    _, a_id, _, a_token = await _create_agent(client, "alice")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/ag_nonexistent",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_leave_non_member_rejected(client: AsyncClient):
    """Non-member cannot leave a room → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/leave",
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_transfer_to_self_rejected(client: AsyncClient):
    """Owner cannot transfer ownership to themselves → 400."""
    _, a_id, _, a_token = await _create_agent(client, "alice")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": a_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 400
    assert "yourself" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_transfer_to_non_member_rejected(client: AsyncClient):
    """Cannot transfer ownership to a non-member → 404."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 404
    assert "not a member" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_promote_invalid_role(client: AsyncClient):
    """Promoting to an invalid role → 400."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "owner"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 422  # Pydantic rejects invalid role value


@pytest.mark.asyncio
async def test_promote_nonexistent_member(client: AsyncClient):
    """Promoting a non-member → 404."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, _ = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_dissolve_cascades_members(client: AsyncClient):
    """After dissolving a room, the room and its members are gone."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "doomed-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Room is gone
    resp = await client.get(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 404

    # Bob's room list doesn't include the dissolved room
    resp = await client.get(
        "/hub/rooms/me",
        headers=_auth_header(b_token),
    )
    room_ids = [r["room_id"] for r in resp.json()["rooms"]]
    assert room_id not in room_ids


@pytest.mark.asyncio
async def test_room_fanout_sender_excluded(client: AsyncClient):
    """Sender should not receive their own room message."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Bob should have the message
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1

    # Alice (sender) should NOT have the message
    alice_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(a_token), params={"ack": "false"},
    )
    assert alice_inbox.json()["count"] == 0


@pytest.mark.asyncio
async def test_room_fanout_multi_receiver(client: AsyncClient):
    """Fan-out delivers to all non-sender members."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")
    _, d_id, _, d_token = await _create_agent(client, "dave")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "group-room", "member_ids": [b_id, c_id, d_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # All three receivers should have the message
    for token in [b_token, c_token, d_token]:
        inbox = await client.get(
            "/hub/inbox", headers=_auth_header(token), params={"ack": "false"},
        )
        assert inbox.json()["count"] == 1
        assert inbox.json()["messages"][0]["room_id"] == room_id


@pytest.mark.asyncio
async def test_inbox_topic_filter(client: AsyncClient):
    """Inbox doesn't directly filter by topic, but topic is present in response."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Send two messages with different topics
    env1 = _build_envelope(sk_a, a_key, a_id, b_id)
    env2 = _build_envelope(sk_a, a_key, a_id, b_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env1, headers=_auth_header(a_token),
            params={"topic": "work"},
        )
        await client.post(
            "/hub/send", json=env2, headers=_auth_header(a_token),
            params={"topic": "casual"},
        )

    inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert inbox.json()["count"] == 2
    topics = {m["topic"] for m in inbox.json()["messages"]}
    assert topics == {"work", "casual"}


@pytest.mark.asyncio
async def test_get_nonexistent_room(client: AsyncClient):
    """Getting a non-existent room → 404."""
    _, a_id, _, a_token = await _create_agent(client, "alice")

    resp = await client.get(
        "/hub/rooms/rm_nonexistent",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_mute_non_member_rejected(client: AsyncClient):
    """Non-member cannot mute in a room → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": True},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_remove_admin(client: AsyncClient):
    """Owner can successfully remove an admin member."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Owner removes admin → success
    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/{b_id}",
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    member_ids = [m["agent_id"] for m in resp.json()["members"]]
    assert b_id not in member_ids


@pytest.mark.asyncio
async def test_transfer_old_owner_becomes_member(client: AsyncClient):
    """After transfer, the old owner becomes a regular member."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    members = {m["agent_id"]: m["role"] for m in resp.json()["members"]}
    assert members[b_id] == "owner"
    assert members[a_id] == "member"
    assert resp.json()["owner_id"] == b_id


# ===========================================================================
# Per-member can_send tests
# ===========================================================================


async def _create_agent_contacts_only(client: AsyncClient, name: str = "agent"):
    """Create an agent with contacts_only policy (the default)."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    # contacts_only is the server default, but set explicitly for clarity
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(token),
    )
    return sk, agent_id, key_id, token


@pytest.mark.asyncio
async def test_per_member_can_send_override_true(client: AsyncClient):
    """Member with can_send=True can send even in channel-like room (default_send=False)."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "channel", "default_send": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Set bob's can_send=True
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_send": True},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Bob can now send to the channel-like room
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_per_member_can_send_override_false(client: AsyncClient):
    """Member with can_send=False cannot send even in group-like room (default_send=True)."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "group", "default_send": True, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Set bob's can_send=False
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_send": False},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Bob should be denied
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_per_member_can_send_none_uses_default(client: AsyncClient):
    """Member with can_send=None falls back to room.default_send."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Channel-like: default_send=False
    resp = await client.post(
        "/hub/rooms",
        json={"name": "channel", "default_send": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob has can_send=None (default), so falls back to default_send=False
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_can_send_override_false(client: AsyncClient):
    """Admin with can_send=False is denied (per-member override beats admin default)."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "group", "default_send": True, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Set bob's can_send=False
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_send": False},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Admin with can_send=False → denied
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_send_always(client: AsyncClient):
    """Owner can always send — cannot be overridden by per-member permission."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "channel", "default_send": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Owner always can send even when default_send=False
    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_per_member_can_send_set_on_invite(client: AsyncClient):
    """can_send can be set when inviting a member."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "channel", "default_send": False},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Invite bob with can_send=True
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id, "can_send": True},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    bob_member = next(m for m in resp.json()["members"] if m["agent_id"] == b_id)
    assert bob_member["can_send"] is True

    # Bob can send despite default_send=False
    envelope = _build_envelope(sk_b, b_key, b_id, room_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(b_token),
        )
    assert resp.status_code == 202


# ===========================================================================
# Per-member can_invite tests
# ===========================================================================


@pytest.mark.asyncio
async def test_member_with_can_invite_true(client: AsyncClient):
    """Member with can_invite=True can invite others."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "default_invite": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Set bob's can_invite=True
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_invite": True},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Bob can now invite carol
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 201
    member_ids = [m["agent_id"] for m in resp.json()["members"]]
    assert c_id in member_ids


@pytest.mark.asyncio
async def test_member_without_invite_perm_denied(client: AsyncClient):
    """Member without can_invite permission cannot invite (default_invite=False)."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "default_invite": False, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob (member, default_invite=False, can_invite=None) tries to invite carol → denied
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403
    assert "invite permission" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_admin_can_invite_denied_by_override(client: AsyncClient):
    """Admin with can_invite=False cannot invite despite admin default."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Set bob's can_invite=False
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_invite": False},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200

    # Admin with can_invite=False → denied
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_default_invite_true_allows_member(client: AsyncClient):
    """When default_invite=True, regular members can invite."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "open-invite", "default_invite": True, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob (member, default_invite=True) can invite carol
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_owner_can_invite_always(client: AsyncClient):
    """Owner can always invite regardless of default_invite."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "locked-room", "default_invite": False},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Owner invites bob despite default_invite=False
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201


# ===========================================================================
# /permissions endpoint tests
# ===========================================================================


@pytest.mark.asyncio
async def test_permissions_set_and_reset(client: AsyncClient):
    """Owner can set and then reset (to None) member permissions."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Set permissions
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_send": False, "can_invite": True},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    bob = next(m for m in resp.json()["members"] if m["agent_id"] == b_id)
    assert bob["can_send"] is False
    assert bob["can_invite"] is True

    # Reset to None
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": b_id, "can_send": None, "can_invite": None},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    bob = next(m for m in resp.json()["members"] if m["agent_id"] == b_id)
    assert bob["can_send"] is None
    assert bob["can_invite"] is None


@pytest.mark.asyncio
async def test_permissions_non_admin_rejected(client: AsyncClient):
    """Regular member cannot set permissions → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob (member) tries to set carol's permissions → 403
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": c_id, "can_send": True},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_permissions_owner_target_rejected(client: AsyncClient):
    """Cannot modify owner's permissions → 400."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote bob to admin
    await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": b_id, "role": "admin"},
        headers=_auth_header(a_token),
    )

    # Admin tries to set owner's permissions → 400
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": a_id, "can_send": False},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 400
    assert "owner" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_permissions_admin_cannot_modify_admin(client: AsyncClient):
    """Admin cannot modify another admin's permissions → 403."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Promote both to admin
    for aid in [b_id, c_id]:
        await client.post(
            f"/hub/rooms/{room_id}/promote",
            json={"agent_id": aid, "role": "admin"},
            headers=_auth_header(a_token),
        )

    # Bob (admin) tries to modify carol (admin) → 403
    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"agent_id": c_id, "can_send": False},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 403
    assert "owner" in resp.json()["detail"].lower()


# ===========================================================================
# Admission policy tests
# ===========================================================================


@pytest.mark.asyncio
async def test_admission_contacts_only_invite_denied(client: AsyncClient):
    """Cannot invite contacts_only agent if inviter is not in their contacts."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    # Bob has contacts_only policy
    _, b_id, _, b_token = await _create_agent_contacts_only(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Alice invites bob (contacts_only, not in alice's contacts) → denied
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 403
    assert "admission denied" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_admission_contacts_only_invite_allowed(client: AsyncClient):
    """Can invite contacts_only agent if inviter IS in their contacts."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    # Bob has contacts_only policy
    sk_b, b_id, b_key, b_token = await _create_agent_contacts_only(client, "bob")

    # Create mutual contact: alice sends contact_request to bob, bob accepts
    envelope = _build_envelope(sk_a, a_key, a_id, b_id, msg_type="contact_request", payload={"message": "hi"})
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    # Bob accepts the contact request
    resp = await client.get(
        f"/registry/agents/{b_id}/contact-requests/received",
        headers=_auth_header(b_token),
    )
    requests = resp.json()["requests"]
    assert len(requests) == 1
    request_id = requests[0]["id"]

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            f"/registry/agents/{b_id}/contact-requests/{request_id}/accept",
            headers=_auth_header(b_token),
        )
    assert resp.status_code == 200

    # Now alice can invite bob
    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    member_ids = [m["agent_id"] for m in resp.json()["members"]]
    assert b_id in member_ids


@pytest.mark.asyncio
async def test_admission_open_policy_allows(client: AsyncClient):
    """Agent with open policy can be invited without contact relationship."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")  # open policy

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_admission_create_room_batch_denied(client: AsyncClient):
    """Creating a room with contacts_only members who aren't contacts → denied."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent_contacts_only(client, "bob")
    _, c_id, _, c_token = await _create_agent_contacts_only(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 403
    assert "admission denied" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_admission_create_room_open_members(client: AsyncClient):
    """Creating a room with open-policy members succeeds."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    member_ids = [m["agent_id"] for m in resp.json()["members"]]
    assert b_id in member_ids
    assert c_id in member_ids


@pytest.mark.asyncio
async def test_admission_self_join_skips_policy(client: AsyncClient):
    """Self-join (public+open room) skips admission policy check."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    # Bob has contacts_only
    _, b_id, _, b_token = await _create_agent_contacts_only(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "public-room", "visibility": "public", "join_policy": "open"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob self-joins — no admission policy check
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={},
        headers=_auth_header(b_token),
    )
    assert resp.status_code == 201
    member_ids = [m["agent_id"] for m in resp.json()["members"]]
    assert b_id in member_ids


# ===========================================================================
# Response body tests — permissions fields present
# ===========================================================================


@pytest.mark.asyncio
async def test_room_response_includes_permission_fields(client: AsyncClient):
    """Room response includes can_send and can_invite for each member."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    for member in resp.json()["members"]:
        assert "can_send" in member
        assert "can_invite" in member
        # Default should be None
        assert member["can_send"] is None
        assert member["can_invite"] is None


@pytest.mark.asyncio
async def test_invite_with_permissions_reflected_in_response(client: AsyncClient):
    """Inviting with can_send/can_invite is reflected in the response."""
    _, a_id, _, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room"},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id, "can_send": True, "can_invite": False},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    bob = next(m for m in resp.json()["members"] if m["agent_id"] == b_id)
    assert bob["can_send"] is True
    assert bob["can_invite"] is False


# ===========================================================================
# End-to-end multi-agent room conversation tests
# ===========================================================================


@pytest.mark.asyncio
async def test_e2e_multi_agent_room_conversation(client: AsyncClient):
    """Full end-to-end: 3 agents take turns chatting in a room, then query history."""
    # --- Setup: create 3 agents ---
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "carol")

    # --- Step 1: Alice creates a room with Bob and Carol ---
    resp = await client.post(
        "/hub/rooms",
        json={"name": "team-chat", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room = resp.json()
    room_id = room["room_id"]
    assert room["member_count"] == 3
    member_ids = {m["agent_id"] for m in room["members"]}
    assert member_ids == {a_id, b_id, c_id}

    # --- Step 2: Alice sends "大家好" → Bob and Carol receive it ---
    env_a = _build_envelope(
        sk_a, a_key, a_id, room_id, payload={"text": "大家好"},
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=env_a, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Bob sees Alice's message
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "true"},
    )
    assert bob_inbox.json()["count"] == 1
    msg = bob_inbox.json()["messages"][0]
    assert msg["envelope"]["payload"]["text"] == "大家好"
    assert msg["envelope"]["from"] == a_id
    assert msg["room_id"] == room_id

    # Carol sees Alice's message
    carol_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(c_token), params={"ack": "true"},
    )
    assert carol_inbox.json()["count"] == 1
    assert carol_inbox.json()["messages"][0]["envelope"]["payload"]["text"] == "大家好"

    # Alice (sender) should NOT see her own message
    alice_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(a_token), params={"ack": "false"},
    )
    assert alice_inbox.json()["count"] == 0

    # --- Step 3: Bob replies "你好 Alice" → Alice and Carol receive it ---
    env_b = _build_envelope(
        sk_b, b_key, b_id, room_id, payload={"text": "你好 Alice"},
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=env_b, headers=_auth_header(b_token),
        )
    assert resp.status_code == 202

    alice_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(a_token), params={"ack": "true"},
    )
    assert alice_inbox.json()["count"] == 1
    assert alice_inbox.json()["messages"][0]["envelope"]["from"] == b_id
    assert alice_inbox.json()["messages"][0]["envelope"]["payload"]["text"] == "你好 Alice"

    carol_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(c_token), params={"ack": "true"},
    )
    assert carol_inbox.json()["count"] == 1
    assert carol_inbox.json()["messages"][0]["envelope"]["from"] == b_id

    # Bob should NOT see his own reply
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 0

    # --- Step 4: Carol replies "我也来了" → Alice and Bob receive it ---
    env_c = _build_envelope(
        sk_c, c_key, c_id, room_id, payload={"text": "我也来了"},
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=env_c, headers=_auth_header(c_token),
        )
    assert resp.status_code == 202

    alice_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(a_token), params={"ack": "true"},
    )
    assert alice_inbox.json()["count"] == 1
    assert alice_inbox.json()["messages"][0]["envelope"]["from"] == c_id
    assert alice_inbox.json()["messages"][0]["envelope"]["payload"]["text"] == "我也来了"

    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "true"},
    )
    assert bob_inbox.json()["count"] == 1
    assert bob_inbox.json()["messages"][0]["envelope"]["from"] == c_id

    # --- Step 5: All three agents query room history ---
    for token in [a_token, b_token, c_token]:
        history = await client.get(
            "/hub/history",
            headers=_auth_header(token),
            params={"room_id": room_id, "limit": 50},
        )
        assert history.status_code == 200
        msgs = history.json()["messages"]
        # Each agent sent 1 message, fan-out creates records per receiver (2 each) = 6 total
        # But history returns records where current agent is sender OR receiver
        # Agent sent 1 (1 record per receiver = 2) + received 2 = at least 2 visible
        assert len(msgs) >= 2
        # All messages belong to this room
        for m in msgs:
            assert m["room_id"] == room_id

    # Verify Alice sees the full conversation (she sent 1 msg with 2 fan-out records,
    # and received 2 messages = 4 records)
    alice_history = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id, "limit": 50},
    )
    alice_msgs = alice_history.json()["messages"]
    senders_in_history = {m["envelope"]["from"] for m in alice_msgs}
    assert a_id in senders_in_history  # Alice's own sent message (fan-out records)
    assert b_id in senders_in_history  # Bob's reply she received
    assert c_id in senders_in_history  # Carol's reply she received


@pytest.mark.asyncio
async def test_e2e_room_conversation_with_topic(client: AsyncClient):
    """Multi-agent conversation with topic partitioning and filtered history."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "project-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        # Alice sends on topic "design"
        env1 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "讨论设计方案"})
        await client.post(
            "/hub/send", json=env1, headers=_auth_header(a_token),
            params={"topic": "design"},
        )

        # Bob replies on topic "design"
        env2 = _build_envelope(sk_b, b_key, b_id, room_id, payload={"text": "方案A更好"})
        await client.post(
            "/hub/send", json=env2, headers=_auth_header(b_token),
            params={"topic": "design"},
        )

        # Alice sends on topic "bugs"
        env3 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "发现一个bug"})
        await client.post(
            "/hub/send", json=env3, headers=_auth_header(a_token),
            params={"topic": "bugs"},
        )

    # Query history filtered by topic "design" — should see 2 conversations
    design_history = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id, "topic": "design", "limit": 50},
    )
    assert design_history.status_code == 200
    design_msgs = design_history.json()["messages"]
    assert len(design_msgs) >= 2
    for m in design_msgs:
        assert m["topic"] == "design"

    # Query history filtered by topic "bugs" — should see 1 conversation
    bugs_history = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id, "topic": "bugs", "limit": 50},
    )
    bugs_msgs = bugs_history.json()["messages"]
    assert len(bugs_msgs) >= 1
    for m in bugs_msgs:
        assert m["topic"] == "bugs"

    # All history (no topic filter) should include both topics
    all_history = await client.get(
        "/hub/history",
        headers=_auth_header(a_token),
        params={"room_id": room_id, "limit": 50},
    )
    all_topics = {m["topic"] for m in all_history.json()["messages"]}
    assert "design" in all_topics
    assert "bugs" in all_topics


@pytest.mark.asyncio
async def test_e2e_room_conversation_block_skips_delivery(client: AsyncClient):
    """Blocked sender's messages are skipped during room fan-out."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Carol blocks Alice
    await client.post(
        f"/registry/agents/{c_id}/blocks",
        json={"blocked_agent_id": a_id},
        headers=_auth_header(c_token),
    )

    # Alice sends a message to the room
    env = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "hello everyone"})
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=env, headers=_auth_header(a_token),
        )
    assert resp.status_code == 202

    # Bob should receive the message
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1

    # Carol (who blocked Alice) should NOT receive it
    carol_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(c_token), params={"ack": "false"},
    )
    assert carol_inbox.json()["count"] == 0


@pytest.mark.asyncio
async def test_e2e_room_conversation_muted_member_skipped(client: AsyncClient):
    """Muted members don't receive room messages."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "test-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Bob mutes the room
    resp = await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": True},
        headers=_auth_header(b_token),
    )
    assert resp.json()["muted"] is True

    # Alice sends a message
    env = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "hello"})
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env, headers=_auth_header(a_token),
        )

    # Carol receives it
    carol_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(c_token), params={"ack": "false"},
    )
    assert carol_inbox.json()["count"] == 1

    # Bob (muted) does NOT receive it
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 0

    # Bob unmutes and the next message arrives
    await client.post(
        f"/hub/rooms/{room_id}/mute",
        json={"muted": False},
        headers=_auth_header(b_token),
    )
    env2 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "hello again"})
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=env2, headers=_auth_header(a_token),
        )
    bob_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"},
    )
    assert bob_inbox.json()["count"] == 1


@pytest.mark.asyncio
async def test_e2e_room_member_join_mid_conversation(client: AsyncClient):
    """A new member joins mid-conversation and can send/receive subsequent messages."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_d, d_id, d_key, d_token = await _create_agent(client, "dave")

    # Alice creates room with Bob only
    resp = await client.post(
        "/hub/rooms",
        json={"name": "growing-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # Alice and Bob exchange messages
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        env1 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "msg before dave"})
        await client.post("/hub/send", json=env1, headers=_auth_header(a_token))

    # Drain Bob's inbox
    await client.get("/hub/inbox", headers=_auth_header(b_token), params={"ack": "true"})

    # Dave joins the room
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": d_id},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    assert resp.json()["member_count"] == 3

    # Alice sends another message — now Dave should receive it
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        env2 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "msg after dave joined"})
        await client.post("/hub/send", json=env2, headers=_auth_header(a_token))

    dave_inbox = await client.get(
        "/hub/inbox", headers=_auth_header(d_token), params={"ack": "false"},
    )
    assert dave_inbox.json()["count"] == 1
    assert dave_inbox.json()["messages"][0]["envelope"]["payload"]["text"] == "msg after dave joined"

    # Dave can also send to the room
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        env3 = _build_envelope(sk_d, d_key, d_id, room_id, payload={"text": "hi from dave"})
        resp = await client.post("/hub/send", json=env3, headers=_auth_header(d_token))
    assert resp.status_code == 202

    # Alice and Bob both receive Dave's message
    for token in [a_token, b_token]:
        inbox = await client.get(
            "/hub/inbox", headers=_auth_header(token), params={"ack": "true"},
        )
        texts = [m["envelope"]["payload"]["text"] for m in inbox.json()["messages"]]
        assert "hi from dave" in texts


@pytest.mark.asyncio
async def test_public_room_history_visible_to_late_joiner(client: AsyncClient):
    """A member who joins a public room later can see all previous messages via history."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")
    sk_c, c_id, c_key, c_token = await _create_agent(client, "charlie")

    # Create a public room with alice and bob
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Public Room", "visibility": "public", "join_policy": "open", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    # Alice sends two messages before charlie joins
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        env1 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "msg1 before charlie"})
        resp = await client.post("/hub/send", json=env1, headers=_auth_header(a_token))
        assert resp.status_code == 202

        env2 = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "msg2 before charlie"})
        resp = await client.post("/hub/send", json=env2, headers=_auth_header(a_token))
        assert resp.status_code == 202

    # Charlie joins the public room
    join_resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": c_id},
        headers=_auth_header(c_token),
    )
    assert join_resp.status_code == 201

    # Charlie queries history — should see messages sent before they joined
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(c_token),
        params={"room_id": room_id},
    )
    assert resp.status_code == 200
    texts = [m["envelope"]["payload"]["text"] for m in resp.json()["messages"]]
    assert "msg1 before charlie" in texts
    assert "msg2 before charlie" in texts

    # Also verify no duplicates (each message appears exactly once)
    hub_msg_ids = [m["hub_msg_id"] for m in resp.json()["messages"]]
    assert len(hub_msg_ids) == len(set(hub_msg_ids))


@pytest.mark.asyncio
async def test_private_room_history_not_visible_to_late_joiner(client: AsyncClient):
    """A member who joins a private room later cannot see previous messages."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_token = await _create_agent(client, "bob")

    # Create a private room with just alice
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Private Room", "visibility": "private"},
        headers=_auth_header(a_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    # Alice sends a message before bob joins
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        env = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "private msg"})
        resp = await client.post("/hub/send", json=env, headers=_auth_header(a_token))
        assert resp.status_code == 202

    # Admin (alice) invites bob
    invite_resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": b_id},
        headers=_auth_header(a_token),
    )
    assert invite_resp.status_code == 201

    # Bob queries history — should NOT see the message sent before they joined
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(b_token),
        params={"room_id": room_id},
    )
    assert resp.status_code == 200
    texts = [m["envelope"]["payload"]["text"] for m in resp.json()["messages"]]
    assert "private msg" not in texts


# ===========================================================================
# Anti-spam: Slow mode, join rate limit, duplicate content detection
# ===========================================================================


@pytest.mark.asyncio
async def test_slow_mode_basic(client: AsyncClient):
    """Slow mode: second message within interval → 429."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")
    sk_b, b_id, b_kid, b_token = await _create_agent(client, "member")

    # Create room with slow_mode_seconds=5
    resp = await client.post(
        "/hub/rooms",
        json={"name": "slow-room", "slow_mode_seconds": 5, "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]
    assert resp.json()["slow_mode_seconds"] == 5

    # Clear rate limit state to avoid interference
    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # B sends first message → 200
    env1 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "msg1"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(b_token))
    assert resp.status_code == 202

    # B sends second message immediately → 429
    env2 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "msg2"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(b_token))
    assert resp.status_code == 429
    assert "Slow mode" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_slow_mode_admin_exempt(client: AsyncClient):
    """Admin/owner are exempt from slow mode."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "slow-room-admin", "slow_mode_seconds": 60},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # Owner sends two messages back-to-back → both 202
    env1 = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "first"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(a_token))
    assert resp.status_code == 202

    env2 = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "second"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(a_token))
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_slow_mode_disabled(client: AsyncClient):
    """No slow mode (None) → no throttling."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")
    sk_b, b_id, b_kid, b_token = await _create_agent(client, "member")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "no-slow", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]
    assert resp.json()["slow_mode_seconds"] is None

    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    env1 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "a"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(b_token))
    assert resp.status_code == 202

    env2 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "b"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(b_token))
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_slow_mode_dynamic_update(client: AsyncClient):
    """PATCH to enable slow mode takes effect immediately."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")
    sk_b, b_id, b_kid, b_token = await _create_agent(client, "member")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "dynamic-slow", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # B can send freely (no slow mode)
    env1 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "x"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(b_token))
    assert resp.status_code == 202

    env2 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "y"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(b_token))
    assert resp.status_code == 202

    # Owner enables slow mode
    resp = await client.patch(
        f"/hub/rooms/{room_id}",
        json={"slow_mode_seconds": 10},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 200
    assert resp.json()["slow_mode_seconds"] == 10

    # Clear last send so B starts fresh with slow mode
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # B sends once → 202
    env3 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "z1"})
    resp = await client.post("/hub/send", json=env3, headers=_auth_header(b_token))
    assert resp.status_code == 202

    # B sends again immediately → 429
    env4 = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "z2"})
    resp = await client.post("/hub/send", json=env4, headers=_auth_header(b_token))
    assert resp.status_code == 429


@pytest.mark.asyncio
async def test_join_rate_limit(client: AsyncClient):
    """Exceeding join rate limit → 429."""
    from hub.routers.room import _join_rate_windows

    sk_owner, owner_id, _, owner_token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "popular-room",
            "visibility": "public",
            "join_policy": "open",
        },
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    _join_rate_windows.clear()

    # Join up to the limit
    from hub.config import JOIN_RATE_LIMIT_PER_MINUTE as limit

    agents = []
    for i in range(limit + 1):
        sk, aid, kid, tok = await _create_agent(client, f"joiner-{i}")
        agents.append((sk, aid, kid, tok))

    for i in range(limit):
        _, _, _, tok = agents[i]
        resp = await client.post(
            f"/hub/rooms/{room_id}/members",
            headers=_auth_header(tok),
        )
        assert resp.status_code == 201, f"Join {i} failed: {resp.text}"

    # Next join should be rate limited
    _, _, _, tok = agents[limit]
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        headers=_auth_header(tok),
    )
    assert resp.status_code == 429
    assert "Join rate limit" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_duplicate_content_detection(client: AsyncClient):
    """Same content consecutively → 429; different content → 200."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "dup-room"},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # Send first message
    env1 = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "spam"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(a_token))
    assert resp.status_code == 202

    # Send exact same content → 429
    env2 = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "spam"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(a_token))
    assert resp.status_code == 429
    assert "Duplicate content" in resp.json()["detail"]

    # Send different content → 202
    env3 = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "not spam"})
    resp = await client.post("/hub/send", json=env3, headers=_auth_header(a_token))
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_duplicate_content_not_cross_user(client: AsyncClient):
    """Two users sending same content → both 200 (not cross-user)."""
    from hub.routers.hub import _slow_mode_last_send, _last_msg_hash, _rate_windows, _pair_rate_windows

    sk_a, a_id, a_kid, a_token = await _create_agent(client, "owner")
    sk_b, b_id, b_kid, b_token = await _create_agent(client, "member")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "dup-cross-room", "member_ids": [b_id]},
        headers=_auth_header(a_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    _rate_windows.clear()
    _pair_rate_windows.clear()
    _slow_mode_last_send.clear()
    _last_msg_hash.clear()

    # A sends message
    env_a = _build_envelope(sk_a, a_kid, a_id, room_id, payload={"text": "hello"})
    resp = await client.post("/hub/send", json=env_a, headers=_auth_header(a_token))
    assert resp.status_code == 202

    # B sends same content → 202 (different user)
    env_b = _build_envelope(sk_b, b_kid, b_id, room_id, payload={"text": "hello"})
    resp = await client.post("/hub/send", json=env_b, headers=_auth_header(b_token))
    assert resp.status_code == 202


# ===========================================================================
# @mention tests
# ===========================================================================


@pytest.mark.asyncio
async def test_mention_specific_agent(client: AsyncClient):
    """Room message with mentions=[ag_xxx] — mentioned agent gets mentioned=True, others get False."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "mention-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    envelope["mentions"] = [b_id]

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    # Bob should have mentioned=True
    inbox_b = await client.get("/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"})
    assert inbox_b.status_code == 200
    assert inbox_b.json()["count"] == 1
    assert inbox_b.json()["messages"][0]["mentioned"] is True

    # Carol should have mentioned=False
    inbox_c = await client.get("/hub/inbox", headers=_auth_header(c_token), params={"ack": "false"})
    assert inbox_c.status_code == 200
    assert inbox_c.json()["count"] == 1
    assert inbox_c.json()["messages"][0]["mentioned"] is False


@pytest.mark.asyncio
async def test_mention_all(client: AsyncClient):
    """Room message with mentions=["@all"] — all receivers get mentioned=True."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "mention-all-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    envelope["mentions"] = ["@all"]

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    for token in [b_token, c_token]:
        inbox = await client.get("/hub/inbox", headers=_auth_header(token), params={"ack": "false"})
        assert inbox.status_code == 200
        assert inbox.json()["count"] == 1
        assert inbox.json()["messages"][0]["mentioned"] is True


@pytest.mark.asyncio
async def test_mention_none_omitted(client: AsyncClient):
    """Room message with mentions omitted (None) — all receivers get mentioned=False."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "no-mention-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    # No mentions field at all
    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    assert "mentions" not in envelope

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    for token in [b_token, c_token]:
        inbox = await client.get("/hub/inbox", headers=_auth_header(token), params={"ack": "false"})
        assert inbox.status_code == 200
        assert inbox.json()["count"] == 1
        assert inbox.json()["messages"][0]["mentioned"] is False


@pytest.mark.asyncio
async def test_mention_empty_list(client: AsyncClient):
    """Room message with mentions=[] (empty list) — all receivers get mentioned=False."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "empty-mention-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id)
    envelope["mentions"] = []

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    for token in [b_token, c_token]:
        inbox = await client.get("/hub/inbox", headers=_auth_header(token), params={"ack": "false"})
        assert inbox.status_code == 200
        assert inbox.json()["count"] == 1
        assert inbox.json()["messages"][0]["mentioned"] is False


@pytest.mark.asyncio
async def test_dm_mentioned_true(client: AsyncClient):
    """DM messages always have mentioned=True for the receiver."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")

    envelope = _build_envelope(sk_a, a_key, a_id, b_id)

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    inbox_b = await client.get("/hub/inbox", headers=_auth_header(b_token), params={"ack": "false"})
    assert inbox_b.status_code == 200
    assert inbox_b.json()["count"] == 1
    assert inbox_b.json()["messages"][0]["mentioned"] is True


@pytest.mark.asyncio
async def test_mention_in_history(client: AsyncClient):
    """History query returns correct mentioned field for room messages with mentions."""
    sk_a, a_id, a_key, a_token = await _create_agent(client, "alice")
    _, b_id, _, b_token = await _create_agent(client, "bob")
    _, c_id, _, c_token = await _create_agent(client, "carol")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "history-mention-room", "member_ids": [b_id, c_id]},
        headers=_auth_header(a_token),
    )
    room_id = resp.json()["room_id"]

    envelope = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "hey @bob"})
    envelope["mentions"] = [b_id]

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/send", json=envelope, headers=_auth_header(a_token))
    assert resp.status_code == 202

    # Bob's history should show mentioned=True
    resp_b = await client.get(
        "/hub/history",
        headers=_auth_header(b_token),
        params={"room_id": room_id},
    )
    assert resp_b.status_code == 200
    assert resp_b.json()["count"] >= 1
    bob_msgs = resp_b.json()["messages"]
    assert any(m["mentioned"] is True for m in bob_msgs)

    # Carol's history should show mentioned=False
    resp_c = await client.get(
        "/hub/history",
        headers=_auth_header(c_token),
        params={"room_id": room_id},
    )
    assert resp_c.status_code == 200
    assert resp_c.json()["count"] >= 1
    carol_msgs = resp_c.json()["messages"]
    assert all(m["mentioned"] is False for m in carol_msgs)

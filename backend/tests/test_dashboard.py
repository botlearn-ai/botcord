"""Tests for Dashboard APIs."""

import base64
import hashlib
import time
import uuid
from unittest.mock import AsyncMock

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


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


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    payload: dict | None = None,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}

    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1",
        msg_id,
        str(ts),
        from_id,
        to_id,
        msg_type,
        "",
        "3600",
        payload_hash,
    ]
    signing_input = "\n".join(parts).encode()
    sig_b64 = base64.b64encode(sk.sign(signing_input).signature).decode()

    return {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": from_id,
        "to": to_id,
        "type": msg_type,
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


async def _register_and_verify(
    client: AsyncClient,
    display_name: str,
) -> tuple[SigningKey, str, str, str]:
    sk, pubkey = _make_keypair()

    reg_resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey, "bio": "test agent"},
    )
    assert reg_resp.status_code == 201
    reg_data = reg_resp.json()
    agent_id = reg_data["agent_id"]
    key_id = reg_data["key_id"]
    challenge = reg_data["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()
    verify_resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert verify_resp.status_code == 200
    token = verify_resp.json()["agent_token"]

    policy_resp = await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    assert policy_resp.status_code == 200

    return sk, agent_id, key_id, token


async def _send_message(
    client: AsyncClient,
    sk: SigningKey,
    key_id: str,
    sender_id: str,
    sender_token: str,
    to_id: str,
    payload: dict,
    msg_type: str = "message",
) -> dict:
    envelope = _build_envelope(
        sk=sk,
        key_id=key_id,
        from_id=sender_id,
        to_id=to_id,
        msg_type=msg_type,
        payload=payload,
    )
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(sender_token),
    )
    assert resp.status_code == 202
    return resp.json()


async def _create_room(
    client: AsyncClient,
    owner_token: str,
    name: str,
    member_ids: list[str],
) -> str:
    resp = await client.post(
        "/hub/rooms",
        json={"name": name, "member_ids": member_ids},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 201
    return resp.json()["room_id"]


async def _accept_latest_received_request(
    client: AsyncClient,
    receiver_id: str,
    receiver_token: str,
) -> None:
    received_resp = await client.get(
        f"/registry/agents/{receiver_id}/contact-requests/received",
        headers=_auth_header(receiver_token),
    )
    assert received_resp.status_code == 200
    pending = [r for r in received_resp.json()["requests"] if r["state"] == "pending"]
    assert pending
    req_id = pending[0]["id"]

    accept_resp = await client.post(
        f"/registry/agents/{receiver_id}/contact-requests/{req_id}/accept",
        headers=_auth_header(receiver_token),
    )
    assert accept_resp.status_code == 200


@pytest.mark.asyncio
async def test_dashboard_overview(client: AsyncClient):
    sk_a, alice_id, alice_key, alice_token = await _register_and_verify(client, "alice")
    sk_b, bob_id, bob_key, bob_token = await _register_and_verify(client, "bob")
    sk_c, charlie_id, charlie_key, charlie_token = await _register_and_verify(client, "charlie")

    room_id = await _create_room(client, alice_token, "Team Room", [bob_id])
    await _send_message(
        client=client,
        sk=sk_b,
        key_id=bob_key,
        sender_id=bob_id,
        sender_token=bob_token,
        to_id=room_id,
        payload={"text": "hello team"},
    )

    await _send_message(
        client=client,
        sk=sk_b,
        key_id=bob_key,
        sender_id=bob_id,
        sender_token=bob_token,
        to_id=alice_id,
        msg_type="contact_request",
        payload={"message": "let us connect"},
    )
    await _accept_latest_received_request(client, alice_id, alice_token)

    await _send_message(
        client=client,
        sk=sk_c,
        key_id=charlie_key,
        sender_id=charlie_id,
        sender_token=charlie_token,
        to_id=alice_id,
        msg_type="contact_request",
        payload={"message": "pending request"},
    )

    resp = await client.get(
        "/dashboard/overview",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["agent"]["agent_id"] == alice_id
    assert data["agent"]["display_name"] == "alice"
    assert data["pending_requests"] == 1

    contact_ids = [c["contact_agent_id"] for c in data["contacts"]]
    assert bob_id in contact_ids

    room = next(r for r in data["rooms"] if r["room_id"] == room_id)
    assert room["name"] == "Team Room"
    assert room["member_count"] == 2
    assert room["my_role"] == "owner"
    assert room["last_message_preview"] == "hello team"
    assert room["last_sender_name"] == "bob"


@pytest.mark.asyncio
async def test_dashboard_room_messages_pagination_and_desc_order(client: AsyncClient):
    sk_a, alice_id, alice_key, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")

    room_id = await _create_room(client, alice_token, "Chronological", [bob_id])

    await _send_message(
        client, sk_a, alice_key, alice_id, alice_token, room_id, {"text": "m1"}
    )
    await _send_message(
        client, sk_a, alice_key, alice_id, alice_token, room_id, {"text": "m2"}
    )
    await _send_message(
        client, sk_a, alice_key, alice_id, alice_token, room_id, {"text": "m3"}
    )

    page1 = await client.get(
        f"/dashboard/rooms/{room_id}/messages",
        params={"limit": 2},
        headers=_auth_header(alice_token),
    )
    assert page1.status_code == 200
    page1_data = page1.json()
    assert page1_data["has_more"] is True
    assert [m["text"] for m in page1_data["messages"]] == ["m3", "m2"]

    cursor = page1_data["messages"][-1]["hub_msg_id"]
    older = await client.get(
        f"/dashboard/rooms/{room_id}/messages",
        params={"before": cursor, "limit": 2},
        headers=_auth_header(alice_token),
    )
    assert older.status_code == 200
    assert [m["text"] for m in older.json()["messages"]] == ["m1"]

    newer = await client.get(
        f"/dashboard/rooms/{room_id}/messages",
        params={"after": cursor, "limit": 2},
        headers=_auth_header(alice_token),
    )
    assert newer.status_code == 200
    assert [m["text"] for m in newer.json()["messages"]] == ["m3"]

    both_cursors = await client.get(
        f"/dashboard/rooms/{room_id}/messages",
        params={"before": cursor, "after": cursor},
        headers=_auth_header(alice_token),
    )
    assert both_cursors.status_code == 400


@pytest.mark.asyncio
async def test_dashboard_room_messages_invalid_cursor_and_membership(client: AsyncClient):
    sk_a, alice_id, alice_key, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")
    _, charlie_id, _, charlie_token = await _register_and_verify(client, "charlie")

    room_a = await _create_room(client, alice_token, "Room A", [bob_id])
    room_b = await _create_room(client, alice_token, "Room B", [bob_id])

    msg = await _send_message(
        client, sk_a, alice_key, alice_id, alice_token, room_b, {"text": "other room"}
    )
    other_room_cursor = msg["hub_msg_id"]

    cross_room = await client.get(
        f"/dashboard/rooms/{room_a}/messages",
        params={"before": other_room_cursor},
        headers=_auth_header(alice_token),
    )
    assert cross_room.status_code == 400

    invalid = await client.get(
        f"/dashboard/rooms/{room_a}/messages",
        params={"before": "h_invalid"},
        headers=_auth_header(alice_token),
    )
    assert invalid.status_code == 400

    forbidden = await client.get(
        f"/dashboard/rooms/{room_a}/messages",
        headers=_auth_header(charlie_token),
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "Not a member of this room"


@pytest.mark.asyncio
async def test_dashboard_agent_search_profile_and_conversations(client: AsyncClient):
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")
    _, charlie_id, _, charlie_token = await _register_and_verify(client, "charlie")

    room_ab = await _create_room(client, alice_token, "A-B Room", [bob_id])
    await _create_room(client, alice_token, "A-C Room", [charlie_id])

    search = await client.get(
        "/dashboard/agents/search",
        params={"q": "bob"},
        headers=_auth_header(alice_token),
    )
    assert search.status_code == 200
    returned_ids = {a["agent_id"] for a in search.json()["agents"]}
    assert bob_id in returned_ids

    profile = await client.get(
        f"/dashboard/agents/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert profile.status_code == 200
    assert profile.json()["display_name"] == "bob"

    conversations = await client.get(
        f"/dashboard/agents/{bob_id}/conversations",
        headers=_auth_header(alice_token),
    )
    assert conversations.status_code == 200
    conv_room_ids = [r["room_id"] for r in conversations.json()["conversations"]]
    assert conv_room_ids == [room_ab]

    not_found = await client.get(
        "/dashboard/agents/ag_not_exists/conversations",
        headers=_auth_header(alice_token),
    )
    assert not_found.status_code == 404

    # Keep tokens/ids used to avoid accidental fixture regressions in future edits.
    assert bob_token and charlie_token and alice_id


@pytest.mark.asyncio
async def test_dashboard_discover_rooms(client: AsyncClient):
    """Discover public rooms excludes rooms the agent already joined."""
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")

    # Bob creates a public+open room
    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Open Lounge",
            "description": "A public room",
            "visibility": "public",
            "join_policy": "open",
        },
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 201
    public_room_id = resp.json()["room_id"]

    # Bob creates a private room
    resp = await client.post(
        "/hub/rooms",
        json={"name": "Secret Room"},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 201

    # Alice discovers rooms — should see the public one she hasn't joined
    discover = await client.get(
        "/dashboard/rooms/discover",
        headers=_auth_header(alice_token),
    )
    assert discover.status_code == 200
    data = discover.json()
    room_ids = [r["room_id"] for r in data["rooms"]]
    assert public_room_id in room_ids
    assert data["total"] >= 1

    # Bob should NOT see his own public room (he's already a member)
    discover_bob = await client.get(
        "/dashboard/rooms/discover",
        headers=_auth_header(bob_token),
    )
    assert discover_bob.status_code == 200
    bob_room_ids = [r["room_id"] for r in discover_bob.json()["rooms"]]
    assert public_room_id not in bob_room_ids


@pytest.mark.asyncio
async def test_dashboard_discover_rooms_search(client: AsyncClient):
    """Discover rooms supports text search on name and description."""
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")

    # Bob creates two public rooms
    for name, desc in [("Python Dev", "Discuss Python"), ("Rust Club", "Discuss Rust")]:
        resp = await client.post(
            "/hub/rooms",
            json={
                "name": name,
                "description": desc,
                "visibility": "public",
                "join_policy": "open",
            },
            headers=_auth_header(bob_token),
        )
        assert resp.status_code == 201

    # Alice searches for "python"
    discover = await client.get(
        "/dashboard/rooms/discover",
        params={"q": "python"},
        headers=_auth_header(alice_token),
    )
    assert discover.status_code == 200
    names = [r["name"] for r in discover.json()["rooms"]]
    assert "Python Dev" in names
    assert "Rust Club" not in names


@pytest.mark.asyncio
async def test_dashboard_join_room(client: AsyncClient):
    """Join a public+open room via dashboard endpoint."""
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")

    # Bob creates a public+open room
    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Open Lounge",
            "description": "Welcome all",
            "visibility": "public",
            "join_policy": "open",
        },
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    # Alice joins
    join = await client.post(
        f"/dashboard/rooms/{room_id}/join",
        headers=_auth_header(alice_token),
    )
    assert join.status_code == 200
    join_data = join.json()
    assert join_data["room_id"] == room_id
    assert join_data["name"] == "Open Lounge"
    assert join_data["my_role"] == "member"
    assert join_data["member_count"] == 2  # bob (owner) + alice

    # Joining again → 409
    join_again = await client.post(
        f"/dashboard/rooms/{room_id}/join",
        headers=_auth_header(alice_token),
    )
    assert join_again.status_code == 409


@pytest.mark.asyncio
async def test_dashboard_join_private_room_forbidden(client: AsyncClient):
    """Cannot join a private or invite-only room."""
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")
    _, bob_id, _, bob_token = await _register_and_verify(client, "bob")

    # Bob creates a private room
    resp = await client.post(
        "/hub/rooms",
        json={"name": "Private Club"},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    # Alice tries to join → 403
    join = await client.post(
        f"/dashboard/rooms/{room_id}/join",
        headers=_auth_header(alice_token),
    )
    assert join.status_code == 403


@pytest.mark.asyncio
async def test_dashboard_join_nonexistent_room(client: AsyncClient):
    """Joining a nonexistent room → 404."""
    _, alice_id, _, alice_token = await _register_and_verify(client, "alice")

    join = await client.post(
        "/dashboard/rooms/rm_nonexistent/join",
        headers=_auth_header(alice_token),
    )
    assert join.status_code == 404


@pytest.mark.asyncio
async def test_dashboard_requires_auth(client: AsyncClient):
    resp = await client.get("/dashboard/overview")
    assert resp.status_code in (401, 422)

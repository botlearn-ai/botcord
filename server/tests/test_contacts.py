"""Tests for Contacts, Blocks & Message Policy."""

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
from unittest.mock import AsyncMock

from hub.models import Base

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

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
        "a2a/0.1",
        msg_id,
        str(ts),
        from_id,
        to_id,
        msg_type,
        reply_to or "",
        str(ttl_sec),
        payload_hash,
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


async def _setup_two_agents(client: AsyncClient):
    """Register Alice and Bob, return their details."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(client, sk_a, pub_a, "alice")

    sk_b, pub_b = _make_keypair()
    bob_id, bob_key, bob_token = await _register_and_verify(client, sk_b, pub_b, "bob")

    return (sk_a, alice_id, alice_key, alice_token), (sk_b, bob_id, bob_key, bob_token)


async def _establish_contact(
    client: AsyncClient,
    sk_sender: SigningKey,
    sender_key: str,
    sender_id: str,
    sender_token: str,
    receiver_id: str,
    receiver_token: str,
):
    """Establish mutual contact via the contact request flow."""
    # 1. Send contact request
    env = _build_envelope(
        sk_sender, sender_key, sender_id, receiver_id,
        msg_type="contact_request",
        payload={"message": "connect"},
    )
    resp = await client.post("/hub/send", json=env, headers=_auth_header(sender_token))
    assert resp.status_code == 202

    # 2. Get pending request id
    resp = await client.get(
        f"/registry/agents/{receiver_id}/contact-requests/received",
        headers=_auth_header(receiver_token),
    )
    assert resp.status_code == 200
    requests = resp.json()["requests"]
    pending = [r for r in requests if r["state"] == "pending"]
    assert len(pending) >= 1
    request_id = pending[0]["id"]

    # 3. Accept
    resp = await client.post(
        f"/registry/agents/{receiver_id}/contact-requests/{request_id}/accept",
        headers=_auth_header(receiver_token),
    )
    assert resp.status_code == 200


# ===========================================================================
# Contact CRUD tests (add_contact endpoint removed — contacts created via request flow)
# ===========================================================================


@pytest.mark.asyncio
async def test_add_contact_endpoint_removed(client):
    """POST /registry/agents/{id}/contacts should return 405 (endpoint removed)."""
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.post(
        f"/registry/agents/{alice_id}/contacts",
        json={"contact_agent_id": bob_id, "alias": "Bob"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 405


@pytest.mark.asyncio
async def test_list_contacts_empty(client):
    (_, alice_id, _, alice_token), _ = await _setup_two_agents(client)

    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    assert resp.json()["contacts"] == []


@pytest.mark.asyncio
async def test_list_contacts_populated(client):
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    contacts = resp.json()["contacts"]
    assert len(contacts) == 1
    assert contacts[0]["contact_agent_id"] == bob_id


@pytest.mark.asyncio
async def test_get_contact_success(client):
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["contact_agent_id"] == bob_id


@pytest.mark.asyncio
async def test_get_contact_not_found(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_contact_wrong_owner(client):
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    # Bob tries to query Alice's contact
    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_remove_contact_success_bidirectional(client):
    """Removing a contact should delete both directions."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    # Alice removes Bob
    resp = await client.delete(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 204

    # Verify Alice's contact list is empty
    resp = await client.get(
        f"/registry/agents/{alice_id}/contacts",
        headers=_auth_header(alice_token),
    )
    assert resp.json()["contacts"] == []

    # Verify Bob's contact list is also empty (bidirectional delete)
    resp = await client.get(
        f"/registry/agents/{bob_id}/contacts",
        headers=_auth_header(bob_token),
    )
    assert resp.json()["contacts"] == []


@pytest.mark.asyncio
async def test_remove_contact_notification(client):
    """After removing a contact, the other party should receive a contact_removed notification."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    # Drain Bob's inbox (clear contact_request_response notifications)
    await client.get("/hub/inbox", headers=_auth_header(bob_token))

    # Alice removes Bob
    resp = await client.delete(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 204

    # Bob polls inbox → should have a contact_removed notification
    resp = await client.get("/hub/inbox", headers=_auth_header(bob_token))
    assert resp.status_code == 200
    data = resp.json()
    notifs = [
        m for m in data["messages"]
        if m["envelope"]["type"] == "contact_removed"
    ]
    assert len(notifs) == 1
    assert notifs[0]["envelope"]["from"] == alice_id
    assert notifs[0]["envelope"]["payload"]["removed_by"] == alice_id


@pytest.mark.asyncio
async def test_remove_contact_not_found(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.delete(
        f"/registry/agents/{alice_id}/contacts/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 404


# ===========================================================================
# Block CRUD tests
# ===========================================================================


@pytest.mark.asyncio
async def test_add_block_success(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": bob_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["blocked_agent_id"] == bob_id
    assert "created_at" in data


@pytest.mark.asyncio
async def test_add_block_self(client):
    (_, alice_id, _, alice_token), _ = await _setup_two_agents(client)

    resp = await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": alice_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_add_block_nonexistent_agent(client):
    (_, alice_id, _, alice_token), _ = await _setup_two_agents(client)

    resp = await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": "nonexistent"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_add_block_duplicate(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": bob_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 201

    resp = await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": bob_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_blocks(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": bob_id},
        headers=_auth_header(alice_token),
    )

    resp = await client.get(
        f"/registry/agents/{alice_id}/blocks",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    blocks = resp.json()["blocks"]
    assert len(blocks) == 1
    assert blocks[0]["blocked_agent_id"] == bob_id


@pytest.mark.asyncio
async def test_remove_block_success(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    await client.post(
        f"/registry/agents/{alice_id}/blocks",
        json={"blocked_agent_id": bob_id},
        headers=_auth_header(alice_token),
    )

    resp = await client.delete(
        f"/registry/agents/{alice_id}/blocks/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 204

    resp = await client.get(
        f"/registry/agents/{alice_id}/blocks",
        headers=_auth_header(alice_token),
    )
    assert resp.json()["blocks"] == []


@pytest.mark.asyncio
async def test_remove_block_not_found(client):
    (_, alice_id, _, alice_token), (_, bob_id, _, _) = await _setup_two_agents(client)

    resp = await client.delete(
        f"/registry/agents/{alice_id}/blocks/{bob_id}",
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 404


# ===========================================================================
# Policy tests
# ===========================================================================


@pytest.mark.asyncio
async def test_get_policy_default(client):
    (_, alice_id, _, _), _ = await _setup_two_agents(client)

    resp = await client.get(f"/registry/agents/{alice_id}/policy")
    assert resp.status_code == 200
    assert resp.json()["message_policy"] == "contacts_only"


@pytest.mark.asyncio
async def test_update_policy_contacts_only(client):
    (_, alice_id, _, alice_token), _ = await _setup_two_agents(client)

    resp = await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    assert resp.json()["message_policy"] == "contacts_only"


@pytest.mark.asyncio
async def test_update_policy_back_to_open(client):
    (_, alice_id, _, alice_token), _ = await _setup_two_agents(client)

    await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(alice_token),
    )

    resp = await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    assert resp.json()["message_policy"] == "open"


@pytest.mark.asyncio
async def test_get_policy_no_auth(client):
    """GET policy is public — no auth required."""
    (_, alice_id, _, _), _ = await _setup_two_agents(client)

    resp = await client.get(f"/registry/agents/{alice_id}/policy")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_update_policy_wrong_owner(client):
    (_, alice_id, _, _), (_, _, _, bob_token) = await _setup_two_agents(client)

    resp = await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 403


# ===========================================================================
# Hub send enforcement tests
# ===========================================================================


@pytest.mark.asyncio
async def test_send_blocked_rejected(client):
    """Blocked sender gets 403 BLOCKED."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(
        client
    )

    # Bob blocks Alice
    resp = await client.post(
        f"/registry/agents/{bob_id}/blocks",
        json={"blocked_agent_id": alice_id},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 201

    # Alice tries to send to Bob
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "BLOCKED"


@pytest.mark.asyncio
async def test_send_contacts_only_not_in_list(client):
    """contacts_only policy rejects non-contacts."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(
        client
    )

    # Bob sets contacts_only
    resp = await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 200

    # Alice tries to send to Bob (not in contact list)
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "NOT_IN_CONTACTS"


@pytest.mark.asyncio
async def test_send_contacts_only_in_list_success(client):
    """contacts_only policy allows contacts."""
    (sk_a, alice_id, alice_key, alice_token), (sk_b, bob_id, bob_key, bob_token) = await _setup_two_agents(
        client
    )

    # Bob sets contacts_only
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "contacts_only"},
        headers=_auth_header(bob_token),
    )

    # Establish contact via request flow
    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    # Alice sends to Bob — should succeed
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_send_open_policy_success(client):
    """Open policy allows anyone."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(client)

    # Set Bob's policy to open so Alice can send without being a contact
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(bob_token),
    )

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_block_overrides_contact(client):
    """Block takes precedence even if sender is in contact list."""
    (sk_a, alice_id, alice_key, alice_token), (_, bob_id, _, bob_token) = await _setup_two_agents(
        client
    )

    # Establish contact via request flow
    await _establish_contact(client, sk_a, alice_key, alice_id, alice_token, bob_id, bob_token)

    # Bob blocks Alice
    await client.post(
        f"/registry/agents/{bob_id}/blocks",
        json={"blocked_agent_id": alice_id},
        headers=_auth_header(bob_token),
    )

    # Alice tries to send — should be blocked
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "BLOCKED"

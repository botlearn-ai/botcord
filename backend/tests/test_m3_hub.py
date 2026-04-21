"""Tests for M3 Hub/Router: send, receipt, status, inbox, history."""

import base64
import hashlib
import json
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from sqlalchemy import select

from hub.models import Base, MessageRecord, MessageState

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

    # Lifespan doesn't run under ASGITransport — set http_client manually
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
    """Build a signed MessageEnvelope dict."""
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
    """Register Alice and Bob, register endpoints, set open policy, return details."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(
        client, sk_a, pub_a, "alice"
    )
    # Register Alice's endpoint
    await client.post(
        f"/registry/agents/{alice_id}/endpoints",
        json={"url": "http://alice:8001/inbox", "webhook_token": "alice-tok"},
        headers=_auth_header(alice_token),
    )
    # Set open policy so hub routing tests aren't blocked by contacts_only default
    await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(alice_token),
    )

    sk_b, pub_b = _make_keypair()
    bob_id, bob_key, bob_token = await _register_and_verify(client, sk_b, pub_b, "bob")
    # Register Bob's endpoint
    await client.post(
        f"/registry/agents/{bob_id}/endpoints",
        json={"url": "http://bob:8002/inbox", "webhook_token": "bob-tok"},
        headers=_auth_header(bob_token),
    )
    # Set open policy so hub routing tests aren't blocked by contacts_only default
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(bob_token),
    )

    return (
        (sk_a, alice_id, alice_key, alice_token),
        (sk_b, bob_id, bob_key, bob_token),
    )


# ===========================================================================
# POST /hub/send tests
# ===========================================================================


@pytest.mark.asyncio
async def test_send_message_delivered(client: AsyncClient):
    """Send a message → status=queued (inbox-only delivery)."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )

    assert resp.status_code == 202
    data = resp.json()
    assert data["queued"] is True
    assert data["hub_msg_id"].startswith("h_")
    assert data["status"] == "queued"


@pytest.mark.asyncio
async def test_send_dedup(client: AsyncClient):
    """Sending the same msg_id twice returns the existing record."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    resp1 = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    resp2 = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )

    assert resp1.status_code == 202
    assert resp2.status_code == 202
    assert resp1.json()["hub_msg_id"] == resp2.json()["hub_msg_id"]


@pytest.mark.asyncio
async def test_send_wrong_sender(client: AsyncClient):
    """JWT agent_id doesn't match envelope from → 403."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Alice signs an envelope claiming to be from Bob
    envelope = _build_envelope(sk_a, alice_key, bob_id, alice_id)

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_send_bad_signature(client: AsyncClient):
    """Invalid signature → 400."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    # Corrupt signature
    envelope["sig"]["value"] = base64.b64encode(b"\x00" * 64).decode()

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_send_bad_timestamp(client: AsyncClient):
    """Timestamp too old → 400."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    # Override ts to be 10 minutes ago — re-sign
    envelope["ts"] = int(time.time()) - 600
    # Need to re-sign with the old ts
    parts = [
        envelope["v"],
        envelope["msg_id"],
        str(envelope["ts"]),
        envelope["from"],
        envelope["to"],
        envelope["type"],
        envelope.get("reply_to") or "",
        str(envelope["ttl_sec"]),
        envelope["payload_hash"],
    ]
    signing_input = "\n".join(parts).encode()
    signed = sk_a.sign(signing_input)
    envelope["sig"]["value"] = base64.b64encode(signed.signature).decode()

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 400
    assert "Timestamp" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_send_only_message_type(client: AsyncClient):
    """Non-message type on /hub/send → 400."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id, msg_type="ack")

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_send_rate_limit(client: AsyncClient):
    """Exceeding 100 msg/min triggers 429."""
    from hub.routers import hub as hub_mod

    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Pre-fill rate window
    hub_mod._rate_windows[alice_id] = __import__("collections").deque(
        [time.monotonic()] * 100
    )

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 429

    # Clean up
    hub_mod._rate_windows.pop(alice_id, None)


@pytest.mark.asyncio
async def test_send_pair_rate_limit(client: AsyncClient):
    """Exceeding per-pair rate limit triggers 429 with conversation detail."""
    from hub.routers import hub as hub_mod

    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Pre-fill per-pair rate window for (alice → bob)
    pair_key = (alice_id, bob_id)
    hub_mod._pair_rate_windows[pair_key] = __import__("collections").deque(
        [time.monotonic()] * 10
    )

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 429
    assert "Conversation rate limit" in resp.json()["detail"]

    # Clean up
    hub_mod._pair_rate_windows.pop(pair_key, None)


@pytest.mark.asyncio
async def test_send_pair_rate_limit_does_not_block_other_targets(client: AsyncClient):
    """Per-pair limit on A→B does not block B→A (reverse direction)."""
    from hub.routers import hub as hub_mod

    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Pre-fill per-pair limit for alice → bob
    pair_key_ab = (alice_id, bob_id)
    hub_mod._pair_rate_windows[pair_key_ab] = __import__("collections").deque(
        [time.monotonic()] * 10
    )

    # bob → alice (reverse direction) should still work
    envelope = _build_envelope(sk_b, bob_key, bob_id, alice_id)
    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(bob_token)
    )
    assert resp.status_code == 202

    # Clean up
    hub_mod._pair_rate_windows.pop(pair_key_ab, None)


# ===========================================================================
# POST /hub/receipt tests
# ===========================================================================


@pytest.mark.asyncio
async def test_receipt_ack(client: AsyncClient):
    """Ack receipt updates message state to acked."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Send a message first
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 202
    original_msg_id = envelope["msg_id"]

    # Bob sends ack receipt
    ack_envelope = _build_envelope(
        sk_b,
        bob_key,
        bob_id,
        alice_id,
        msg_type="ack",
        reply_to=original_msg_id,
    )
    resp = await client.post("/hub/receipt", json=ack_envelope)
    assert resp.status_code == 200
    assert resp.json()["received"] is True

    # Check status
    resp = await client.get(
        f"/hub/status/{original_msg_id}", headers=_auth_header(alice_token)
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "acked"
    assert resp.json()["acked_at"] is not None


@pytest.mark.asyncio
async def test_receipt_result(client: AsyncClient):
    """Result receipt updates message state to done."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )

    result_envelope = _build_envelope(
        sk_b,
        bob_key,
        bob_id,
        alice_id,
        msg_type="result",
        reply_to=envelope["msg_id"],
        payload={"result": "ok"},
    )
    resp = await client.post("/hub/receipt", json=result_envelope)
    assert resp.status_code == 200

    resp = await client.get(
        f"/hub/status/{envelope['msg_id']}", headers=_auth_header(alice_token)
    )
    assert resp.json()["state"] == "done"


@pytest.mark.asyncio
async def test_receipt_missing_reply_to(client: AsyncClient):
    """Receipt without reply_to → 400."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    ack = _build_envelope(sk_b, bob_key, bob_id, alice_id, msg_type="ack")
    resp = await client.post("/hub/receipt", json=ack)
    assert resp.status_code == 400
    assert "reply_to" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_receipt_nonexistent_message(client: AsyncClient):
    """Receipt for a non-existent original msg → 404."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    ack = _build_envelope(
        sk_b,
        bob_key,
        bob_id,
        alice_id,
        msg_type="ack",
        reply_to="nonexistent-msg-id",
    )
    resp = await client.post("/hub/receipt", json=ack)
    assert resp.status_code == 404


# ===========================================================================
# GET /hub/status tests
# ===========================================================================


@pytest.mark.asyncio
async def test_status_not_found(client: AsyncClient):
    (sk_a, alice_id, alice_key, alice_token), _ = await _setup_two_agents(client)

    resp = await client.get(
        "/hub/status/nonexistent", headers=_auth_header(alice_token)
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_status_wrong_sender(client: AsyncClient):
    """Non-sender querying status → 403."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )

    # Bob tries to query Alice's message
    resp = await client.get(
        f"/hub/status/{envelope['msg_id']}", headers=_auth_header(bob_token)
    )
    assert resp.status_code == 403


# ===========================================================================
# UNKNOWN_AGENT tests
# ===========================================================================


@pytest.mark.asyncio
async def test_send_unknown_receiver(client: AsyncClient):
    """Sending to a non-existent agent_id → 404 UNKNOWN_AGENT."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(
        client, sk_a, pub_a, "alice"
    )

    envelope = _build_envelope(sk_a, alice_key, alice_id, "ag_nonexistent")

    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )
    assert resp.status_code == 404
    assert "UNKNOWN_AGENT" in resp.json()["detail"]


# ===========================================================================
# Receipt forwarding with retry tests
# ===========================================================================


@pytest.mark.asyncio
async def test_receipt_creates_message_record_for_forwarding(
    client: AsyncClient, db_session: AsyncSession
):
    """Receipt forwarding creates a MessageRecord so retry loop can deliver it."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Send a message
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )

    # Bob sends ack — receipt forwarding should create a MessageRecord
    ack_envelope = _build_envelope(
        sk_b, bob_key, bob_id, alice_id, msg_type="ack", reply_to=envelope["msg_id"]
    )
    resp = await client.post("/hub/receipt", json=ack_envelope)
    assert resp.status_code == 200

    # There should be 2 non-system MessageRecords: original message + receipt forward
    # (welcome messages from endpoint registration are excluded)
    result = await db_session.execute(select(MessageRecord))
    records = [r for r in result.scalars().all() if r.sender_id != "hub"]
    assert len(records) == 2

    # The receipt record should target Alice (original sender) and be queued
    receipt_rec = [r for r in records if r.msg_id == ack_envelope["msg_id"]][0]
    assert receipt_rec.receiver_id == alice_id
    assert receipt_rec.state == MessageState.queued


@pytest.mark.asyncio
async def test_receipt_forwarding_delivered_immediately(
    client: AsyncClient, db_session: AsyncSession
):
    """Receipt forwarding creates a queued MessageRecord."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    await client.post(
        "/hub/send", json=envelope, headers=_auth_header(alice_token)
    )

    ack_envelope = _build_envelope(
        sk_b, bob_key, bob_id, alice_id, msg_type="ack", reply_to=envelope["msg_id"]
    )
    resp = await client.post("/hub/receipt", json=ack_envelope)
    assert resp.status_code == 200

    # Receipt record should be queued (inbox-only delivery)
    result = await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == ack_envelope["msg_id"])
    )
    receipt_rec = result.scalar_one()
    assert receipt_rec.state == MessageState.queued


# ===========================================================================
# GET /hub/inbox (polling) tests
# ===========================================================================


async def _setup_two_agents_no_endpoint(client: AsyncClient):
    """Register Alice and Bob WITHOUT endpoints (for polling tests)."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(
        client, sk_a, pub_a, "alice"
    )
    await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(alice_token),
    )

    sk_b, pub_b = _make_keypair()
    bob_id, bob_key, bob_token = await _register_and_verify(client, sk_b, pub_b, "bob")
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(bob_token),
    )

    return (
        (sk_a, alice_id, alice_key, alice_token),
        (sk_b, bob_id, bob_key, bob_token),
    )


async def _send_queued_message(
    client: AsyncClient, sk, key_id, from_id, to_id, token
):
    """Send a message that will be queued (no endpoint registered for receiver)."""
    envelope = _build_envelope(sk, key_id, from_id, to_id)
    resp = await client.post(
        "/hub/send", json=envelope, headers=_auth_header(token)
    )
    assert resp.status_code == 202
    assert resp.json()["status"] == "queued"
    return envelope


@pytest.mark.asyncio
async def test_inbox_poll_empty(client: AsyncClient):
    """Polling with no messages returns empty list."""
    (sk_a, alice_id, alice_key, alice_token), _ = await _setup_two_agents_no_endpoint(
        client
    )

    resp = await client.get(
        "/hub/inbox", headers=_auth_header(alice_token), params={"timeout": 0}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["messages"] == []
    assert data["count"] == 0
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_inbox_poll_returns_queued(client: AsyncClient):
    """Polling returns queued messages addressed to the agent."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Alice sends a message to Bob (will be queued)
    envelope = await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Bob polls
    resp = await client.get(
        "/hub/inbox", headers=_auth_header(bob_token), params={"timeout": 0}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["messages"][0]["envelope"]["msg_id"] == envelope["msg_id"]


@pytest.mark.asyncio
async def test_inbox_poll_marks_delivered(client: AsyncClient, db_session: AsyncSession):
    """ack=true marks messages as delivered after polling."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    envelope = await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Poll with ack=true (default)
    resp = await client.get(
        "/hub/inbox", headers=_auth_header(bob_token), params={"ack": "true"}
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1

    # Verify the record is now delivered
    result = await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == envelope["msg_id"])
    )
    rec = result.scalar_one()
    assert rec.state == MessageState.delivered
    assert rec.delivered_at is not None
    assert rec.next_retry_at is None

    # Polling again should return empty
    resp = await client.get(
        "/hub/inbox", headers=_auth_header(bob_token), params={"timeout": 0}
    )
    assert resp.json()["count"] == 0


@pytest.mark.asyncio
async def test_inbox_poll_peek_mode(client: AsyncClient, db_session: AsyncSession):
    """ack=false leaves messages in queued state."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    envelope = await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Poll with ack=false
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"ack": "false", "timeout": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1

    # Under two-phase ack, record is marked processing (not delivered)
    # so a retry/expiry loop can still revert it.
    result = await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == envelope["msg_id"])
    )
    rec = result.scalar_one()
    assert rec.state == MessageState.processing


@pytest.mark.asyncio
async def test_inbox_poll_respects_limit(client: AsyncClient):
    """limit caps the number of returned messages; has_more indicates remaining."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Send 3 messages from Alice to Bob
    for _ in range(3):
        await _send_queued_message(
            client, sk_a, alice_key, alice_id, bob_id, alice_token
        )

    # Poll with limit=2
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"limit": 2, "timeout": 0, "ack": "false"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert data["has_more"] is True

    # Poll with limit=50 (more than available). With two-phase ack, the
    # previous poll put 2 messages in `processing` state, so only the
    # remaining 1 is still queued.
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"limit": 50, "timeout": 0, "ack": "false"},
    )
    data = resp.json()
    assert data["count"] == 1
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_inbox_poll_only_own_messages(client: AsyncClient):
    """Agent can only see messages addressed to them."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Alice sends to Bob
    await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Alice polls — should see nothing (message is for Bob)
    resp = await client.get(
        "/hub/inbox", headers=_auth_header(alice_token), params={"timeout": 0}
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0

    # Bob polls — should see the message
    resp = await client.get(
        "/hub/inbox", headers=_auth_header(bob_token), params={"timeout": 0}
    )
    assert resp.json()["count"] == 1


@pytest.mark.asyncio
async def test_inbox_poll_requires_auth(client: AsyncClient):
    """Polling without JWT returns 401 or 422 (missing auth header)."""
    resp = await client.get("/hub/inbox")
    assert resp.status_code in (401, 422)


# ===========================================================================
# GET /hub/history tests
# ===========================================================================


@pytest.mark.asyncio
async def test_history_empty(client: AsyncClient):
    """No messages returns empty list."""
    (sk_a, alice_id, alice_key, alice_token), _ = await _setup_two_agents_no_endpoint(
        client
    )

    resp = await client.get(
        "/hub/history", headers=_auth_header(alice_token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["messages"] == []
    assert data["count"] == 0
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_history_basic(client: AsyncClient):
    """Send messages and verify all returned in history."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Alice sends 3 messages to Bob
    sent_msg_ids = []
    for _ in range(3):
        env = await _send_queued_message(
            client, sk_a, alice_key, alice_id, bob_id, alice_token
        )
        sent_msg_ids.append(env["msg_id"])

    # Alice queries history — should see all 3 (as sender)
    resp = await client.get(
        "/hub/history", headers=_auth_header(alice_token)
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 3
    returned_msg_ids = [m["envelope"]["msg_id"] for m in data["messages"]]
    assert set(returned_msg_ids) == set(sent_msg_ids)
    # Default order is newest first
    assert returned_msg_ids == list(reversed(sent_msg_ids))

    # Bob queries history — should also see all 3 (as receiver)
    resp = await client.get(
        "/hub/history", headers=_auth_header(bob_token)
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 3


@pytest.mark.asyncio
async def test_history_peer_filter(client: AsyncClient):
    """Filter by peer returns only messages between current agent and peer."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Register a third agent (Charlie)
    sk_c, pub_c = _make_keypair()
    charlie_id, charlie_key, charlie_token = await _register_and_verify(
        client, sk_c, pub_c, "charlie"
    )
    await client.patch(
        f"/registry/agents/{charlie_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(charlie_token),
    )

    # Alice sends to Bob
    await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )
    # Alice sends to Charlie
    await _send_queued_message(
        client, sk_a, alice_key, alice_id, charlie_id, alice_token
    )

    # Alice filters by peer=bob — should see only 1
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"peer": bob_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["messages"][0]["envelope"]["to"] == bob_id


@pytest.mark.asyncio
async def test_history_room_filter(client: AsyncClient):
    """Filter by room_id returns only messages in that room."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Send a message (creates default DM room)
    await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # The DM room_id for Alice↔Bob
    ids = sorted([alice_id, bob_id])
    room_id = f"rm_dm_{ids[0]}_{ids[1]}"

    resp = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"room_id": room_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["messages"][0]["room_id"] == room_id


@pytest.mark.asyncio
async def test_history_pagination_before(client: AsyncClient):
    """Cursor pagination with 'before' returns older messages."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Send 5 messages
    for _ in range(5):
        await _send_queued_message(
            client, sk_a, alice_key, alice_id, bob_id, alice_token
        )

    # First page: limit=2, newest first
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"limit": 2},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert data["has_more"] is True

    # Use the last message's hub_msg_id as cursor for next page
    cursor = data["messages"][-1]["hub_msg_id"]
    resp2 = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"limit": 2, "before": cursor},
    )
    data2 = resp2.json()
    assert data2["count"] == 2
    assert data2["has_more"] is True

    # Third page
    cursor2 = data2["messages"][-1]["hub_msg_id"]
    resp3 = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"limit": 2, "before": cursor2},
    )
    data3 = resp3.json()
    assert data3["count"] == 1
    assert data3["has_more"] is False

    # All message IDs should be unique and cover all 5
    all_ids = (
        [m["hub_msg_id"] for m in data["messages"]]
        + [m["hub_msg_id"] for m in data2["messages"]]
        + [m["hub_msg_id"] for m in data3["messages"]]
    )
    assert len(set(all_ids)) == 5


@pytest.mark.asyncio
async def test_history_pagination_after(client: AsyncClient):
    """Cursor pagination with 'after' returns newer messages in ASC order."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Send 3 messages
    for _ in range(3):
        await _send_queued_message(
            client, sk_a, alice_key, alice_id, bob_id, alice_token
        )

    # Get all messages (newest first) to find the oldest
    resp = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"limit": 100},
    )
    all_msgs = resp.json()["messages"]
    oldest_hub_msg_id = all_msgs[-1]["hub_msg_id"]

    # Query with after=oldest → should get the 2 newer messages in ASC order
    resp2 = await client.get(
        "/hub/history",
        headers=_auth_header(alice_token),
        params={"after": oldest_hub_msg_id, "limit": 100},
    )
    data = resp2.json()
    assert data["count"] == 2
    # ASC order: created_at of first < created_at of second
    ts0 = data["messages"][0]["created_at"]
    ts1 = data["messages"][1]["created_at"]
    assert ts0 <= ts1


@pytest.mark.asyncio
async def test_history_no_auth(client: AsyncClient):
    """History without JWT returns 401 or 422."""
    resp = await client.get("/hub/history")
    assert resp.status_code in (401, 422)


@pytest.mark.asyncio
async def test_history_no_cross_agent_leak(client: AsyncClient):
    """Agent C cannot see messages between A and B."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Register Charlie
    sk_c, pub_c = _make_keypair()
    charlie_id, charlie_key, charlie_token = await _register_and_verify(
        client, sk_c, pub_c, "charlie"
    )

    # Alice sends to Bob
    await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Charlie queries history — should see nothing
    resp = await client.get(
        "/hub/history", headers=_auth_header(charlie_token)
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


# ===========================================================================
# Delivery note tests
# ===========================================================================


def test_build_delivery_note_none_on_success():
    """No last_error → delivery_note is None."""
    from hub.routers.hub import _build_delivery_note

    assert _build_delivery_note(None) is None
    assert _build_delivery_note("") is None


def test_build_delivery_note_ttl_expired():
    """TTL_EXPIRED error maps to a specific diagnostic message."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("TTL_EXPIRED")
    assert note is not None
    assert "过期" in note


def test_build_delivery_note_unknown_returns_none():
    """Unknown error codes return None (no webhook-related diagnostics)."""
    from hub.routers.hub import _build_delivery_note

    assert _build_delivery_note("SOME_UNKNOWN_ERROR") is None


@pytest.mark.asyncio
async def test_register_endpoint_resets_unreachable(client: AsyncClient, db_session: AsyncSession):
    """Re-registering endpoint resets unreachable state back to active."""
    from hub.models import Endpoint, EndpointState

    (sk_a, alice_id, alice_key, alice_token), _ = await _setup_two_agents(client)

    # Mark Alice's endpoint as unreachable
    result = await db_session.execute(
        select(Endpoint).where(Endpoint.agent_id == alice_id)
    )
    ep = result.scalar_one()
    ep.state = EndpointState.unreachable
    await db_session.commit()

    # Re-register endpoint
    resp = await client.post(
        f"/registry/agents/{alice_id}/endpoints",
        json={"url": "http://new-alice:8001/inbox", "webhook_token": "new-tok"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200

    # Endpoint should be active again
    await db_session.refresh(ep)
    assert ep.state == EndpointState.active
    assert ep.url == "http://new-alice:8001/inbox"


# ===========================================================================
# message_expiry_loop / _expire_batch tests
# ===========================================================================


def _patch_expiry_session(db_session):
    """Return a context-manager mock that makes hub.expiry.async_session() use the test session."""
    from unittest.mock import patch
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _fake_session():
        yield db_session

    return patch("hub.expiry.async_session", _fake_session)


@pytest.mark.asyncio
async def test_expiry_loop_marks_expired_message_as_failed(client, db_session):
    """message_expiry_loop should mark queued messages past TTL as failed."""
    from hub.expiry import _expire_batch
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime, json, uuid

    # Create a message with TTL=60 and created_at 120s in the past
    now = datetime.datetime.now(datetime.timezone.utc)
    past = now - datetime.timedelta(seconds=120)
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    envelope = {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": int(past.timestamp()),
        "from": "ag_sender", "to": "ag_receiver", "type": "message",
        "reply_to": None, "ttl_sec": 60,
        "payload": {"text": "hello"}, "payload_hash": "sha256:abc",
        "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
    }
    record = MessageRecord(
        hub_msg_id=hub_msg_id, msg_id=msg_id,
        sender_id="ag_sender", receiver_id="ag_receiver",
        state=MessageState.queued,
        envelope_json=json.dumps(envelope),
        ttl_sec=60, created_at=past,
    )
    db_session.add(record)
    await db_session.commit()

    with _patch_expiry_session(db_session):
        await _expire_batch()

    await db_session.refresh(record)
    assert record.state == MessageState.failed
    assert record.last_error == "TTL_EXPIRED"


@pytest.mark.asyncio
async def test_expiry_loop_creates_ttl_error_for_sender(client, db_session):
    """Expiry loop should queue a TTL_EXPIRED error message for the sender."""
    from hub.expiry import _expire_batch
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime, json, uuid

    now = datetime.datetime.now(datetime.timezone.utc)
    past = now - datetime.timedelta(seconds=120)
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    envelope = {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": int(past.timestamp()),
        "from": "ag_sender", "to": "ag_receiver", "type": "message",
        "reply_to": None, "ttl_sec": 60,
        "payload": {"text": "hello"}, "payload_hash": "sha256:abc",
        "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
    }
    record = MessageRecord(
        hub_msg_id=hub_msg_id, msg_id=msg_id,
        sender_id="ag_sender", receiver_id="ag_receiver",
        state=MessageState.queued,
        envelope_json=json.dumps(envelope),
        ttl_sec=60, created_at=past,
    )
    db_session.add(record)
    await db_session.commit()

    with _patch_expiry_session(db_session):
        await _expire_batch()

    # Check that a TTL_EXPIRED error notification was created for the sender
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == "ag_sender",
            MessageRecord.sender_id == "hub",
        )
    )
    error_records = result.scalars().all()
    assert len(error_records) == 1
    error_env = json.loads(error_records[0].envelope_json)
    assert error_env["type"] == "error"
    assert error_env["payload"]["error"]["code"] == "TTL_EXPIRED"
    assert error_env["reply_to"] == msg_id


@pytest.mark.asyncio
async def test_expiry_loop_skips_non_expired(client, db_session):
    """Expiry loop should not touch queued messages that haven't expired."""
    from hub.expiry import _expire_batch
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime, json, uuid

    now = datetime.datetime.now(datetime.timezone.utc)
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    envelope = {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": int(now.timestamp()),
        "from": "ag_sender", "to": "ag_receiver", "type": "message",
        "reply_to": None, "ttl_sec": 3600,
        "payload": {"text": "hello"}, "payload_hash": "sha256:abc",
        "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
    }
    record = MessageRecord(
        hub_msg_id=hub_msg_id, msg_id=msg_id,
        sender_id="ag_sender", receiver_id="ag_receiver",
        state=MessageState.queued,
        envelope_json=json.dumps(envelope),
        ttl_sec=3600, created_at=now,
    )
    db_session.add(record)
    await db_session.commit()

    with _patch_expiry_session(db_session):
        await _expire_batch()

    await db_session.refresh(record)
    assert record.state == MessageState.queued


@pytest.mark.asyncio
async def test_expiry_loop_no_error_for_receipt(client, db_session):
    """Expiry of a receipt (ack/result/error) should NOT create a TTL_EXPIRED notification."""
    from hub.expiry import _expire_batch
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime, json, uuid

    now = datetime.datetime.now(datetime.timezone.utc)
    past = now - datetime.timedelta(seconds=120)
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    envelope = {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": int(past.timestamp()),
        "from": "ag_sender", "to": "ag_receiver", "type": "ack",
        "reply_to": "some-original-msg", "ttl_sec": 60,
        "payload": {}, "payload_hash": "sha256:abc",
        "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
    }
    record = MessageRecord(
        hub_msg_id=hub_msg_id, msg_id=msg_id,
        sender_id="ag_sender", receiver_id="ag_receiver",
        state=MessageState.queued,
        envelope_json=json.dumps(envelope),
        ttl_sec=60, created_at=past,
    )
    db_session.add(record)
    await db_session.commit()

    with _patch_expiry_session(db_session):
        await _expire_batch()

    await db_session.refresh(record)
    assert record.state == MessageState.failed

    # No error notification for sender
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == "ag_sender",
            MessageRecord.sender_id == "hub",
        )
    )
    assert result.scalars().all() == []


@pytest.mark.asyncio
async def test_expiry_loop_starvation_long_ttl_does_not_block_short(client, db_session):
    """100 older non-expired (long TTL) messages must NOT starve 1 newer expired (short TTL) message."""
    from hub.expiry import _expire_batch
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime, json, uuid

    now = datetime.datetime.now(datetime.timezone.utc)

    # 100 older messages with very long TTL (not yet expired)
    for i in range(100):
        old_time = now - datetime.timedelta(seconds=3600 + i)  # 1h+ ago
        mid = str(uuid.uuid4())
        env = {
            "v": "a2a/0.1", "msg_id": mid, "ts": int(old_time.timestamp()),
            "from": "ag_a", "to": "ag_b", "type": "message",
            "reply_to": None, "ttl_sec": 86400,  # 24h TTL — far from expired
            "payload": {"text": f"msg-{i}"}, "payload_hash": "sha256:x",
            "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
        }
        db_session.add(MessageRecord(
            hub_msg_id=generate_hub_msg_id(), msg_id=mid,
            sender_id="ag_a", receiver_id="ag_b",
            state=MessageState.queued,
            envelope_json=json.dumps(env),
            ttl_sec=86400, created_at=old_time,
        ))

    # 1 newer message with short TTL that is already expired
    expired_time = now - datetime.timedelta(seconds=120)
    expired_mid = str(uuid.uuid4())
    expired_env = {
        "v": "a2a/0.1", "msg_id": expired_mid, "ts": int(expired_time.timestamp()),
        "from": "ag_c", "to": "ag_d", "type": "message",
        "reply_to": None, "ttl_sec": 60,  # 60s TTL, created 120s ago → expired
        "payload": {"text": "short-ttl"}, "payload_hash": "sha256:y",
        "sig": {"alg": "ed25519", "key_id": "k1", "value": ""},
    }
    expired_record = MessageRecord(
        hub_msg_id=generate_hub_msg_id(), msg_id=expired_mid,
        sender_id="ag_c", receiver_id="ag_d",
        state=MessageState.queued,
        envelope_json=json.dumps(expired_env),
        ttl_sec=60, created_at=expired_time,
    )
    db_session.add(expired_record)
    await db_session.commit()

    with _patch_expiry_session(db_session):
        await _expire_batch()

    await db_session.refresh(expired_record)
    assert expired_record.state == MessageState.failed, (
        "Expired short-TTL message was starved by older non-expired long-TTL messages"
    )
    assert expired_record.last_error == "TTL_EXPIRED"



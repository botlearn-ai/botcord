"""Tests for M3 Hub/Router: send, receipt, status, retry."""

import base64
import hashlib
import time
import uuid

import httpx
import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock, patch

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
    """Send a message; forwarding succeeds → status=delivered."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send",
            json=envelope,
            headers=_auth_header(alice_token),
        )

    assert resp.status_code == 202
    data = resp.json()
    assert data["queued"] is True
    assert data["hub_msg_id"].startswith("h_")
    assert data["status"] == "delivered"


@pytest.mark.asyncio
async def test_send_message_queued(client: AsyncClient):
    """Send a message; forwarding fails → status=queued."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value="CONNECTION_REFUSED"):
        resp = await client.post(
            "/hub/send",
            json=envelope,
            headers=_auth_header(alice_token),
        )

    assert resp.status_code == 202
    data = resp.json()
    assert data["queued"] is True
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

    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )

    # Bob tries to query Alice's message
    resp = await client.get(
        f"/hub/status/{envelope['msg_id']}", headers=_auth_header(bob_token)
    )
    assert resp.status_code == 403


# ===========================================================================
# Retry helpers unit tests
# ===========================================================================


def test_compute_next_retry_at():
    from hub.routers.hub import _compute_next_retry_at
    import datetime

    created = datetime.datetime.now(datetime.timezone.utc)

    # First retry — should be ~1s from now
    r = _compute_next_retry_at(0, created, ttl_sec=3600)
    assert r is not None
    assert (r - created).total_seconds() >= 1

    # 6th retry — should be 60s cap
    r = _compute_next_retry_at(6, created, ttl_sec=3600)
    assert r is not None

    # TTL already exceeded
    r = _compute_next_retry_at(0, created, ttl_sec=0)
    assert r is None


def test_compute_next_retry_at_naive_created():
    """Works with timezone-naive created_at (SQLite returns naive datetimes)."""
    from hub.routers.hub import _compute_next_retry_at
    import datetime

    created = datetime.datetime.utcnow()  # naive
    r = _compute_next_retry_at(0, created, ttl_sec=3600)
    assert r is not None


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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )

    # Bob sends ack — receipt forwarding should create a MessageRecord
    ack_envelope = _build_envelope(
        sk_b, bob_key, bob_id, alice_id, msg_type="ack", reply_to=envelope["msg_id"]
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value="CONNECTION_REFUSED"):
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
    """Receipt forwarding marks delivered when immediate forward succeeds."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )

    ack_envelope = _build_envelope(
        sk_b, bob_key, bob_id, alice_id, msg_type="ack", reply_to=envelope["msg_id"]
    )
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post("/hub/receipt", json=ack_envelope)
    assert resp.status_code == 200

    # Receipt record should be delivered
    result = await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == ack_envelope["msg_id"])
    )
    receipt_rec = result.scalar_one()
    assert receipt_rec.state == MessageState.delivered


# ===========================================================================
# TTL error receipt tests (retry module)
# ===========================================================================


def test_build_ttl_error_envelope():
    """Hub-generated TTL error envelope has correct structure."""
    from hub.retry import _build_ttl_error_envelope
    import json as _json

    # Create a fake record
    record = MessageRecord(
        hub_msg_id="h_test",
        msg_id="original-msg-id",
        sender_id="ag_alice",
        receiver_id="ag_bob",
        envelope_json=_json.dumps({"type": "message"}),
        ttl_sec=60,
    )

    env = _build_ttl_error_envelope(record)
    assert env["type"] == "error"
    assert env["from"] == "hub"
    assert env["to"] == "ag_alice"
    assert env["reply_to"] == "original-msg-id"
    assert env["payload"]["error"]["code"] == "TTL_EXPIRED"


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
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value="CONNECTION_REFUSED"):
        with patch("hub.routers.hub._resolve_endpoint_url", new_callable=AsyncMock, return_value=None):
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

    # Record should still be queued
    result = await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == envelope["msg_id"])
    )
    rec = result.scalar_one()
    assert rec.state == MessageState.queued

    # Polling again should still return the message
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"ack": "false", "timeout": 0},
    )
    assert resp.json()["count"] == 1


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

    # Poll with limit=50 (more than available)
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"limit": 50, "timeout": 0, "ack": "false"},
    )
    data = resp.json()
    assert data["count"] == 3
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
# Payload conversion and webhook auth tests
# ===========================================================================


def test_convert_payload_for_openclaw_agent():
    """Envelope to /agent path → {message, name} format."""
    from hub.routers.hub import _convert_payload_for_openclaw
    from hub.schemas import MessageEnvelope

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hello"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )
    result = _convert_payload_for_openclaw("https://example.com/agent", envelope)
    assert "message" in result
    assert result["name"] == "ag_sender"
    assert "text" not in result  # not the raw payload format


def test_convert_payload_for_openclaw_wake():
    """Envelope to /wake path → {text, mode} format."""
    from hub.routers.hub import _convert_payload_for_openclaw
    from hub.schemas import MessageEnvelope

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="contact_removed",
        payload={"removed_by": "ag_sender"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )
    result = _convert_payload_for_openclaw("https://example.com/wake", envelope)
    assert "body" in result
    assert result["mode"] == "now"
    assert "message" not in result


@pytest.mark.asyncio
async def test_forward_envelope_with_token(client: AsyncClient):
    """_forward_envelope includes Authorization header when webhook_token is set."""
    from hub.routers.hub import _forward_envelope
    from hub.schemas import MessageEnvelope

    mock_client = AsyncMock(spec=AsyncClient)
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_client.post.return_value = mock_response

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hi"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )

    result = await _forward_envelope(
        mock_client, "https://example.com", envelope, webhook_token="my-secret"
    )
    assert result is None
    call_kwargs = mock_client.post.call_args
    assert call_kwargs.kwargs["headers"]["Authorization"] == "Bearer my-secret"


@pytest.mark.asyncio
async def test_forward_envelope_without_token(client: AsyncClient):
    """_forward_envelope does not include Authorization header when no token."""
    from hub.routers.hub import _forward_envelope
    from hub.schemas import MessageEnvelope

    mock_client = AsyncMock(spec=AsyncClient)
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_client.post.return_value = mock_response

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hi"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )

    result = await _forward_envelope(
        mock_client, "https://example.com", envelope
    )
    assert result is None
    call_kwargs = mock_client.post.call_args
    assert "Authorization" not in call_kwargs.kwargs.get("headers", {})


# ===========================================================================
# _forward_envelope structured error tests
# ===========================================================================


@pytest.mark.asyncio
async def test_forward_envelope_http_error(client: AsyncClient):
    """_forward_envelope returns 'HTTP <status>' on non-2xx response."""
    from hub.routers.hub import _forward_envelope
    from hub.schemas import MessageEnvelope

    mock_client = AsyncMock(spec=AsyncClient)
    mock_response = AsyncMock()
    mock_response.status_code = 503
    mock_client.post.return_value = mock_response

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hi"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )

    result = await _forward_envelope(
        mock_client, "https://example.com", envelope
    )
    assert result == "HTTP 503"


@pytest.mark.asyncio
async def test_forward_envelope_connect_error(client: AsyncClient):
    """_forward_envelope returns 'CONNECTION_REFUSED' on ConnectError."""
    from hub.routers.hub import _forward_envelope
    from hub.schemas import MessageEnvelope

    mock_client = AsyncMock(spec=AsyncClient)
    mock_client.post.side_effect = httpx.ConnectError("refused")

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hi"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )

    result = await _forward_envelope(
        mock_client, "https://example.com", envelope
    )
    assert result == "CONNECTION_REFUSED"


@pytest.mark.asyncio
async def test_forward_envelope_timeout(client: AsyncClient):
    """_forward_envelope returns 'TIMEOUT' on TimeoutException."""
    from hub.routers.hub import _forward_envelope
    from hub.schemas import MessageEnvelope

    mock_client = AsyncMock(spec=AsyncClient)
    mock_client.post.side_effect = httpx.ReadTimeout("timed out")

    envelope = MessageEnvelope(
        msg_id="test-id",
        ts=1000000,
        **{"from": "ag_sender"},
        to="ag_receiver",
        type="message",
        payload={"text": "hi"},
        payload_hash="sha256:abc",
        sig={"alg": "ed25519", "key_id": "k_1", "value": "sig"},
    )

    result = await _forward_envelope(
        mock_client, "https://example.com", envelope
    )
    assert result == "TIMEOUT"


# ===========================================================================
# Delivery note tests
# ===========================================================================


def test_build_delivery_note_none_on_success():
    """No last_error → delivery_note is None."""
    from hub.routers.hub import _build_delivery_note

    assert _build_delivery_note(None) is None
    assert _build_delivery_note("") is None


def test_build_delivery_note_known_errors():
    """Known error codes map to specific diagnostic messages."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("HTTP 401")
    assert "401" in note
    assert "webhook_token" in note

    note = _build_delivery_note("CONNECTION_REFUSED")
    assert "endpoint" in note

    note = _build_delivery_note("TIMEOUT")
    assert "超时" in note

    note = _build_delivery_note("TTL_EXPIRED")
    assert "重试" in note

    note = _build_delivery_note("NO_ENDPOINT")
    assert "endpoint" in note.lower()


def test_build_delivery_note_http_5xx():
    """HTTP 5xx errors get server error message."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("HTTP 502")
    assert "502" in note
    assert "服务器错误" in note


def test_build_delivery_note_http_4xx():
    """HTTP 4xx errors get rejection message."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("HTTP 422")
    assert "422" in note
    assert "被拒绝" in note


def test_build_delivery_note_fallback():
    """Unknown error codes get fallback message."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("SOME_UNKNOWN_ERROR")
    assert "SOME_UNKNOWN_ERROR" in note
    assert "投递失败" in note


@pytest.mark.asyncio
async def test_inbox_delivery_note_on_webhook_failure(client: AsyncClient):
    """Webhook push failure → inbox returns message with non-null delivery_note."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    # Set Bob's policy to open so Alice can send
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(bob_token),
    )

    # Send a message (will be queued since no endpoint)
    envelope = await _send_queued_message(
        client, sk_a, alice_key, alice_id, bob_id, alice_token
    )

    # Bob polls — should see the message with a delivery_note
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"timeout": 0, "ack": "false"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    msg = data["messages"][0]
    assert msg["envelope"]["msg_id"] == envelope["msg_id"]
    assert msg["delivery_note"] is not None
    assert len(msg["delivery_note"]) > 0


@pytest.mark.asyncio
async def test_inbox_no_delivery_note_on_success(client: AsyncClient):
    """Successfully delivered message has no delivery_note when re-queued manually."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b,
        bob_id,
        bob_key,
        bob_token,
    ) = await _setup_two_agents(client)

    # Set Bob's policy to open so Alice can send
    await client.patch(
        f"/registry/agents/{bob_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(bob_token),
    )

    # Drain any welcome messages from Bob's inbox first
    await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"timeout": 0},
    )

    # Send a message with successful webhook
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock, return_value=None):
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )
    assert resp.status_code == 202
    assert resp.json()["status"] == "delivered"

    # Bob polls — delivered messages don't appear in inbox (they're not queued)
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(bob_token),
        params={"timeout": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


# ===========================================================================
# Webhook failure handling: endpoint unreachable + error notification tests
# ===========================================================================


@pytest.mark.asyncio
async def test_ttl_expired_stores_error_as_message_record(db_session: AsyncSession):
    """TTL expiry stores an error notification as a MessageRecord for the sender."""
    import datetime
    from hub.retry import _retry_batch

    now = datetime.datetime.now(datetime.timezone.utc)

    # Create a queued message that has expired
    record = MessageRecord(
        hub_msg_id="h_test_ttl_1",
        msg_id="msg-ttl-test-1",
        sender_id="ag_sender",
        receiver_id="ag_receiver",
        state=MessageState.queued,
        envelope_json='{"v":"a2a/0.1","msg_id":"msg-ttl-test-1","ts":1000000,"from":"ag_sender","to":"ag_receiver","type":"message","reply_to":null,"ttl_sec":1,"payload":{"text":"hi"},"payload_hash":"sha256:abc","sig":{"alg":"ed25519","key_id":"k_1","value":""}}',
        ttl_sec=1,
        created_at=now - datetime.timedelta(seconds=60),
        next_retry_at=now - datetime.timedelta(seconds=1),
        last_error="CONNECTION_REFUSED",
    )
    db_session.add(record)
    await db_session.commit()

    # Patch async_session to use our test session
    from unittest.mock import patch as _patch
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_session():
        yield db_session

    mock_http = AsyncMock(spec=httpx.AsyncClient)
    with _patch("hub.retry.async_session", fake_session):
        await _retry_batch(mock_http)

    # The sender should now have an error notification in their inbox
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == "ag_sender",
            MessageRecord.sender_id == "hub",
        )
    )
    error_records = list(result.scalars().all())
    assert len(error_records) >= 1
    import json as _json
    env = _json.loads(error_records[0].envelope_json)
    assert env["type"] == "error"
    assert env["payload"]["error"]["code"] == "TTL_EXPIRED"
    assert env["to"] == "ag_sender"
    assert env["reply_to"] == "msg-ttl-test-1"


@pytest.mark.asyncio
async def test_ttl_expired_marks_endpoint_unreachable(db_session: AsyncSession):
    """Webhook failure causing TTL expiry marks receiver's endpoint as unreachable."""
    import datetime
    from hub.models import Endpoint, EndpointState
    from hub.retry import _retry_batch

    now = datetime.datetime.now(datetime.timezone.utc)

    # Create an active endpoint for the receiver
    from hub.models import Agent
    db_session.add(Agent(agent_id="ag_rcv_unr", display_name="rcv"))
    await db_session.flush()
    ep = Endpoint(
        agent_id="ag_rcv_unr",
        endpoint_id="ep_test_unr",
        url="http://dead-host:9999/hook",
        state=EndpointState.active,
    )
    db_session.add(ep)
    await db_session.flush()

    # Create an expired queued message with a webhook error
    record = MessageRecord(
        hub_msg_id="h_test_unr_1",
        msg_id="msg-unr-test-1",
        sender_id="ag_sender_unr",
        receiver_id="ag_rcv_unr",
        state=MessageState.queued,
        envelope_json='{"v":"a2a/0.1","msg_id":"msg-unr-test-1","ts":1000000,"from":"ag_sender_unr","to":"ag_rcv_unr","type":"message","reply_to":null,"ttl_sec":1,"payload":{"text":"hi"},"payload_hash":"sha256:abc","sig":{"alg":"ed25519","key_id":"k_1","value":""}}',
        ttl_sec=1,
        created_at=now - datetime.timedelta(seconds=60),
        next_retry_at=now - datetime.timedelta(seconds=1),
        last_error="CONNECTION_REFUSED",
    )
    db_session.add(record)
    await db_session.commit()

    from unittest.mock import patch as _patch
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_session():
        yield db_session

    mock_http = AsyncMock(spec=httpx.AsyncClient)
    with _patch("hub.retry.async_session", fake_session):
        await _retry_batch(mock_http)

    # Endpoint should be marked unreachable
    await db_session.refresh(ep)
    assert ep.state == EndpointState.unreachable


@pytest.mark.asyncio
async def test_ttl_expired_notifies_receiver(db_session: AsyncSession):
    """TTL expiry due to webhook failure stores ENDPOINT_UNREACHABLE notification for receiver."""
    import datetime
    from hub.models import Endpoint, EndpointState
    from hub.retry import _retry_batch

    now = datetime.datetime.now(datetime.timezone.utc)

    from hub.models import Agent
    db_session.add(Agent(agent_id="ag_rcv_notif", display_name="rcv"))
    await db_session.flush()
    ep = Endpoint(
        agent_id="ag_rcv_notif",
        endpoint_id="ep_test_notif",
        url="http://dead-host:9999/hook",
        state=EndpointState.active,
    )
    db_session.add(ep)
    await db_session.flush()

    record = MessageRecord(
        hub_msg_id="h_test_notif_1",
        msg_id="msg-notif-test-1",
        sender_id="ag_sender_notif",
        receiver_id="ag_rcv_notif",
        state=MessageState.queued,
        envelope_json='{"v":"a2a/0.1","msg_id":"msg-notif-test-1","ts":1000000,"from":"ag_sender_notif","to":"ag_rcv_notif","type":"message","reply_to":null,"ttl_sec":1,"payload":{"text":"hi"},"payload_hash":"sha256:abc","sig":{"alg":"ed25519","key_id":"k_1","value":""}}',
        ttl_sec=1,
        created_at=now - datetime.timedelta(seconds=60),
        next_retry_at=now - datetime.timedelta(seconds=1),
        last_error="TIMEOUT",
    )
    db_session.add(record)
    await db_session.commit()

    from unittest.mock import patch as _patch
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_session():
        yield db_session

    mock_http = AsyncMock(spec=httpx.AsyncClient)
    with _patch("hub.retry.async_session", fake_session):
        await _retry_batch(mock_http)

    # Receiver should have an ENDPOINT_UNREACHABLE notification
    import json as _json
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == "ag_rcv_notif",
            MessageRecord.sender_id == "hub",
        )
    )
    notif_records = list(result.scalars().all())
    assert len(notif_records) >= 1
    env = _json.loads(notif_records[0].envelope_json)
    assert env["type"] == "error"
    assert env["payload"]["error"]["code"] == "ENDPOINT_UNREACHABLE"


@pytest.mark.asyncio
async def test_unreachable_endpoint_skips_webhook(client: AsyncClient, db_session: AsyncSession):
    """When endpoint is unreachable, messages are queued with ENDPOINT_UNREACHABLE, no webhook."""
    from hub.models import Endpoint, EndpointState

    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    # Mark Bob's endpoint as unreachable
    result = await db_session.execute(
        select(Endpoint).where(Endpoint.agent_id == bob_id)
    )
    bob_ep = result.scalar_one()
    bob_ep.state = EndpointState.unreachable
    await db_session.commit()

    # Alice sends a message to Bob
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    # _forward_envelope should NOT be called
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock) as mock_fwd:
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )
    assert resp.status_code == 202
    assert resp.json()["status"] == "queued"
    mock_fwd.assert_not_called()

    # Verify message record has ENDPOINT_UNREACHABLE and no next_retry_at
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.msg_id == envelope["msg_id"],
            MessageRecord.receiver_id == bob_id,
        )
    )
    rec = result.scalar_one()
    assert rec.last_error == "ENDPOINT_UNREACHABLE"
    assert rec.next_retry_at is None
    assert rec.state == MessageState.queued


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


@pytest.mark.asyncio
async def test_register_endpoint_restarts_stalled_messages(client: AsyncClient, db_session: AsyncSession):
    """Re-registering endpoint restarts messages that were stalled due to ENDPOINT_UNREACHABLE."""
    import datetime
    from hub.models import Endpoint, EndpointState

    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    # Mark Bob's endpoint as unreachable
    result = await db_session.execute(
        select(Endpoint).where(Endpoint.agent_id == bob_id)
    )
    bob_ep = result.scalar_one()
    bob_ep.state = EndpointState.unreachable
    await db_session.commit()

    # Send a message that gets parked
    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    with patch("hub.routers.hub._forward_envelope", new_callable=AsyncMock) as mock_fwd:
        resp = await client.post(
            "/hub/send", json=envelope, headers=_auth_header(alice_token)
        )
    assert resp.status_code == 202

    # Verify message is parked
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.msg_id == envelope["msg_id"],
            MessageRecord.receiver_id == bob_id,
        )
    )
    rec = result.scalar_one()
    assert rec.last_error == "ENDPOINT_UNREACHABLE"
    assert rec.next_retry_at is None

    # Bob re-registers endpoint
    resp = await client.post(
        f"/registry/agents/{bob_id}/endpoints",
        json={"url": "http://new-bob:8002/inbox", "webhook_token": "new-tok"},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 200

    # Stalled message should now have next_retry_at set
    await db_session.refresh(rec)
    assert rec.next_retry_at is not None
    assert rec.state == MessageState.queued


@pytest.mark.asyncio
async def test_ttl_expired_changes_state_to_failed(db_session: AsyncSession):
    """Bug fix: TTL expiry now correctly sets state to failed (was staying queued)."""
    import datetime
    from hub.retry import _retry_batch

    now = datetime.datetime.now(datetime.timezone.utc)

    record = MessageRecord(
        hub_msg_id="h_test_failed_1",
        msg_id="msg-failed-test-1",
        sender_id="ag_sender_f",
        receiver_id="ag_receiver_f",
        state=MessageState.queued,
        envelope_json='{"v":"a2a/0.1","msg_id":"msg-failed-test-1","ts":1000000,"from":"ag_sender_f","to":"ag_receiver_f","type":"message","reply_to":null,"ttl_sec":1,"payload":{"text":"hi"},"payload_hash":"sha256:abc","sig":{"alg":"ed25519","key_id":"k_1","value":""}}',
        ttl_sec=1,
        created_at=now - datetime.timedelta(seconds=60),
        next_retry_at=now - datetime.timedelta(seconds=1),
        last_error="NO_ENDPOINT",
    )
    db_session.add(record)
    await db_session.commit()

    from unittest.mock import patch as _patch
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_session():
        yield db_session

    mock_http = AsyncMock(spec=httpx.AsyncClient)
    with _patch("hub.retry.async_session", fake_session):
        await _retry_batch(mock_http)

    await db_session.refresh(record)
    assert record.state == MessageState.failed
    assert record.last_error == "TTL_EXPIRED"
    assert record.next_retry_at is None


def test_build_delivery_note_endpoint_unreachable():
    """ENDPOINT_UNREACHABLE error gets a specific delivery note."""
    from hub.routers.hub import _build_delivery_note

    note = _build_delivery_note("ENDPOINT_UNREACHABLE")
    assert note is not None
    assert "不可达" in note
    assert "/registry/agents/" in note
    assert "/hub/inbox" in note

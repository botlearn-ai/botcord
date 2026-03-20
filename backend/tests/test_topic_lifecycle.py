"""Tests for Topic lifecycle feature: topic/goal in envelope, signing, send, receipt, inbox, history."""

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
# Fixtures (same pattern as test_m3_hub.py)
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
    topic: str | None = None,
    goal: str | None = None,
    version: str = "a2a/0.1",
) -> dict:
    """Build a signed MessageEnvelope dict with optional topic/goal."""
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        version,
        msg_id,
        str(ts),
        from_id,
        to_id,
        msg_type,
        reply_to or "",
        str(ttl_sec),
        payload_hash,
    ]
    # a2a/0.2+ includes topic and goal in signing input
    if version != "a2a/0.1":
        parts.append(topic or "")
        parts.append(goal or "")

    signing_input = "\n".join(parts).encode()
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()

    env = {
        "v": version,
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
    if topic is not None:
        env["topic"] = topic
    if goal is not None:
        env["goal"] = goal
    return env


async def _setup_two_agents(client: AsyncClient):
    """Register Alice and Bob with open policy and endpoints."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(client, sk_a, pub_a, "alice")
    await client.post(
        f"/registry/agents/{alice_id}/endpoints",
        json={"url": "http://alice:8001/inbox", "webhook_token": "alice-tok"},
        headers=_auth_header(alice_token),
    )
    await client.patch(
        f"/registry/agents/{alice_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(alice_token),
    )

    sk_b, pub_b = _make_keypair()
    bob_id, bob_key, bob_token = await _register_and_verify(client, sk_b, pub_b, "bob")
    await client.post(
        f"/registry/agents/{bob_id}/endpoints",
        json={"url": "http://bob:8002/inbox", "webhook_token": "bob-tok"},
        headers=_auth_header(bob_token),
    )
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
# M1: Schema & Crypto tests for topic/goal
# ===========================================================================


class TestEnvelopeTopicGoal:
    """MessageEnvelope schema tests for topic/goal fields."""

    def test_envelope_with_topic_goal(self):
        """Envelope accepts topic and goal fields."""
        from hub.schemas import MessageEnvelope
        from hub.crypto import compute_payload_hash

        payload = {"text": "hi"}
        env = MessageEnvelope(
            msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="do something",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        assert env.topic == "t1"
        assert env.goal == "do something"

    def test_envelope_without_topic_goal_backward_compat(self):
        """Envelope works without topic/goal (backward compatibility)."""
        from hub.schemas import MessageEnvelope
        from hub.crypto import compute_payload_hash

        payload = {"text": "hi"}
        env = MessageEnvelope(
            msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600,
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        assert env.topic is None
        assert env.goal is None

    def test_envelope_serialization_includes_topic_goal(self):
        """topic/goal appear in serialized output."""
        from hub.schemas import MessageEnvelope
        from hub.crypto import compute_payload_hash

        payload = {"text": "hi"}
        env = MessageEnvelope(
            msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="translate",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        data = env.model_dump(by_alias=True)
        assert data["topic"] == "t1"
        assert data["goal"] == "translate"

        # Round-trip
        restored = MessageEnvelope.model_validate(data)
        assert restored.topic == "t1"
        assert restored.goal == "translate"


class TestSigningInputVersioning:
    """Signing input tests for a2a/0.1 vs a2a/0.2."""

    def test_v01_signing_excludes_topic_goal(self):
        """a2a/0.1 signing input has 9 parts (no topic/goal)."""
        from hub.crypto import build_signing_input, compute_payload_hash
        from hub.schemas import MessageEnvelope

        payload = {"text": "hi"}
        env = MessageEnvelope(
            v="a2a/0.1", msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="translate",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        si = build_signing_input(env)
        parts = si.decode().split("\n")
        assert len(parts) == 9
        # topic and goal should NOT be in the signing input
        assert "t1" not in parts
        assert "translate" not in parts

    def test_v02_signing_includes_topic_goal(self):
        """a2a/0.2 signing input has 11 parts (with topic/goal)."""
        from hub.crypto import build_signing_input, compute_payload_hash
        from hub.schemas import MessageEnvelope

        payload = {"text": "hi"}
        env = MessageEnvelope(
            v="a2a/0.2", msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="translate",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        si = build_signing_input(env)
        parts = si.decode().split("\n")
        assert len(parts) == 11
        assert parts[9] == "t1"
        assert parts[10] == "translate"

    def test_v02_signing_empty_topic_goal(self):
        """a2a/0.2 with no topic/goal uses empty strings in signing input."""
        from hub.crypto import build_signing_input, compute_payload_hash
        from hub.schemas import MessageEnvelope

        payload = {"text": "hi"}
        env = MessageEnvelope(
            v="a2a/0.2", msg_id="m1", ts=1000, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600,
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "sig"},
        )
        si = build_signing_input(env)
        parts = si.decode().split("\n")
        assert len(parts) == 11
        assert parts[9] == ""
        assert parts[10] == ""

    def test_v02_sign_verify_roundtrip(self):
        """Sign and verify with a2a/0.2 format including topic/goal."""
        from hub.crypto import compute_payload_hash, sign_envelope, verify_envelope_sig
        from hub.schemas import MessageEnvelope

        sk = SigningKey.generate()
        priv_b64 = base64.b64encode(bytes(sk)).decode()
        pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()

        payload = {"text": "hi"}
        env = MessageEnvelope(
            v="a2a/0.2", msg_id="m1", ts=int(time.time()), **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="translate doc",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "placeholder"},
        )
        env.sig = sign_envelope(env, priv_b64, "k1")
        assert verify_envelope_sig(env, pub_b64)

    def test_v01_v02_signatures_differ(self):
        """Same envelope content with different versions produces different signatures."""
        from hub.crypto import compute_payload_hash, sign_envelope
        from hub.schemas import MessageEnvelope

        sk = SigningKey.generate()
        priv_b64 = base64.b64encode(bytes(sk)).decode()

        payload = {"text": "hi"}
        ts = int(time.time())
        common = dict(
            msg_id="m1", ts=ts, **{"from": "ag_a"}, to="ag_b",
            type="message", ttl_sec=3600, topic="t1", goal="translate",
            payload=payload, payload_hash=compute_payload_hash(payload),
            sig={"alg": "ed25519", "key_id": "k1", "value": "placeholder"},
        )

        env_v1 = MessageEnvelope(v="a2a/0.1", **common)
        env_v2 = MessageEnvelope(v="a2a/0.2", **common)

        sig_v1 = sign_envelope(env_v1, priv_b64, "k1")
        sig_v2 = sign_envelope(env_v2, priv_b64, "k1")
        assert sig_v1.value != sig_v2.value


# ===========================================================================
# Integration: /hub/send with topic/goal
# ===========================================================================


@pytest.mark.asyncio
async def test_send_with_topic_goal_in_envelope(client: AsyncClient):
    """Send with topic/goal in envelope — stored in MessageRecord."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        topic="topic_001", goal="translate README",
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    # Verify topic/goal appear in history
    resp = await client.get(
        "/hub/history",
        params={"peer": bob_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert len(messages) >= 1
    msg = messages[0]
    assert msg["topic"] == "topic_001"
    assert msg["goal"] == "translate README"


@pytest.mark.asyncio
async def test_send_topic_envelope_overrides_query_param(client: AsyncClient):
    """Envelope topic takes precedence over query param topic."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        topic="from_envelope",
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        params={"topic": "from_query_param"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    resp = await client.get(
        "/hub/history",
        params={"peer": bob_id},
        headers=_auth_header(alice_token),
    )
    messages = resp.json()["messages"]
    assert messages[0]["topic"] == "from_envelope"


@pytest.mark.asyncio
async def test_send_topic_falls_back_to_query_param(client: AsyncClient):
    """When envelope has no topic, query param is used."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)
    # No topic in envelope

    resp = await client.post(
        "/hub/send",
        json=envelope,
        params={"topic": "from_query"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    resp = await client.get(
        "/hub/history",
        params={"peer": bob_id},
        headers=_auth_header(alice_token),
    )
    messages = resp.json()["messages"]
    assert messages[0]["topic"] == "from_query"


@pytest.mark.asyncio
async def test_send_without_topic_or_goal(client: AsyncClient):
    """Backward compat: send without topic/goal still works."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(sk_a, alice_key, alice_id, bob_id)

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    resp = await client.get(
        "/hub/history",
        params={"peer": bob_id},
        headers=_auth_header(alice_token),
    )
    messages = resp.json()["messages"]
    assert messages[0]["topic"] is None
    assert messages[0]["goal"] is None


# ===========================================================================
# /hub/send with type=result and type=error
# ===========================================================================


@pytest.mark.asyncio
async def test_send_result_type_accepted(client: AsyncClient):
    """type=result is accepted on /hub/send for topic termination."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        msg_type="result",
        topic="topic_001",
        payload={"text": "task done", "result": {"file": "out.txt"}},
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_send_error_type_accepted(client: AsyncClient):
    """type=error is accepted on /hub/send for topic termination."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        msg_type="error",
        topic="topic_001",
        payload={"text": "failed", "error_code": "FILE_NOT_FOUND"},
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202


@pytest.mark.asyncio
async def test_send_ack_type_rejected(client: AsyncClient):
    """type=ack is still rejected on /hub/send (use /hub/receipt)."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        msg_type="ack",
        payload={"text": "ack"},
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 400


# ===========================================================================
# Inbox polling: goal field
# ===========================================================================


async def _setup_two_agents_no_endpoint(client: AsyncClient):
    """Register Alice and Bob with open policy but NO endpoints (messages queue for inbox)."""
    sk_a, pub_a = _make_keypair()
    alice_id, alice_key, alice_token = await _register_and_verify(client, sk_a, pub_a, "alice")
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


@pytest.mark.asyncio
async def test_inbox_includes_goal(client: AsyncClient):
    """Inbox poll response includes the goal field."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents_no_endpoint(client)

    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        topic="topic_inbox", goal="check inbox goal",
    )

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    # Poll Bob's inbox
    resp = await client.get(
        "/hub/inbox",
        params={"timeout": 0},
        headers=_auth_header(bob_token),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert len(messages) >= 1
    msg = messages[0]
    assert msg["topic"] == "topic_inbox"
    assert msg["goal"] == "check inbox goal"


# ===========================================================================
# Receipt: topic/goal carried through
# ===========================================================================


@pytest.mark.asyncio
async def test_receipt_carries_topic(client: AsyncClient):
    """Receipt forwarding carries topic from original message."""
    (sk_a, alice_id, alice_key, alice_token), (
        sk_b, bob_id, bob_key, bob_token,
    ) = await _setup_two_agents(client)

    # Send message with topic
    envelope = _build_envelope(
        sk_a, alice_key, alice_id, bob_id,
        topic="topic_receipt",
        goal="test receipt topic",
    )
    msg_id = envelope["msg_id"]

    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 202

    # Bob sends result receipt
    receipt = _build_envelope(
        sk_b, bob_key, bob_id, alice_id,
        msg_type="result",
        reply_to=msg_id,
        topic="topic_receipt",
        payload={"text": "done"},
    )

    resp = await client.post(
        "/hub/receipt",
        json=receipt,
    )
    assert resp.status_code == 200

    # Check Alice's history — receipt should have topic
    resp = await client.get(
        "/hub/history",
        params={"peer": bob_id, "topic": "topic_receipt"},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    # Should contain both the original message and the forwarded receipt
    assert len(messages) >= 1
    topics = {m["topic"] for m in messages}
    assert "topic_receipt" in topics


# ===========================================================================
# Unit tests: to_text() with topic/goal formatting
# ===========================================================================


class TestToTextTopicGoal:
    """Verify that to_text() prepends topic/goal with distinctive markers."""

    def _make_envelope(self, **overrides):
        from hub.schemas import MessageEnvelope

        defaults = {
            "v": "a2a/0.1",
            "msg_id": str(uuid.uuid4()),
            "ts": int(time.time()),
            "from": "ag_alice",
            "to": "ag_bob",
            "type": "message",
            "reply_to": None,
            "ttl_sec": 3600,
            "payload": {"text": "hello"},
            "payload_hash": "sha256:abc",
            "sig": {"alg": "ed25519", "key_id": "k1", "value": "fake"},
        }
        defaults.update(overrides)
        return MessageEnvelope(**defaults)

    def test_no_topic_no_goal(self):
        """Without topic/goal, output is unchanged."""
        env = self._make_envelope()
        text = env.to_text()
        assert text == "ag_alice says: hello"
        assert "Topic" not in text
        assert "Goal" not in text

    def test_topic_only(self):
        """Topic appears with 【】 markers."""
        env = self._make_envelope(topic="translate_doc")
        text = env.to_text()
        assert "【Topic: translate_doc】" in text
        assert "ag_alice says: hello" in text
        assert "Goal" not in text

    def test_topic_with_topic_id(self):
        """Topic line includes topic_id when provided by caller."""
        env = self._make_envelope(topic="translate_doc")
        text = env.to_text(topic_id="tp_123")
        assert "【Topic: translate_doc | ID: tp_123】" in text

    def test_goal_only(self):
        """Goal appears with 【】 markers."""
        env = self._make_envelope(goal="翻译 README")
        text = env.to_text()
        assert "【Goal: 翻译 README】" in text
        assert "ag_alice says: hello" in text

    def test_topic_and_goal(self):
        """Both topic and goal appear, each on its own line before the message."""
        env = self._make_envelope(topic="translate_doc", goal="翻译 README")
        text = env.to_text(topic_id="tp_123")
        lines = text.split("\n")
        assert lines[0] == "【Topic: translate_doc | ID: tp_123】"
        assert lines[1] == "【Goal: 翻译 README】"
        assert lines[2] == "ag_alice says: hello"

    def test_topic_goal_with_sender_name(self):
        """Topic/goal line + sender name rendering."""
        env = self._make_envelope(topic="task_001", goal="do something")
        text = env.to_text(sender_name="Alice")
        assert "【Topic: task_001】" in text
        assert "【Goal: do something】" in text
        assert "Alice (ag_alice) says: hello" in text

    def test_result_type_with_topic(self):
        """Termination signal (result) also carries topic/goal context."""
        env = self._make_envelope(
            type="result",
            topic="translate_doc",
            goal="翻译 README",
            payload={"text": "done", "result": {"file": "README_zh.md"}},
        )
        text = env.to_text(sender_name="Bob")
        assert "【Topic: translate_doc】" in text
        assert "【Goal: 翻译 README】" in text
        assert "Result from Bob (ag_alice)" in text

    def test_error_type_with_topic(self):
        """Termination signal (error) also carries topic/goal context."""
        env = self._make_envelope(
            type="error",
            topic="translate_doc",
            payload={"error": {"code": "FILE_NOT_FOUND", "message": "no such file"}},
        )
        text = env.to_text()
        assert "【Topic: translate_doc】" in text
        assert "Error from ag_alice: FILE_NOT_FOUND: no such file" in text


class TestBuildFlatTextRoomRule:
    """Verify build_flat_text() prepends room rule guidance for room messages."""

    def test_room_rule_guidance_and_topic_id(self):
        from hub.forward import RoomContext, build_flat_text
        from hub.schemas import MessageEnvelope

        env = MessageEnvelope(
            v="a2a/0.1",
            msg_id=str(uuid.uuid4()),
            ts=int(time.time()),
            **{"from": "ag_alice"},
            to="rm_ops",
            type="message",
            reply_to=None,
            ttl_sec=3600,
            topic="deploy_status",
            goal="post updates",
            payload={"text": "deploy started"},
            payload_hash="sha256:abc",
            sig={"alg": "ed25519", "key_id": "k1", "value": "fake"},
        )
        room_ctx = RoomContext(
            room_id="rm_ops",
            name="Ops Room",
            member_count=3,
            rule="Only post deploy status updates.",
            member_names=["alice", "bob", "carol"],
            my_role="member",
            my_can_send=True,
        )

        text = build_flat_text(
            env,
            sender_display_name="Alice",
            room_context=room_ctx,
            topic_id="tp_123",
        )

        lines = text.split("\n")
        assert lines[0] == "[群聊「Ops Room」(rm_ops) | 3人: alice, bob, carol | 权限: member, 可发言]"
        assert lines[1] == "[房间规则] Only post deploy status updates."
        assert lines[2] == "[系统提示] 你在该群聊中的行为和回复必须遵循上述房间规则。"
        assert lines[3] == "【Topic: deploy_status | ID: tp_123】"
        assert lines[4] == "【Goal: post updates】"
        assert lines[5] == "Alice (ag_alice) says: deploy started"

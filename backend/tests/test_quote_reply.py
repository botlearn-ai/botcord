"""Quote-reply (reply_to on type=message) tests.

Covers:
- /hub/send validation (same-room ok, cross-room reject, missing target reject)
- DM room support
- MessageRecord.reply_to_msg_id persistence (and NOT being set for receipts)
- /hub/history and /hub/inbox reply_preview output (incl. deleted tombstone)
"""

import base64
import datetime
import hashlib
import json
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Base, MessageRecord

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures (mirror tests/test_room.py)
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
    client: AsyncClient, sk: SigningKey, pubkey_str: str, display_name: str
):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": "test"},
    )
    assert resp.status_code == 201, resp.text
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
    return agent_id, key_id, resp.json()["agent_token"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_agent(client: AsyncClient, name: str):
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth(token),
    )
    return sk, agent_id, key_id, token


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    *,
    msg_type: str = "message",
    reply_to: str | None = None,
    payload: dict | None = None,
    ttl_sec: int = 3600,
) -> dict:
    if payload is None:
        payload = {"text": "hello world"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, reply_to or "", str(ttl_sec), payload_hash,
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
        "reply_to": reply_to,
        "ttl_sec": ttl_sec,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


async def _create_room(client: AsyncClient, owner_token: str, member_ids: list[str], name: str = "Room"):
    resp = await client.post(
        "/hub/rooms",
        json={"name": name, "member_ids": member_ids},
        headers=_auth(owner_token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["room_id"]


async def _send_room(client, sk, key_id, from_id, room_id, token, *, reply_to=None, text="hi"):
    env = _build_envelope(
        sk, key_id, from_id, room_id, reply_to=reply_to, payload={"text": text}
    )
    resp = await client.post("/hub/send", json=env, headers=_auth(token))
    return resp, env["msg_id"]


# ===========================================================================
# /hub/send validation
# ===========================================================================


@pytest.mark.asyncio
async def test_room_quote_reply_same_room_ok(client: AsyncClient, db_session: AsyncSession):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    # Alice posts the original
    resp, orig_msg_id = await _send_room(client, sk_a, a_key, a_id, room_id, a_tok, text="hello")
    assert resp.status_code == 202

    # Bob replies referencing orig_msg_id
    resp, reply_msg_id = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok,
        reply_to=orig_msg_id, text="agreed",
    )
    assert resp.status_code == 202, resp.text

    # MessageRecord(s) for the reply carry reply_to_msg_id
    row = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == reply_msg_id)
    )).scalar_one()
    assert row.reply_to_msg_id == orig_msg_id


@pytest.mark.asyncio
async def test_room_quote_reply_cross_room_rejected(client: AsyncClient):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_one = await _create_room(client, a_tok, [b_id], name="One")
    room_two = await _create_room(client, a_tok, [b_id], name="Two")

    # Original lives in room_one
    resp, orig_msg_id = await _send_room(client, sk_a, a_key, a_id, room_one, a_tok)
    assert resp.status_code == 202

    # Bob tries to reply from room_two
    resp, _ = await _send_room(
        client, sk_b, b_key, b_id, room_two, b_tok, reply_to=orig_msg_id,
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "reply_target_cross_room"


@pytest.mark.asyncio
async def test_room_quote_reply_accepts_hub_msg_id(client: AsyncClient, db_session: AsyncSession):
    """Backwards-compat: daemons currently emit envelope.reply_to = hub_msg_id
    (h_*) instead of envelope msg_id. The hub must accept the hub_msg_id form
    and persist the *canonical* envelope msg_id into reply_to_msg_id so that
    history / preview / scroll-to-message stay consistent."""
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    # Alice posts original; capture its hub_msg_id from the send response
    env_orig = _build_envelope(sk_a, a_key, a_id, room_id, payload={"text": "hi from alice"})
    resp = await client.post("/hub/send", json=env_orig, headers=_auth(a_tok))
    assert resp.status_code == 202
    orig_hub_msg_id = resp.json()["hub_msg_id"]
    assert orig_hub_msg_id.startswith("h_")
    orig_msg_id = env_orig["msg_id"]

    # Bob replies — using hub_msg_id as reply_to (the way daemons currently emit)
    env_reply = _build_envelope(
        sk_b, b_key, b_id, room_id, reply_to=orig_hub_msg_id, payload={"text": "got it"},
    )
    resp = await client.post("/hub/send", json=env_reply, headers=_auth(b_tok))
    assert resp.status_code == 202, resp.text

    # MessageRecord.reply_to_msg_id should hold the *envelope* msg_id, not hub_msg_id
    row = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == env_reply["msg_id"])
    )).scalar_one()
    assert row.reply_to_msg_id == orig_msg_id
    assert row.reply_to_msg_id != orig_hub_msg_id


@pytest.mark.asyncio
async def test_room_quote_reply_target_not_found(client: AsyncClient):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    resp, _ = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok, reply_to="does-not-exist",
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "reply_target_not_found"


@pytest.mark.asyncio
async def test_dm_quote_reply_ok(client: AsyncClient, db_session: AsyncSession):
    """DM is implemented as an auto-created rm_dm_* room; quote-reply works."""
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")

    # Alice DMs Bob (creates DM room)
    env = _build_envelope(sk_a, a_key, a_id, b_id, payload={"text": "yo"})
    resp = await client.post("/hub/send", json=env, headers=_auth(a_tok))
    assert resp.status_code == 202
    orig_msg_id = env["msg_id"]

    # Bob replies to that msg
    env2 = _build_envelope(
        sk_b, b_key, b_id, a_id, reply_to=orig_msg_id, payload={"text": "sup"}
    )
    resp = await client.post("/hub/send", json=env2, headers=_auth(b_tok))
    assert resp.status_code == 202, resp.text

    row = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == env2["msg_id"])
    )).scalar_one()
    assert row.reply_to_msg_id == orig_msg_id
    assert row.room_id and row.room_id.startswith("rm_dm_")


@pytest.mark.asyncio
async def test_receipt_reply_to_does_not_persist_to_reply_to_msg_id(
    client: AsyncClient, db_session: AsyncSession,
):
    """Receipt envelopes (type=ack/result/error) keep reply_to in envelope only;
    reply_to_msg_id column stays null so receipts don't leak into quote-reply UI."""
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")

    # Alice sends a message to Bob (DM)
    env = _build_envelope(sk_a, a_key, a_id, b_id, payload={"text": "ping"})
    resp = await client.post("/hub/send", json=env, headers=_auth(a_tok))
    assert resp.status_code == 202
    original_msg_id = env["msg_id"]

    # Bob acks (receipt path: /hub/receipt). type=ack carries reply_to.
    ack_env = _build_envelope(
        sk_b, b_key, b_id, a_id,
        msg_type="ack",
        reply_to=original_msg_id,
        payload={"status": "ok"},
    )
    resp = await client.post("/hub/receipt", json=ack_env)
    assert resp.status_code == 200, resp.text

    # The original message MessageRecord rows should NOT have reply_to_msg_id set
    # (ack doesn't go through /hub/send at all)
    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.msg_id == original_msg_id)
    )).scalars().all()
    assert rows
    for r in rows:
        assert r.reply_to_msg_id is None


# ===========================================================================
# /hub/history + /hub/inbox preview output
# ===========================================================================


@pytest.mark.asyncio
async def test_history_returns_reply_preview(client: AsyncClient):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    _, orig_msg_id = await _send_room(client, sk_a, a_key, a_id, room_id, a_tok, text="original text")
    _, _ = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok, reply_to=orig_msg_id, text="my reply",
    )

    resp = await client.get(
        f"/hub/history?room_id={room_id}", headers=_auth(a_tok),
    )
    assert resp.status_code == 200, resp.text
    msgs = resp.json()["messages"]
    reply_rows = [m for m in msgs if m["envelope"]["msg_id"] != orig_msg_id]
    assert reply_rows, "expected at least one reply row in history"
    rp = reply_rows[0]["reply_preview"]
    assert rp is not None
    assert rp["msg_id"] == orig_msg_id
    assert rp["sender_id"] == a_id
    assert rp["sender_display_name"] == "alice"
    assert rp["text_preview"] == "original text"
    assert rp["deleted"] is False


@pytest.mark.asyncio
async def test_inbox_returns_reply_preview(client: AsyncClient):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    _, orig_msg_id = await _send_room(client, sk_a, a_key, a_id, room_id, a_tok, text="hi there")
    _, _ = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok, reply_to=orig_msg_id, text="reply!",
    )

    # Alice polls inbox — she sees Bob's reply with the preview attached
    resp = await client.get("/hub/inbox?ack=true", headers=_auth(a_tok))
    assert resp.status_code == 200, resp.text
    inbox = resp.json()["messages"]
    bob_msgs = [m for m in inbox if m["envelope"]["from"] == b_id]
    assert bob_msgs
    rp = bob_msgs[0]["reply_preview"]
    assert rp is not None
    assert rp["msg_id"] == orig_msg_id
    assert rp["text_preview"] == "hi there"
    assert rp["deleted"] is False


@pytest.mark.asyncio
async def test_history_deleted_target_renders_tombstone(
    client: AsyncClient, db_session: AsyncSession,
):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    _, orig_msg_id = await _send_room(client, sk_a, a_key, a_id, room_id, a_tok, text="will be deleted")
    _, _ = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok, reply_to=orig_msg_id, text="reply",
    )

    # Hard-delete all rows for the original (simulating TTL expiry/cleanup)
    await db_session.execute(
        delete(MessageRecord).where(MessageRecord.msg_id == orig_msg_id)
    )
    await db_session.commit()

    resp = await client.get(
        f"/hub/history?room_id={room_id}", headers=_auth(a_tok),
    )
    assert resp.status_code == 200, resp.text
    msgs = resp.json()["messages"]
    rp = msgs[0]["reply_preview"]
    assert rp is not None
    assert rp["msg_id"] == orig_msg_id
    assert rp["deleted"] is True
    assert rp["text_preview"] is None
    assert rp["sender_id"] is None


@pytest.mark.asyncio
async def test_history_recalled_message_is_omitted_and_reply_preview_tombstoned(
    client: AsyncClient,
    db_session: AsyncSession,
):
    sk_a, a_id, a_key, a_tok = await _create_agent(client, "alice")
    sk_b, b_id, b_key, b_tok = await _create_agent(client, "bob")
    room_id = await _create_room(client, a_tok, [b_id])

    _, orig_msg_id = await _send_room(
        client, sk_a, a_key, a_id, room_id, a_tok, text="secret original text"
    )
    _, reply_msg_id = await _send_room(
        client, sk_b, b_key, b_id, room_id, b_tok, reply_to=orig_msg_id, text="reply",
    )

    recalled_rows = (
        await db_session.execute(
            select(MessageRecord).where(MessageRecord.msg_id == orig_msg_id)
        )
    ).scalars().all()
    assert recalled_rows
    recalled_at = datetime.datetime.now(datetime.timezone.utc)
    for row in recalled_rows:
        row.recalled_at = recalled_at
    await db_session.commit()

    resp = await client.get(
        f"/hub/history?room_id={room_id}", headers=_auth(a_tok),
    )
    assert resp.status_code == 200, resp.text
    msgs = resp.json()["messages"]
    assert all(m["envelope"]["msg_id"] != orig_msg_id for m in msgs)
    assert "secret original text" not in json.dumps(msgs)

    reply_rows = [m for m in msgs if m["envelope"]["msg_id"] == reply_msg_id]
    assert reply_rows
    rp = reply_rows[0]["reply_preview"]
    assert rp is not None
    assert rp["msg_id"] == orig_msg_id
    assert rp["deleted"] is True
    assert rp["text_preview"] is None

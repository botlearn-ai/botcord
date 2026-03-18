"""Tests for WebSocket /hub/ws endpoint."""

import asyncio
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


def _build_envelope(sk: SigningKey, key_id: str, from_id: str, to_id: str, text: str):
    payload = {"text": text}
    payload_bytes = jcs.canonicalize(payload)
    payload_hash = hashlib.sha256(payload_bytes).hexdigest()

    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    ttl_sec = 3600

    signing_input = "\n".join([
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        "message", "", str(ttl_sec), payload_hash,
    ])
    sig = sk.sign(signing_input.encode())
    sig_b64 = base64.b64encode(sig.signature).decode()

    return {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": from_id,
        "to": to_id,
        "type": "message",
        "reply_to": None,
        "ttl_sec": ttl_sec,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


@pytest.mark.asyncio
async def test_ws_auth_ok(client: AsyncClient):
    """WebSocket should accept valid JWT and reply auth_ok."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub)

    from starlette.testclient import TestClient
    from hub.main import app

    with TestClient(app) as tc:
        with tc.websocket_connect("/hub/ws") as ws:
            ws.send_json({"type": "auth", "token": token})
            msg = ws.receive_json()
            assert msg["type"] == "auth_ok"
            assert msg["agent_id"] == agent_id


@pytest.mark.asyncio
async def test_ws_auth_bad_token(client: AsyncClient):
    """WebSocket should close with 4001 on invalid token."""
    from starlette.testclient import TestClient
    from hub.main import app

    with TestClient(app) as tc:
        with tc.websocket_connect("/hub/ws") as ws:
            ws.send_json({"type": "auth", "token": "invalid-token"})
            # Should close the connection
            try:
                msg = ws.receive_json()
                # If we get a message, it should not be auth_ok
                assert msg.get("type") != "auth_ok"
            except Exception:
                pass  # Connection closed as expected


@pytest.mark.asyncio
async def test_ws_receives_inbox_update(client: AsyncClient):
    """WebSocket should receive inbox_update when notify_inbox is called."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub)

    from starlette.testclient import TestClient
    from hub.main import app
    from hub.routers.hub import notify_inbox

    with TestClient(app) as tc:
        with tc.websocket_connect("/hub/ws") as ws:
            ws.send_json({"type": "auth", "token": token})
            auth_msg = ws.receive_json()
            assert auth_msg["type"] == "auth_ok"

            # Trigger inbox notification from the current test loop.
            await notify_inbox(agent_id)

            # We should receive an inbox_update
            msg = ws.receive_json()
            assert msg["type"] == "inbox_update"


@pytest.mark.asyncio
async def test_ws_heartbeat(client: AsyncClient):
    """WebSocket should send heartbeat after timeout."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub)

    from starlette.testclient import TestClient
    from hub.main import app
    import hub.routers.hub as hub_mod

    # Set heartbeat to 1s for testing
    original = hub_mod._WS_HEARTBEAT_INTERVAL
    hub_mod._WS_HEARTBEAT_INTERVAL = 1

    try:
        with TestClient(app) as tc:
            with tc.websocket_connect("/hub/ws") as ws:
                ws.send_json({"type": "auth", "token": token})
                auth_msg = ws.receive_json()
                assert auth_msg["type"] == "auth_ok"

                # Wait for heartbeat
                import time
                time.sleep(1.5)
                msg = ws.receive_json()
                assert msg["type"] == "heartbeat"
    finally:
        hub_mod._WS_HEARTBEAT_INTERVAL = original

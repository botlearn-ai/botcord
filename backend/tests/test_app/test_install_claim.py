"""Tests for the bind-code install onboarding flow.

Covers:
- POST /api/users/me/agents/bind-ticket  (extended response)
- GET  /api/users/me/agents/bind-ticket/{code}
- DELETE /api/users/me/agents/bind-ticket/{code}
- POST /api/users/me/agents/install-claim  (no-JWT redemption)
- GET  /openclaw/install.sh
"""

from __future__ import annotations

import base64
import datetime
import json
import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey as NaClSigningKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hub.id_generators import generate_agent_id
from hub.models import Agent, Base, Role, ShortCode, SigningKey, User, UserRole

from .test_app_user_agents import (
    TEST_JWT_SECRET,
    TEST_SUPABASE_SECRET,
    _make_supabase_token,
)


# ---------------------------------------------------------------------------
# Fixtures (parallel structure to test_app_user_agents.py — kept local so the
# install onboarding suite can evolve independently).
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_engine():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        execution_options={"schema_translate_map": {"public": None}},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, db_engine, monkeypatch):
    import hub.config
    import app.auth
    import app.routers.users as users_mod

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(users_mod, "BIND_PROOF_SECRET", None)
    monkeypatch.setattr(users_mod, "JWT_SECRET", TEST_JWT_SECRET)
    monkeypatch.setattr(hub.config, "BIND_PROOF_SECRET", None)
    monkeypatch.setattr(hub.config, "JWT_SECRET", TEST_JWT_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(users_mod, "_jti_session_factory", factory)
    monkeypatch.setattr(users_mod, "_short_code_session_factory", factory)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def fresh_user(db_session: AsyncSession):
    """User with no agents, agent_owner role registered."""
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Install User",
        email="install@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=5,
    )
    db_session.add(user)

    member_role = Role(
        id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0
    )
    owner_role = Role(
        id=uuid.uuid4(),
        name="agent_owner",
        display_name="Agent Owner",
        is_system=True,
        priority=0,
    )
    db_session.add_all([member_role, owner_role])
    await db_session.flush()
    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=member_role.id))
    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": str(supabase_uuid),
        "token": _make_supabase_token(str(supabase_uuid)),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_keypair() -> tuple[str, str, str]:
    """Return (pubkey_b64, formatted_pubkey, signing_key)."""
    sk = NaClSigningKey.generate()
    pubkey_raw = bytes(sk.verify_key)
    pubkey_b64 = base64.b64encode(pubkey_raw).decode()
    return pubkey_b64, f"ed25519:{pubkey_b64}", sk


def _sign_nonce(sk: NaClSigningKey, nonce_b64: str) -> str:
    nonce_bytes = base64.b64decode(nonce_b64)
    sig = sk.sign(nonce_bytes).signature
    return base64.b64encode(sig).decode()


async def _issue_bind_code(
    client: AsyncClient, token: str, intended_name: str | None = None
) -> dict:
    body: dict = {}
    if intended_name is not None:
        body["intended_name"] = intended_name
    resp = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Bind ticket: response shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bind_ticket_response_includes_install_command(
    client: AsyncClient, fresh_user: dict
):
    data = await _issue_bind_code(client, fresh_user["token"], intended_name="my-bot")
    assert data["bind_code"].startswith("bd_")
    assert data["intended_name"] == "my-bot"
    assert data["install_command"].startswith("curl -fsSL ")
    assert f"--bind-code {data['bind_code']}" in data["install_command"]
    assert f"--bind-nonce {data['nonce']}" in data["install_command"]
    # Nonce should be a base64-encoded 32-byte value (Ed25519 challenge).
    raw = base64.b64decode(data["nonce"])
    assert len(raw) == 32

    payload_json = base64.urlsafe_b64decode(data["bind_ticket"].split(".")[0]).decode()
    payload = json.loads(payload_json)
    assert payload["purpose"] == "install_claim"
    assert payload["intended_name"] == "my-bot"


@pytest.mark.asyncio
async def test_bind_ticket_active_cap_enforced(
    client: AsyncClient, fresh_user: dict, monkeypatch
):
    import app.routers.users as users_mod

    monkeypatch.setattr(users_mod, "MAX_ACTIVE_BIND_CODES_PER_USER", 2)
    token = fresh_user["token"]
    await _issue_bind_code(client, token)
    await _issue_bind_code(client, token)
    resp = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
        json={},
    )
    assert resp.status_code == 429


# ---------------------------------------------------------------------------
# Bind ticket: status / revoke
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bind_ticket_status_pending(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    resp = await client.get(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["agent_id"] is None


@pytest.mark.asyncio
async def test_bind_ticket_status_other_user_404(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    data = await _issue_bind_code(client, fresh_user["token"])

    # Create a second user and use their token.
    other_uuid = uuid.uuid4()
    other = User(
        id=uuid.uuid4(),
        display_name="Other",
        email="other@example.com",
        status="active",
        supabase_user_id=other_uuid,
        max_agents=1,
    )
    db_session.add(other)
    await db_session.commit()
    other_token = _make_supabase_token(str(other_uuid))

    resp = await client.get(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_bind_ticket_revoke_then_status_404(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    resp = await client.delete(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 200

    # Revoking again (or revoking nonexistent) returns 404.
    resp = await client.delete(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 404

    # Status of a revoked code reports "revoked" (not "claimed") so the
    # frontend stops polling and never tries to navigate to an agent_id
    # that does not exist.
    status_resp = await client.get(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert status_resp.status_code == 200
    body = status_resp.json()
    assert body["status"] == "revoked"
    assert body["agent_id"] is None


# ---------------------------------------------------------------------------
# install-claim: happy path + error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_install_claim_happy_path(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    data = await _issue_bind_code(client, fresh_user["token"], intended_name="laptop-bot")
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    sig = _sign_nonce(sk, data["nonce"])

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": data["nonce"], "sig": sig},
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    expected_agent_id = generate_agent_id(pubkey_b64)
    assert body["agent_id"] == expected_agent_id
    assert body["key_id"].startswith("k_")
    assert body["agent_token"]
    assert body["display_name"] == "laptop-bot"
    assert body["hub_url"].startswith("http")
    assert body["ws_url"].startswith("ws")

    # Owner polling now reports claimed.
    poll = await client.get(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert poll.status_code == 200
    assert poll.json()["status"] == "claimed"
    assert poll.json()["agent_id"] == expected_agent_id

    # Agent + active SigningKey rows persisted, bound to the user.
    agent_row = (
        await db_session.execute(select(Agent).where(Agent.agent_id == expected_agent_id))
    ).scalar_one()
    assert str(agent_row.user_id) == str(fresh_user["user_id"])
    assert agent_row.is_default is True

    key_row = (
        await db_session.execute(select(SigningKey).where(SigningKey.agent_id == expected_agent_id))
    ).scalar_one()
    assert key_row.pubkey == pubkey_formatted

    # ShortCode marked consumed with claimed_agent_id payload.
    sc_row = (
        await db_session.execute(select(ShortCode).where(ShortCode.code == data["bind_code"]))
    ).scalar_one()
    assert sc_row.consumed_at is not None
    assert json.loads(sc_row.payload_json)["claimed_agent_id"] == expected_agent_id


@pytest.mark.asyncio
async def test_install_claim_consume_atomically_records_agent_id(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    """Regression: short_code.payload_json must contain claimed_agent_id
    by the time the consume row flips to consumed_at, so polling never
    observes a "consumed but no agent" state and reports it as revoked.
    """
    data = await _issue_bind_code(client, fresh_user["token"])
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    sig = _sign_nonce(sk, data["nonce"])

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": data["nonce"], "sig": sig},
        },
    )
    assert resp.status_code == 201, resp.text
    expected_agent_id = generate_agent_id(pubkey_b64)

    # Inspect the row directly: consumed_at must be non-null AND
    # payload_json must already include claimed_agent_id. There must
    # never be a window where the first is true but the second isn't.
    sc_row = (
        await db_session.execute(
            select(ShortCode).where(ShortCode.code == data["bind_code"])
        )
    ).scalar_one()
    assert sc_row.consumed_at is not None
    payload = json.loads(sc_row.payload_json)
    assert payload["claimed_agent_id"] == expected_agent_id
    assert "claimed_at" in payload

    # And the polling endpoint reports "claimed" (not "revoked").
    poll = await client.get(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "claimed"
    assert body["agent_id"] == expected_agent_id


@pytest.mark.asyncio
async def test_install_claim_replay_rejected(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    sig = _sign_nonce(sk, data["nonce"])

    body = {
        "bind_code": data["bind_code"],
        "pubkey": pubkey_formatted,
        "proof": {"nonce": data["nonce"], "sig": sig},
    }
    first = await client.post("/api/users/me/agents/install-claim", json=body)
    assert first.status_code == 201

    second = await client.post("/api/users/me/agents/install-claim", json=body)
    assert second.status_code in (400, 409)
    assert second.json()["detail"] in ("INVALID_BIND_CODE", "PUBKEY_ALREADY_REGISTERED")


@pytest.mark.asyncio
async def test_install_claim_unknown_code(client: AsyncClient, fresh_user: dict):
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    nonce = base64.b64encode(os.urandom(32)).decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": "bd_doesnotexist",
            "pubkey": pubkey_formatted,
            "proof": {"nonce": nonce, "sig": sig},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "INVALID_BIND_CODE"


@pytest.mark.asyncio
async def test_install_claim_bad_proof_nonce_mismatch(
    client: AsyncClient, fresh_user: dict
):
    data = await _issue_bind_code(client, fresh_user["token"])
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    other_nonce = base64.b64encode(os.urandom(32)).decode()
    sig = _sign_nonce(sk, other_nonce)

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": other_nonce, "sig": sig},
        },
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "INVALID_PROOF"


@pytest.mark.asyncio
async def test_install_claim_bad_signature(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    pubkey_b64, pubkey_formatted, _sk = _gen_keypair()
    # Sign with a different key, then submit alongside the claimed pubkey.
    other_sk = NaClSigningKey.generate()
    bad_sig = _sign_nonce(other_sk, data["nonce"])

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": data["nonce"], "sig": bad_sig},
        },
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "INVALID_PROOF"


@pytest.mark.asyncio
async def test_install_claim_invalid_pubkey(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": "not-a-real-pubkey",
            "proof": {"nonce": data["nonce"], "sig": "AAAA"},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "INVALID_PUBKEY"


@pytest.mark.asyncio
async def test_install_claim_pubkey_already_registered(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    pubkey_b64, pubkey_formatted, sk = _gen_keypair()

    # Pre-seed an Agent + SigningKey for this pubkey, simulating a prior claim.
    existing_agent_id = generate_agent_id(pubkey_b64)
    db_session.add(
        Agent(
            agent_id=existing_agent_id,
            display_name="Pre-existing",
            user_id=fresh_user["user_id"],
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    from hub.enums import KeyState

    db_session.add(
        SigningKey(
            agent_id=existing_agent_id,
            key_id="k_existing0001",
            pubkey=pubkey_formatted,
            state=KeyState.active,
        )
    )
    await db_session.commit()

    data = await _issue_bind_code(client, fresh_user["token"])
    sig = _sign_nonce(sk, data["nonce"])

    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": data["nonce"], "sig": sig},
        },
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "PUBKEY_ALREADY_REGISTERED"


@pytest.mark.asyncio
async def test_install_claim_revoked_code(client: AsyncClient, fresh_user: dict):
    data = await _issue_bind_code(client, fresh_user["token"])
    revoke = await client.delete(
        f"/api/users/me/agents/bind-ticket/{data['bind_code']}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert revoke.status_code == 200

    pubkey_b64, pubkey_formatted, sk = _gen_keypair()
    sig = _sign_nonce(sk, data["nonce"])
    resp = await client.post(
        "/api/users/me/agents/install-claim",
        json={
            "bind_code": data["bind_code"],
            "pubkey": pubkey_formatted,
            "proof": {"nonce": data["nonce"], "sig": sig},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "INVALID_BIND_CODE"


# ---------------------------------------------------------------------------
# /openclaw/install.sh
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_install_script_served(client: AsyncClient):
    resp = await client.get("/openclaw/install.sh")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/x-sh") or resp.headers["content-type"].startswith("application/")
    assert "BotCord" in resp.text

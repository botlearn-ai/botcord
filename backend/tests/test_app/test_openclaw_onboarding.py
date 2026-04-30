"""Tests for the OpenClaw host onboarding flow.

Covers:
- POST /api/users/me/agents/openclaw/install (issues bind ticket)
- POST /openclaw/install-claim (host + agent dual-PoP)
- POST /openclaw/auth/refresh (refresh-token rotation)
- DELETE /api/users/me/agents/openclaw/hosts/{id} (batch unbind +
  single default promotion)
- replay rejection of consumed bind code
"""

from __future__ import annotations

import base64
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey as NaClSigningKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from hub.models import (
    Agent,
    Base,
    OpenclawAgentCleanup,
    OpenclawHostInstance,
    Role,
    User,
    UserRole,
)

from .test_app_user_agents import (
    TEST_JWT_SECRET,
    TEST_SUPABASE_SECRET,
    _make_supabase_token,
)


# ---------------------------------------------------------------------------
# Fixtures
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
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="Install User",
        email="oc@example.com",
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
        "user_id": user_id,
        "token": _make_supabase_token(str(supabase_uuid)),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_keypair() -> tuple[str, NaClSigningKey]:
    sk = NaClSigningKey.generate()
    return base64.b64encode(bytes(sk.verify_key)).decode(), sk


def _sign_nonce(sk: NaClSigningKey, nonce_b64: str) -> str:
    return base64.b64encode(sk.sign(base64.b64decode(nonce_b64)).signature).decode()


async def _issue_install(client: AsyncClient, token: str, name: str = "vm-bot") -> dict:
    resp = await client.post(
        "/api/users/me/agents/openclaw/install",
        json={"name": name, "bio": "hello"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _claim(client: AsyncClient, bind_code: str, nonce: str) -> dict:
    host_pub, host_sk = _gen_keypair()
    agent_pub, agent_sk = _gen_keypair()
    body = {
        "bind_code": bind_code,
        "host": {
            "pubkey": f"ed25519:{host_pub}",
            "proof": {"nonce": nonce, "sig": _sign_nonce(host_sk, nonce)},
        },
        "agent": {
            "pubkey": f"ed25519:{agent_pub}",
            "proof": {"nonce": nonce, "sig": _sign_nonce(agent_sk, nonce)},
        },
    }
    resp = await client.post("/openclaw/install-claim", json=body)
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openclaw_install_claim_happy_path(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    issued = await _issue_install(client, fresh_user["token"], name="laptop-bot")
    assert issued["bind_code"].startswith("bd_")
    assert "openclaw_install" in issued["install_command"]
    assert "/openclaw/install.sh" in issued["install_command"]

    resp = await _claim(client, issued["bind_code"], issued["nonce"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["agent"]["id"].startswith("ag_")
    assert body["agent"]["display_name"] == "laptop-bot"
    assert body["agent"]["bio"] == "hello"
    assert body["host"]["host_instance_id"].startswith("oc_")
    assert body["host"]["access_token"]
    assert body["host"]["refresh_token"].startswith("ort_")
    assert body["host"]["control_ws_url"].endswith("/openclaw/control")

    # Agent + host rows persisted with the right linkage.
    agent = (
        await db_session.execute(select(Agent).where(Agent.agent_id == body["agent"]["id"]))
    ).scalar_one()
    assert agent.hosting_kind == "plugin"
    assert agent.openclaw_host_id == body["host"]["host_instance_id"]
    assert agent.user_id == fresh_user["user_id"]
    assert agent.is_default is True  # first agent for the user

    instance = (
        await db_session.execute(
            select(OpenclawHostInstance).where(
                OpenclawHostInstance.id == body["host"]["host_instance_id"]
            )
        )
    ).scalar_one()
    assert str(instance.owner_user_id) == str(fresh_user["user_id"])


@pytest.mark.asyncio
async def test_openclaw_install_claim_replay_rejected(
    client: AsyncClient, fresh_user: dict
):
    issued = await _issue_install(client, fresh_user["token"])
    first = await _claim(client, issued["bind_code"], issued["nonce"])
    assert first.status_code == 201

    # Same bind code, fresh keypairs — must be rejected.
    second = await _claim(client, issued["bind_code"], issued["nonce"])
    assert second.status_code == 400
    assert second.json()["detail"] == "INVALID_BIND_CODE"


@pytest.mark.asyncio
async def test_openclaw_install_claim_bad_proof_rejected(
    client: AsyncClient, fresh_user: dict
):
    issued = await _issue_install(client, fresh_user["token"])
    host_pub, _ = _gen_keypair()
    agent_pub, agent_sk = _gen_keypair()
    body = {
        "bind_code": issued["bind_code"],
        "host": {
            "pubkey": f"ed25519:{host_pub}",
            "proof": {"nonce": issued["nonce"], "sig": "AA" * 32},
        },
        "agent": {
            "pubkey": f"ed25519:{agent_pub}",
            "proof": {"nonce": issued["nonce"], "sig": _sign_nonce(agent_sk, issued["nonce"])},
        },
    }
    resp = await client.post("/openclaw/install-claim", json=body)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "INVALID_PROOF"


@pytest.mark.asyncio
async def test_openclaw_refresh_token_rotation(
    client: AsyncClient, fresh_user: dict
):
    issued = await _issue_install(client, fresh_user["token"])
    claim = (await _claim(client, issued["bind_code"], issued["nonce"])).json()
    refresh = claim["host"]["refresh_token"]
    access = claim["host"]["access_token"]

    resp = await client.post("/openclaw/auth/refresh", json={"refresh_token": refresh})
    assert resp.status_code == 200
    body = resp.json()
    assert body["host_instance_id"] == claim["host"]["host_instance_id"]
    assert body["access_token"]
    # Refresh token MUST rotate (one-time use); access token may be byte-equal
    # if minted within the same `exp` second, which is a fine no-op.
    assert body["refresh_token"] and body["refresh_token"] != refresh
    _ = access  # keep reference; we tolerate same-second identical access JWT

    # Old refresh must now be invalid.
    repeat = await client.post("/openclaw/auth/refresh", json={"refresh_token": refresh})
    assert repeat.status_code == 401


@pytest.mark.asyncio
async def test_openclaw_host_revoke_unbinds_all_agents_and_promotes_one_default(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession
):
    # Onboard a host (creates default agent A).
    issued = await _issue_install(client, fresh_user["token"], name="A")
    claim_a = (await _claim(client, issued["bind_code"], issued["nonce"])).json()
    host_id = claim_a["host"]["host_instance_id"]
    host_refresh_token = claim_a["host"]["refresh_token"]
    agent_a_id = claim_a["agent"]["id"]

    # Manually attach a second agent (B) to the same host so we can verify
    # batched unbind + single default promotion. This avoids needing a
    # live host WS to drive provision-claim through HTTP.
    agent_b = Agent(
        agent_id="ag_" + uuid.uuid4().hex[:12],
        display_name="B",
        user_id=fresh_user["user_id"],
        is_default=False,
        hosting_kind="plugin",
        openclaw_host_id=host_id,
        status="active",
    )
    db_session.add(agent_b)
    # And an unrelated agent C on no host — should be the promoted default
    # after the host is revoked.
    agent_c = Agent(
        agent_id="ag_" + uuid.uuid4().hex[:12],
        display_name="C",
        user_id=fresh_user["user_id"],
        is_default=False,
        hosting_kind=None,
        openclaw_host_id=None,
        status="active",
    )
    db_session.add(agent_c)
    await db_session.commit()

    resp = await client.delete(
        f"/api/users/me/agents/openclaw/hosts/{host_id}",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body["revoked_agents"]) == {agent_a_id, agent_b.agent_id}

    # Re-read with fresh queries — Agent rows captured before commit are stale.
    a = (
        await db_session.execute(select(Agent).where(Agent.agent_id == agent_a_id))
    ).scalar_one()
    b = (
        await db_session.execute(select(Agent).where(Agent.agent_id == agent_b.agent_id))
    ).scalar_one()
    c = (
        await db_session.execute(select(Agent).where(Agent.agent_id == agent_c.agent_id))
    ).scalar_one()

    assert a.user_id is None and a.openclaw_host_id is None and not a.is_default
    assert b.user_id is None and b.openclaw_host_id is None and not b.is_default
    # Exactly one promoted default — the unrelated agent C — even though
    # the previous default lived on the revoked host.
    assert c.is_default is True
    assert c.user_id == fresh_user["user_id"]

    instance = (
        await db_session.execute(
            select(OpenclawHostInstance).where(OpenclawHostInstance.id == host_id)
        )
    ).scalar_one()
    assert instance.revoked_at is not None
    assert instance.refresh_token_hash is not None

    cleanup_rows = (
        await db_session.execute(
            select(OpenclawAgentCleanup).where(OpenclawAgentCleanup.host_id == host_id)
        )
    ).scalars().all()
    assert {row.agent_id for row in cleanup_rows} == {agent_a_id, agent_b.agent_id}
    assert all(row.status == "pending" for row in cleanup_rows)

    refresh_resp = await client.post(
        "/openclaw/auth/refresh",
        json={"refresh_token": host_refresh_token},
    )
    assert refresh_resp.status_code == 200
    refresh_body = refresh_resp.json()
    assert refresh_body["host_instance_id"] == host_id
    assert refresh_body["cleanup_only"] is True
    assert "access_token" in refresh_body
    assert "refresh_token" not in refresh_body


@pytest.mark.asyncio
async def test_openclaw_install_endpoint_rejects_anon(client: AsyncClient):
    resp = await client.post(
        "/api/users/me/agents/openclaw/install",
        json={"name": "x"},
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_openclaw_provision_rejects_wrong_agent_in_ack(
    client: AsyncClient, fresh_user: dict, db_session: AsyncSession, monkeypatch
):
    """A buggy/compromised host that acks with someone else's agent_id
    must not be reported as success — the BFF has to verify ownership +
    host binding before returning to the dashboard.
    """
    issued = await _issue_install(client, fresh_user["token"], name="A")
    claim = (await _claim(client, issued["bind_code"], issued["nonce"])).json()
    host_id = claim["host"]["host_instance_id"]

    # Pretend an unrelated user owns a different agent on a different host.
    stranger_id = uuid.uuid4()
    other_agent = Agent(
        agent_id="ag_stranger12",
        display_name="stranger",
        user_id=stranger_id,
        is_default=False,
        hosting_kind="plugin",
        openclaw_host_id=None,
        status="active",
    )
    db_session.add(other_agent)
    await db_session.commit()

    # Stub the registry + control frame send so the BFF thinks the host
    # is online and the host's "ack" returns the stranger's agent_id.
    from hub.routers import openclaw_control as oc_mod

    monkeypatch.setattr(oc_mod, "is_openclaw_host_online", lambda _hid: True)

    async def fake_send_control_frame(_hid, _type, _params, *_a, **_kw):
        return {"ok": True, "result": {"agent_id": "ag_stranger12"}}

    monkeypatch.setattr(oc_mod, "send_host_control_frame", fake_send_control_frame)

    resp = await client.post(
        "/api/users/me/agents/openclaw/provision",
        json={"openclaw_host_id": host_id, "name": "should-fail"},
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 502
    body = resp.json()
    assert body["detail"]["code"] == "openclaw_provision_failed"


@pytest.mark.asyncio
async def test_openclaw_hosts_list_returns_owned_only(
    client: AsyncClient, fresh_user: dict
):
    issued = await _issue_install(client, fresh_user["token"], name="vm-1")
    await _claim(client, issued["bind_code"], issued["nonce"])

    resp = await client.get(
        "/api/users/me/agents/openclaw/hosts",
        headers={"Authorization": f"Bearer {fresh_user['token']}"},
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert len(payload["hosts"]) == 1
    host = payload["hosts"][0]
    assert host["id"].startswith("oc_")
    assert host["agent_count"] == 1
    # Not online — no live WS in the test harness.
    assert host["online"] is False

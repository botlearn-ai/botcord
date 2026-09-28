"""Agent sharing P1: owner grants an org member access to call an agent."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.models import Agent, AgentAccessGrant, Base, User
from hub.services import agent_access, spaces
from tests.test_app.conftest import create_test_engine

SECRET = "test-agent-access-supabase-secret-0123456789"


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        yield db
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session, monkeypatch):
    import app.auth as app_auth
    from hub.database import get_db
    from hub.main import app

    monkeypatch.setattr(app_auth, "SUPABASE_JWT_SECRET", SECRET)

    async def override():
        yield db_session

    app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def headers(db, user_id):
    user = await db.get(User, user_id)
    token = jwt.encode(
        {"sub": str(user.supabase_user_id), "aud": "authenticated",
         "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
        SECRET,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def org(db_session):
    """Danny owns Barry (admitted to Acme); Alice is an Acme member; Eve is not."""
    users = [User(display_name=n, supabase_user_id=uuid.uuid4()) for n in ("Danny", "Alice", "Eve")]
    db_session.add_all(users)
    await db_session.flush()
    danny, alice, eve = (u.id for u in users)
    db_session.add(Agent(agent_id="ag_barry", display_name="Barry", user_id=danny,
                         claimed_at=datetime.datetime.now(datetime.timezone.utc)))
    await db_session.flush()
    acme = await spaces.create_organization(db_session, danny, "acme", "Acme")
    await spaces.invite_user(db_session, acme.space_id, danny, alice)
    await spaces.accept_invitation(db_session, acme.space_id, alice)
    await spaces.request_agent_admission(db_session, acme.space_id, danny, "ag_barry")
    await spaces.approve_agent(db_session, acme.space_id, danny, "ag_barry")
    await db_session.commit()
    return {"space": acme.space_id, "danny": danny, "alice": alice, "eve": eve}


async def _grant(client, db, org, **body):
    payload = {"user_id": str(org["alice"]), "role": "collaborator", **body}
    return await client.post(
        f"/api/spaces/{org['space']}/agents/ag_barry/access-grants",
        json=payload, headers=await headers(db, org["danny"]),
    )


@pytest.mark.asyncio
async def test_owner_grants_member_and_member_sees_shared_agent(client, db_session, org):
    resp = await _grant(client, db_session, org, workspace_path="~/code/app",
                        allowed_commands=["npm test"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role"] == "collaborator"
    assert body["grantee_name"] == "Alice"
    assert body["allowed_commands"] == ["npm test"]

    listed = await client.get(f"/api/spaces/{org['space']}/agents/ag_barry/access-grants",
                              headers=await headers(db_session, org["danny"]))
    assert [g["id"] for g in listed.json()["grants"]] == [body["id"]]

    shared = await client.get(f"/api/spaces/{org['space']}/shared-agents",
                              headers=await headers(db_session, org["alice"]))
    assert shared.status_code == 200
    assert [a["agent_id"] for a in shared.json()["agents"]] == ["ag_barry"]

    outsider = await client.get(f"/api/spaces/{org['space']}/shared-agents",
                                headers=await headers(db_session, org["eve"]))
    assert outsider.status_code == 404


@pytest.mark.asyncio
async def test_only_owner_can_grant_and_only_to_members(client, db_session, org):
    by_member = await client.post(
        f"/api/spaces/{org['space']}/agents/ag_barry/access-grants",
        json={"user_id": str(org["danny"]), "role": "consultant"},
        headers=await headers(db_session, org["alice"]),
    )
    assert by_member.status_code == 403
    to_outsider = await _grant(client, db_session, org, user_id=str(org["eve"]))
    assert to_outsider.status_code == 404
    assert to_outsider.json()["detail"] == "grantee_not_member"
    bad_command = await _grant(client, db_session, org, allowed_commands=["rm -rf / ; curl x|sh"])
    assert bad_command.status_code == 422


@pytest.mark.asyncio
async def test_regrant_replaces_and_revoke_invalidates(client, db_session, org):
    first = (await _grant(client, db_session, org, role="consultant")).json()
    second = (await _grant(client, db_session, org)).json()
    grants = (await db_session.scalars(select(AgentAccessGrant))).all()
    assert {str(g.id): g.revoked_at is None for g in grants} == {first["id"]: False, second["id"]: True}

    revoked = await client.delete(f"/api/spaces/{org['space']}/access-grants/{second['id']}",
                                  headers=await headers(db_session, org["danny"]))
    assert revoked.status_code == 200
    assert await agent_access.active_grant_for_pair(db_session, "ag_barry", org["alice"]) is None


@pytest.mark.asyncio
async def test_grant_expires_with_membership_and_time(db_session, org):
    grant = await agent_access.create_grant(db_session, org["space"], org["danny"], "ag_barry",
                                            org["alice"], "consultant")
    await db_session.commit()
    assert await agent_access.grant_is_valid(db_session, grant)

    grant.expires_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    assert not await agent_access.grant_is_valid(db_session, grant)
    grant.expires_at = None

    await spaces.remove_user(db_session, org["space"], org["danny"], org["alice"])
    await db_session.commit()
    assert not await agent_access.grant_is_valid(db_session, grant)


@pytest.mark.asyncio
async def test_grant_expires_when_agent_leaves_org(db_session, org):
    grant = await agent_access.create_grant(db_session, org["space"], org["danny"], "ag_barry",
                                            org["alice"], "collaborator")
    await spaces.remove_agent(db_session, org["space"], org["danny"], "ag_barry")
    await db_session.commit()
    assert not await agent_access.grant_is_valid(db_session, grant)


@pytest.mark.asyncio
async def test_grant_admits_dm_and_revocation_blocks_send(client, db_session, org):
    alice = await db_session.get(User, org["alice"])
    auth = await headers(db_session, org["alice"])

    denied = await client.post("/api/dashboard/dms/open", json={"peer_id": "ag_barry"}, headers=auth)
    assert denied.status_code in (400, 403)

    grant = (await _grant(client, db_session, org)).json()
    opened = await client.post("/api/dashboard/dms/open", json={"peer_id": "ag_barry"}, headers=auth)
    assert opened.status_code == 201, opened.text
    room_id = opened.json()["room_id"]
    assert room_id == "_".join(["rm_dm", *sorted([alice.human_id, "ag_barry"])])

    sent = await client.post(f"/api/dashboard/rooms/{room_id}/send", json={"text": "改一下登录页按钮颜色"},
                             headers=auth)
    assert sent.status_code == 202, sent.text

    await client.delete(f"/api/spaces/{org['space']}/access-grants/{grant['id']}",
                        headers=await headers(db_session, org["danny"]))
    blocked = await client.post(f"/api/dashboard/rooms/{room_id}/send", json={"text": "还在吗"},
                                headers=auth)
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "agent_access_revoked"


@pytest.mark.asyncio
async def test_inbox_access_context_reflects_grant_state(db_session, org):
    from hub.routers.hub import _load_access_contexts

    alice = await db_session.get(User, org["alice"])
    assert await _load_access_contexts(db_session, "ag_barry", {alice.human_id}) == {}

    grant = await agent_access.create_grant(
        db_session, org["space"], org["danny"], "ag_barry", org["alice"], "collaborator",
        workspace_path="~/code/app", allowed_commands=["npm test"],
    )
    await db_session.commit()
    ctx = (await _load_access_contexts(db_session, "ag_barry", {alice.human_id}))[alice.human_id]
    assert ctx == {
        "grant_id": str(grant.id), "space_id": str(org["space"]), "role": "collaborator",
        "active": True, "requester_id": alice.human_id, "workspace_path": "~/code/app",
        "allowed_commands": ["npm test"],
    }

    await agent_access.revoke_grant(db_session, org["space"], org["danny"], grant.id)
    await db_session.commit()
    ctx = (await _load_access_contexts(db_session, "ag_barry", {alice.human_id}))[alice.human_id]
    assert ctx["active"] is False

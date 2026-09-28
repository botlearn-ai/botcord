"""Organization rooms as Hub Rooms: agents can join, membership follows the space."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.auth import create_agent_token
from hub.models import Agent, Base, RoomMember, SpaceUserMembership, User
from hub.services import spaces
from tests.test_app.conftest import create_test_engine

SECRET = "test-org-rooms-supabase-secret-0123456789"


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


def auth(sub: uuid.UUID) -> dict:
    token = jwt.encode(
        {"sub": str(sub), "aud": "authenticated",
         "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
        SECRET,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def org(db_session):
    """Danny (owner) + Alice (member) in Acme; Eve outside. Barry is Danny's agent, Rex is Alice's."""
    now = datetime.datetime.now(datetime.timezone.utc)
    users = {n: User(display_name=n, supabase_user_id=uuid.uuid4()) for n in ("Danny", "Alice", "Eve")}
    db_session.add_all(users.values())
    await db_session.flush()
    barry_token, barry_exp = create_agent_token("ag_barry")
    db_session.add_all([
        Agent(agent_id="ag_barry", display_name="Barry", user_id=users["Danny"].id, claimed_at=now,
              agent_token=barry_token),
        Agent(agent_id="ag_rex", display_name="Rex", user_id=users["Alice"].id, claimed_at=now),
    ])
    await db_session.flush()
    acme = await spaces.create_organization(db_session, users["Danny"].id, "acme", "Acme")
    await spaces.invite_user(db_session, acme.space_id, users["Danny"].id, users["Alice"].id)
    await spaces.accept_invitation(db_session, acme.space_id, users["Alice"].id)
    for owner, agent_id in (("Danny", "ag_barry"), ("Alice", "ag_rex")):
        await spaces.request_agent_admission(db_session, acme.space_id, users[owner].id, agent_id)
        await spaces.approve_agent(db_session, acme.space_id, users["Danny"].id, agent_id)
    await db_session.commit()
    alice_membership = await db_session.scalar(select(SpaceUserMembership.id).where(
        SpaceUserMembership.space_id == acme.space_id, SpaceUserMembership.user_id == users["Alice"].id))
    return {
        "space": acme.space_id, "barry_token": barry_token,
        "danny": auth(users["Danny"].supabase_user_id), "alice": auth(users["Alice"].supabase_user_id),
        "eve": auth(users["Eve"].supabase_user_id), "alice_membership": alice_membership,
        "danny_id": users["Danny"].id, "alice_id": users["Alice"].id,
        "alice_hu": users["Alice"].human_id, "eve_hu": users["Eve"].human_id,
    }


def base(org):
    return f"/api/spaces/{org['space']}"


@pytest.mark.asyncio
async def test_org_room_with_agent_unread_and_preview(client, db_session, org):
    created = await client.post(f"{base(org)}/rooms", headers=org["danny"],
                                json={"name": "dev", "visibility": "organization", "agent_ids": ["ag_barry"]})
    assert created.status_code == 201, created.text
    room_id = created.json()["room_id"]

    danny_rooms = (await client.get(f"{base(org)}/rooms", headers=org["danny"])).json()["rooms"]
    [room] = [r for r in danny_rooms if r["room_id"] == room_id]
    assert room["joined"] and room["space_kind"] == "room"
    assert {p["id"] for p in room["participants"]} >= {"ag_barry"}

    alice_rooms = (await client.get(f"{base(org)}/rooms", headers=org["alice"])).json()["rooms"]
    assert [r["joined"] for r in alice_rooms if r["room_id"] == room_id] == [False]
    assert (await client.post(f"{base(org)}/rooms/{room_id}/join", headers=org["alice"])).status_code == 200

    sent = await client.post(f"/api/dashboard/rooms/{room_id}/send", headers=org["alice"],
                             json={"text": "Barry 帮我看看登录页"})
    assert sent.status_code == 202, sent.text
    [room] = [r for r in (await client.get(f"{base(org)}/rooms", headers=org["danny"])).json()["rooms"]
              if r["room_id"] == room_id]
    assert room["unread_count"] == 1
    assert room["last_sender_name"] == "Alice"

    # Personal-mode overview marks the room as belonging to the space.
    overview = (await client.get("/api/dashboard/overview", headers=org["danny"])).json()
    assert [r["space_id"] for r in overview["rooms"] if r["room_id"] == room_id] == [str(org["space"])]


@pytest.mark.asyncio
async def test_agent_add_rules_and_outsider_blocked(client, db_session, org):
    room_id = (await client.post(f"{base(org)}/rooms", headers=org["alice"],
                                 json={"name": "alice-room"})).json()["room_id"]
    # Alice may add her own agent, not Danny's (she is neither its owner nor a manager).
    assert (await client.post(f"{base(org)}/rooms/{room_id}/agents", headers=org["alice"],
                              json={"agent_id": "ag_rex"})).status_code == 201
    denied = await client.post(f"{base(org)}/rooms/{room_id}/agents", headers=org["alice"],
                               json={"agent_id": "ag_barry"})
    assert denied.status_code == 403
    # Danny (org owner/manager) may add Barry, and must join first to act in the room.
    await client.post(f"{base(org)}/rooms/{room_id}/join", headers=org["danny"])
    assert (await client.post(f"{base(org)}/rooms/{room_id}/agents", headers=org["danny"],
                              json={"agent_id": "ag_barry"})).status_code == 201

    assert (await client.get(f"{base(org)}/rooms", headers=org["eve"])).status_code == 404
    generic = await client.post(f"/api/humans/me/rooms/{room_id}/members", headers=org["alice"],
                                json={"participant_id": org["eve_hu"], "role": "member"})
    assert generic.status_code == 403
    assert generic.json()["detail"] == "org_room_membership_managed_by_team"


@pytest.mark.asyncio
async def test_private_rooms_dms_and_leaving_the_org(client, db_session, org):
    private = (await client.post(f"{base(org)}/rooms", headers=org["danny"],
                                 json={"name": "secret", "visibility": "private"})).json()["room_id"]
    assert (await client.post(f"{base(org)}/rooms/{private}/join", headers=org["alice"])).status_code == 403
    assert private not in [r["room_id"] for r in
                           (await client.get(f"{base(org)}/rooms", headers=org["alice"])).json()["rooms"]]

    dm = await client.post(f"{base(org)}/dms", headers=org["danny"], json={"member_id": str(org["alice_membership"])})
    again = await client.post(f"{base(org)}/dms", headers=org["danny"], json={"member_id": str(org["alice_membership"])})
    assert dm.status_code == 201 and dm.json()["room_id"] == again.json()["room_id"]
    [row] = [r for r in (await client.get(f"{base(org)}/rooms", headers=org["alice"])).json()["rooms"]
             if r["room_id"] == dm.json()["room_id"]]
    assert row["space_kind"] == "dm" and row["dm_peer_name"] == "Danny"

    open_room = (await client.post(f"{base(org)}/rooms", headers=org["alice"],
                                   json={"name": "general", "agent_ids": ["ag_rex"]})).json()["room_id"]
    await spaces.remove_user(db_session, org["space"], org["danny_id"], org["alice_id"])
    await db_session.commit()
    left = (await db_session.scalars(select(RoomMember.agent_id).where(
        RoomMember.room_id.in_([open_room, dm.json()["room_id"]])))).all()
    assert org["alice_hu"] not in left and "ag_rex" not in left


@pytest.mark.asyncio
async def test_inbox_space_context_restricts_non_owner_requests(client, db_session, org):
    room_id = (await client.post(f"{base(org)}/rooms", headers=org["danny"],
                                 json={"name": "dev", "agent_ids": ["ag_barry"]})).json()["room_id"]
    await client.post(f"{base(org)}/rooms/{room_id}/join", headers=org["alice"])
    await client.post(f"/api/dashboard/rooms/{room_id}/send", headers=org["alice"], json={"text": "from alice"})
    await client.post(f"/api/dashboard/rooms/{room_id}/send", headers=org["danny"], json={"text": "from danny"})

    inbox = await client.get("/hub/inbox", headers={"Authorization": f"Bearer {org['barry_token']}"},
                             params={"timeout": 0, "limit": 20})
    assert inbox.status_code == 200, inbox.text
    by_text = {m["text"]: m for m in inbox.json()["messages"]}
    assert by_text["from alice"]["space_context"] == {"space_id": str(org["space"]), "restricted": True}
    assert by_text["from danny"]["space_context"] == {"space_id": str(org["space"]), "restricted": False}


@pytest.mark.asyncio
async def test_legacy_team_conversation_migrates_to_room(client, db_session, org, monkeypatch):
    import importlib.util
    import pathlib

    legacy = f"/api/spaces/{org['space']}/conversations"
    conv = (await client.post(legacy, headers=org["danny"],
                              json={"kind": "room", "visibility": "organization", "name": "dev", "member_ids": []})).json()
    for who, text in (("danny", "早上好"), ("alice", "能看到消息不")):
        assert (await client.post(f"{legacy}/{conv['id']}/messages", headers=org[who],
                                  json={"content": text, "client_id": str(uuid.uuid4())})).status_code == 201

    path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "migrate_team_conversations_to_rooms.py"
    spec = importlib.util.spec_from_file_location("migrate_team", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class _Session:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(module, "async_session", lambda: _Session())
    await module.migrate(dry_run=False)
    await module.migrate(dry_run=False)  # idempotent

    room_id = f"rm_team_{uuid.UUID(conv['id']).hex[:20]}"
    rooms = (await client.get(f"{base(org)}/rooms", headers=org["alice"])).json()["rooms"]
    [room] = [r for r in rooms if r["room_id"] == room_id]
    assert room["joined"] and room["space_kind"] == "room" and room["space_visibility"] == "organization"
    history = (await client.get(f"/api/dashboard/rooms/{room_id}/messages", headers=org["alice"])).json()
    texts = [m["text"] for m in history["messages"]]
    assert texts == ["早上好", "能看到消息不"] or sorted(texts) == sorted(["早上好", "能看到消息不"])


@pytest.mark.asyncio
async def test_member_agent_dms_for_owners_and_grantees(client, db_session, org):
    from hub.services import agent_access

    own = await client.post(f"{base(org)}/agent-dms", headers=org["danny"], json={"agent_id": "ag_barry"})
    assert own.status_code == 201, own.text
    again = await client.post(f"{base(org)}/agent-dms", headers=org["danny"], json={"agent_id": "ag_barry"})
    assert again.json()["room_id"] == own.json()["room_id"]
    [row] = [r for r in (await client.get(f"{base(org)}/rooms", headers=org["danny"])).json()["rooms"]
             if r["room_id"] == own.json()["room_id"]]
    assert row["space_kind"] == "dm" and row["dm_peer_name"] == "Barry"

    denied = await client.post(f"{base(org)}/agent-dms", headers=org["alice"], json={"agent_id": "ag_barry"})
    assert denied.status_code == 403 and denied.json()["detail"] == "agent_access_required"

    grant = await agent_access.create_grant(db_session, org["space"], org["danny_id"], "ag_barry",
                                            org["alice_id"], "consultant")
    await db_session.commit()
    shared = await client.post(f"{base(org)}/agent-dms", headers=org["alice"], json={"agent_id": "ag_barry"})
    assert shared.status_code == 201
    room_id = shared.json()["room_id"]
    assert (await client.post(f"/api/dashboard/rooms/{room_id}/send", headers=org["alice"],
                              json={"text": "Barry 你好"})).status_code == 202

    await agent_access.revoke_grant(db_session, org["space"], org["danny_id"], grant.id)
    await db_session.commit()
    blocked = await client.post(f"/api/dashboard/rooms/{room_id}/send", headers=org["alice"], json={"text": "还在吗"})
    assert blocked.status_code == 403 and blocked.json()["detail"] == "agent_access_revoked"

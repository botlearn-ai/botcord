"""Identity admission and revocation tests with real user authentication."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.models import (
    Agent, AgentOwnership, Base, OrganizationPolicy, PersonalSpace, Space,
    SpaceAgentMembership, SpaceAuditEvent, SpaceRoleBinding, SpaceUserMembership, User,
)
from hub.services import spaces
from tests.test_app.conftest import create_test_engine

SECRET = "test-spaces-supabase-secret-0123456789"


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
async def actors(db_session):
    users = [User(display_name=name, supabase_user_id=uuid.uuid4()) for name in ("Danny", "Alice", "Eve")]
    db_session.add_all(users)
    await db_session.flush()
    db_session.add(Agent(agent_id="ag_barry", display_name="Barry", user_id=users[1].id,
                         claimed_at=datetime.datetime.now(datetime.timezone.utc)))
    await db_session.commit()
    return [u.id for u in users]


@pytest_asyncio.fixture
async def client(db_session, monkeypatch):
    import app.auth as app_auth
    from hub.database import get_db
    from hub.main import app
    monkeypatch.setattr(app_auth, "SUPABASE_JWT_SECRET", SECRET)
    async def override():
        yield db_session
    app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


async def headers(db, user_id):
    user = await db.get(User, user_id)
    token = jwt.encode({"sub": str(user.supabase_user_id), "aud": "authenticated",
                        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)}, SECRET)
    return {"Authorization": f"Bearer {token}"}


async def setup_members(db, actors):
    owner, alice, _ = actors
    org = await spaces.create_organization(db, owner, "acme", "Acme")
    await spaces.invite_user(db, org.space_id, owner, alice)
    await spaces.accept_invitation(db, org.space_id, alice)
    await db.commit()
    return org.space_id


@pytest.mark.asyncio
async def test_personal_space_is_idempotent_and_private(client, db_session, actors):
    auth = await headers(db_session, actors[0])
    first = await client.get("/api/spaces", headers=auth)
    again = await client.get("/api/spaces", headers=auth)
    assert first.status_code == 200
    assert first.json() == again.json()
    space_id = first.json()["spaces"][0]["id"]
    assert first.json()["spaces"][0]["kind"] == "personal"
    assert (await client.get(f"/api/spaces/{space_id}/members", headers=await headers(db_session, actors[1]))).status_code == 404
    assert (await client.get("/api/spaces")).status_code == 401


@pytest.mark.asyncio
async def test_new_authenticated_user_gets_personal_space(client, db_session):
    subject = uuid.uuid4()
    token = jwt.encode({"sub": str(subject), "aud": "authenticated", "exp": 9999999999}, SECRET)
    response = await client.get("/api/spaces", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    user = await db_session.scalar(select(User).where(User.supabase_user_id == subject))
    assert await db_session.scalar(select(PersonalSpace).where(PersonalSpace.user_id == user.id))


@pytest.mark.asyncio
async def test_invitation_requires_consent_and_does_not_import_agents(db_session, actors):
    owner, alice, eve = actors
    org = await spaces.create_organization(db_session, owner, "acme", "Acme")
    invitation = await spaces.invite_user(db_session, org.space_id, owner, alice)
    assert invitation.status == "invited"
    with pytest.raises(HTTPException):
        await spaces.require_membership(db_session, org.space_id, alice)
    with pytest.raises(HTTPException):
        await spaces.accept_invitation(db_session, org.space_id, eve)
    await spaces.accept_invitation(db_session, org.space_id, alice)
    assert await db_session.scalar(select(func.count()).select_from(SpaceAgentMembership)) == 0
    with pytest.raises(HTTPException):
        await spaces.invite_user(db_session, org.space_id, alice, eve)


@pytest.mark.asyncio
async def test_admission_requires_both_agent_owner_and_organization(client, db_session, actors):
    space_id = await setup_members(db_session, actors)
    base = f"/api/spaces/{space_id}/agents/ag_barry/admission"
    owner_auth = await headers(db_session, actors[0])
    alice_auth = await headers(db_session, actors[1])
    assert (await client.post(base + "/approve", headers=owner_auth)).status_code == 404
    assert (await client.post(base, headers=owner_auth)).status_code == 403
    requested = await client.post(base, headers=alice_auth)
    assert requested.status_code == 200
    assert requested.json()["status"] == "invited"
    assert (await client.post(base + "/approve", headers=alice_auth)).status_code == 403
    approved = await client.post(base + "/approve", headers=owner_auth)
    assert approved.status_code == 200
    assert approved.json()["status"] == "active"
    assert (await client.post(base + "/approve", headers=owner_auth)).json() == approved.json()


@pytest.mark.asyncio
async def test_removal_and_rejoin_never_restore_old_agent_authority(db_session, actors):
    space_id = await setup_members(db_session, actors)
    owner, alice, _ = actors
    await spaces.request_agent_admission(db_session, space_id, alice, "ag_barry")
    membership = await spaces.approve_agent(db_session, space_id, owner, "ag_barry")
    old_version = membership.version
    personal_id = (await spaces.ensure_personal_space(db_session, alice)).id
    await spaces.remove_user(db_session, space_id, owner, alice)
    await db_session.flush()
    assert membership.status == "removed"
    assert (await spaces.require_agent_membership(db_session, personal_id, "ag_barry")).status == "active"
    await spaces.invite_user(db_session, space_id, owner, alice)
    await spaces.accept_invitation(db_session, space_id, alice)
    with pytest.raises(HTTPException):
        await spaces.require_agent_membership(db_session, space_id, "ag_barry")
    await spaces.request_agent_admission(db_session, space_id, alice, "ag_barry")
    await spaces.approve_agent(db_session, space_id, owner, "ag_barry")
    with pytest.raises(HTTPException, match="membership_version_stale"):
        await spaces.require_agent_membership(db_session, space_id, "ag_barry", expected_version=old_version)
    assert (await db_session.get(AgentOwnership, "ag_barry")).owner_user_id == alice


@pytest.mark.asyncio
async def test_sponsor_revocation_is_checked_without_cleanup(db_session, actors):
    space_id = await setup_members(db_session, actors)
    await spaces.request_agent_admission(db_session, space_id, actors[1], "ag_barry")
    await spaces.approve_agent(db_session, space_id, actors[0], "ag_barry")
    sponsor = await spaces.require_membership(db_session, space_id, actors[1])
    sponsor.status = "suspended"
    sponsor.version += 1
    await db_session.flush()
    with pytest.raises(HTTPException):
        await spaces.require_agent_membership(db_session, space_id, "ag_barry")


@pytest.mark.asyncio
async def test_organization_contexts_are_independent(db_session, actors):
    first = await setup_members(db_session, actors)
    second = await spaces.create_organization(db_session, actors[0], "second", "Second")
    await spaces.request_agent_admission(db_session, first, actors[1], "ag_barry")
    await spaces.approve_agent(db_session, first, actors[0], "ag_barry")
    with pytest.raises(HTTPException):
        await spaces.require_agent_membership(db_session, second.space_id, "ag_barry")
    with pytest.raises(HTTPException):
        await spaces.remove_user(db_session, first, actors[0], actors[0])
    await spaces.invite_user(db_session, second.space_id, actors[0], actors[1])
    await spaces.accept_invitation(db_session, second.space_id, actors[1])
    await spaces.request_agent_admission(db_session, second.space_id, actors[1], "ag_barry")
    await spaces.approve_agent(db_session, second.space_id, actors[0], "ag_barry")
    await spaces.remove_agent(db_session, first, actors[0], "ag_barry")
    assert (await spaces.require_agent_membership(db_session, second.space_id, "ag_barry")).status == "active"
    personal = await spaces.ensure_personal_space(db_session, actors[1])
    assert (await spaces.require_agent_membership(db_session, personal.id, "ag_barry")).status == "active"


@pytest.mark.asyncio
async def test_policy_defaults_versions_and_external_gate(client, db_session, actors):
    auth = await headers(db_session, actors[0])
    created = await client.post("/api/organizations", headers=auth, json={"slug": "acme", "name": "Acme"})
    assert created.status_code == 201
    org = created.json()
    policy = await db_session.get(OrganizationPolicy, uuid.UUID(org["id"]))
    assert not policy.admin_dm_content_access_enabled and not policy.external_communication_enabled
    path = f"/api/organizations/{org['id']}/policies"
    body = {"expected_version": 1, "admin_dm_content_access_enabled": True}
    assert (await client.patch(path, headers=auth, json=dict(body, external_communication_enabled=True))).status_code == 403
    assert (await client.patch(path, headers=await headers(db_session, actors[1]), json=body)).status_code == 404
    response = await client.patch(path, headers=auth, json=body)
    assert response.status_code == 200
    assert response.json()["policy_version"] == 2
    assert response.json()["content_audit_available"] is False
    assert (await client.patch(path, headers=auth, json=body)).status_code == 409
    body.update(expected_version=2, admin_dm_content_access_enabled=False)
    assert (await client.patch(path, headers=auth, json=body)).status_code == 200
    events = (await db_session.scalars(select(SpaceAuditEvent).where(SpaceAuditEvent.action == "organization.policy.updated"))).all()
    assert len(events) == 2
    assert events[1].details["policy_version"] == 3


@pytest.mark.asyncio
async def test_unique_slug_returns_conflict_without_partial_space(client, db_session, actors):
    auth = await headers(db_session, actors[0])
    body = {"slug": "acme", "name": "Acme"}
    assert (await client.post("/api/organizations", headers=auth, json=body)).status_code == 201
    assert (await client.post("/api/organizations", headers=auth, json=body)).status_code == 409
    assert await db_session.scalar(select(func.count()).select_from(Space)) == 2


@pytest.mark.asyncio
async def test_database_rejects_cross_space_sponsor_and_ambiguous_owner(db_session, actors):
    first = await setup_members(db_session, actors)
    personal = await spaces.ensure_personal_space(db_session, actors[1])
    sponsor = await spaces.require_membership(db_session, first, actors[1])
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(SpaceAgentMembership(space_id=personal.id, agent_id="ag_barry",
                sponsor_user_membership_id=sponsor.id, sponsor_version=sponsor.version))
            await db_session.flush()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(AgentOwnership(agent_id="ag_barry"))
            await db_session.flush()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(SpaceRoleBinding(space_id=personal.id, user_membership_id=sponsor.id, role_key="owner"))
            await db_session.flush()


@pytest.mark.asyncio
async def test_agent_token_cannot_perform_user_governance(client, db_session, actors):
    from hub.auth import create_agent_token
    token, _ = create_agent_token("ag_barry")
    response = await client.post("/api/organizations", headers={"Authorization": f"Bearer {token}"},
                                 json={"slug": "forged", "name": "Forged"})
    assert response.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["space_suspended", "owner_changed", "user_banned", "agent_disabled"])
async def test_identity_changes_invalidate_active_agent_membership(db_session, actors, change):
    space_id = await setup_members(db_session, actors)
    await spaces.request_agent_admission(db_session, space_id, actors[1], "ag_barry")
    await spaces.approve_agent(db_session, space_id, actors[0], "ag_barry")
    if change == "space_suspended":
        (await db_session.get(Space, space_id)).status = "suspended"
    elif change == "user_banned":
        (await db_session.get(User, actors[1])).banned_at = datetime.datetime.now(datetime.timezone.utc)
    else:
        agent = await db_session.scalar(select(Agent).where(Agent.agent_id == "ag_barry"))
        if change == "owner_changed":
            agent.user_id = actors[2]
        else:
            agent.status = "deleted"
    await db_session.flush()
    with pytest.raises(HTTPException):
        await spaces.require_agent_membership(db_session, space_id, "ag_barry")


@pytest.mark.asyncio
async def test_personal_agent_backfill_is_idempotent(db_session, actors):
    await spaces.register_personal_agent(db_session, actors[1], "ag_barry")
    await db_session.commit()
    await spaces.register_personal_agent(db_session, actors[1], "ag_barry")
    await db_session.commit()
    assert await db_session.scalar(select(func.count()).select_from(AgentOwnership)) == 1
    assert await db_session.scalar(select(func.count()).select_from(SpaceAgentMembership)) == 1


@pytest.mark.asyncio
async def test_commit_failure_does_not_send_success(client, db_session, actors, monkeypatch):
    auth = await headers(db_session, actors[0])
    async def fail_commit():
        raise IntegrityError("test commit failure", {}, Exception("constraint"))
    monkeypatch.setattr(db_session, "commit", fail_commit)
    response = await client.post("/api/organizations", headers=auth, json={"slug": "acme", "name": "Acme"})
    assert response.status_code == 409
    assert await db_session.scalar(select(func.count()).select_from(Space)) == 0


@pytest.mark.asyncio
async def test_ui_invites_public_identity_and_receives_scoped_member_details(client, db_session, actors):
    space_id = await setup_members(db_session, actors)
    owner, alice, eve = actors
    eve_human_id = (await db_session.get(User, eve)).human_id
    owner_auth = await headers(db_session, owner)
    path = f"/api/spaces/{space_id}"
    assert (await client.post(path + "/invitations", headers=await headers(db_session, alice), json={"human_id": eve_human_id})).status_code == 403
    assert (await client.post(path + "/invitations", headers=owner_auth, json={"human_id": eve_human_id, "user_id": str(eve)})).status_code == 422
    assert (await client.post(path + "/invitations", headers=owner_auth, json={"human_id": eve_human_id})).status_code == 200
    await spaces.request_agent_admission(db_session, space_id, alice, "ag_barry")
    await db_session.commit()
    response = await client.get(path + "/members", headers=owner_auth)
    assert response.status_code == 200
    data = response.json()
    assert next(m for m in data["users"] if m["user_id"] == str(owner))["roles"] == ["owner"]
    sponsor = next(m for m in data["users"] if m["user_id"] == str(alice))
    assert sponsor["display_name"] == "Alice"
    assert data["agents"][0]["display_name"] == "Barry"
    assert data["agents"][0]["sponsor_user_membership_id"] == sponsor["id"]
    assert "email" not in sponsor
    assert (await client.get(path + "/members", headers=await headers(db_session, eve))).status_code == 404

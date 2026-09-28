"""Shareable organization invite links: preview without login, join after sign-up."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.models import Base, SpaceInviteLink, SpaceRoleBinding, SpaceUserMembership, User
from hub.services import spaces
from tests.test_app.conftest import create_test_engine

SECRET = "test-org-invites-supabase-secret-0123456789"


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


def token_for(sub: uuid.UUID) -> dict:
    token = jwt.encode(
        {"sub": str(sub), "aud": "authenticated", "email": f"{sub.hex[:6]}@example.com",
         "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
        SECRET,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def org(db_session):
    danny = User(display_name="Danny", supabase_user_id=uuid.uuid4())
    member = User(display_name="Mia", supabase_user_id=uuid.uuid4())
    db_session.add_all([danny, member])
    await db_session.flush()
    acme = await spaces.create_organization(db_session, danny.id, "acme", "Acme")
    await spaces.invite_user(db_session, acme.space_id, danny.id, member.id)
    await spaces.accept_invitation(db_session, acme.space_id, member.id)
    await db_session.commit()
    # Plain values: failed requests roll the shared session back and expire ORM objects.
    return {"space": acme.space_id, "danny_id": danny.id, "danny_sub": danny.supabase_user_id,
            "member_id": member.id, "member_sub": member.supabase_user_id}


async def _create(client, org, **body):
    return await client.post(f"/api/spaces/{org['space']}/invite-links", json=body,
                             headers=token_for(org["danny_sub"]))


@pytest.mark.asyncio
async def test_new_user_previews_signs_up_and_joins(client, db_session, org):
    link = (await _create(client, org, expires_in_days=7)).json()
    assert link["path"] == f"/join/{link['code']}"
    assert link["status"] == "active"

    preview = await client.get(f"/api/org-invites/{link['code']}")  # no login
    assert preview.status_code == 200
    assert preview.json() | {"expires_at": None} == {
        "space_id": str(org["space"]), "organization_name": "Acme", "inviter_name": "Danny",
        "member_count": 2, "status": "active", "expires_at": None, "single_use": True,
    }

    newcomer = uuid.uuid4()  # never used BotCord before
    joined = await client.post(f"/api/org-invites/{link['code']}/accept", headers=token_for(newcomer))
    assert joined.status_code == 200, joined.text
    assert joined.json() == {"space_id": str(org["space"]), "status": "active"}

    user = await db_session.scalar(select(User).where(User.supabase_user_id == newcomer))
    assert user.beta_access is True
    membership = await spaces.require_membership(db_session, org["space"], user.id)
    roles = await spaces.roles_for(db_session, membership)
    assert roles == {"member"}
    again = await client.post(f"/api/org-invites/{link['code']}/accept", headers=token_for(newcomer))
    assert again.status_code == 200
    stored = await db_session.get(SpaceInviteLink, uuid.UUID(link["id"]))
    await db_session.refresh(stored)
    assert stored.use_count == 1  # idempotent re-accept does not consume a use


@pytest.mark.asyncio
async def test_only_managers_manage_links(client, org):
    by_member = await client.post(f"/api/spaces/{org['space']}/invite-links", json={},
                                  headers=token_for(org["member_sub"]))
    assert by_member.status_code == 403
    listed = await client.get(f"/api/spaces/{org['space']}/invite-links",
                              headers=token_for(org["member_sub"]))
    assert listed.status_code == 403
    bad = await _create(client, org, expires_in_days=0)
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_exhausted_expired_and_revoked_links_refuse(client, db_session, org):
    single = (await _create(client, org, max_uses=1)).json()
    assert (await client.post(f"/api/org-invites/{single['code']}/accept",
                              headers=token_for(uuid.uuid4()))).status_code == 200
    exhausted = await client.post(f"/api/org-invites/{single['code']}/accept", headers=token_for(uuid.uuid4()))
    assert exhausted.status_code == 410
    assert exhausted.json()["detail"] == "invite_link_exhausted"
    assert (await client.get(f"/api/org-invites/{single['code']}")).json()["status"] == "exhausted"

    expiring = (await _create(client, org)).json()
    row = await db_session.get(SpaceInviteLink, uuid.UUID(expiring["id"]))
    row.expires_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)
    await db_session.commit()
    expired = await client.post(f"/api/org-invites/{expiring['code']}/accept", headers=token_for(uuid.uuid4()))
    assert expired.json()["detail"] == "invite_link_expired"

    revocable = (await _create(client, org, expires_in_days=None)).json()
    assert revocable["expires_at"] is None
    revoked = await client.delete(f"/api/spaces/{org['space']}/invite-links/{revocable['id']}",
                                  headers=token_for(org["danny_sub"]))
    assert revoked.json()["status"] == "revoked"
    refused = await client.post(f"/api/org-invites/{revocable['code']}/accept", headers=token_for(uuid.uuid4()))
    assert refused.json()["detail"] == "invite_link_revoked"
    assert (await client.get("/api/org-invites/oi_missing")).status_code == 404


@pytest.mark.asyncio
async def test_removed_member_cannot_rejoin_with_a_link(client, db_session, org):
    link = (await _create(client, org, expires_in_days=None)).json()
    await spaces.remove_user(db_session, org["space"], org["danny_id"], org["member_id"])
    await db_session.commit()
    rejoin = await client.post(f"/api/org-invites/{link['code']}/accept",
                               headers=token_for(org["member_sub"]))
    assert rejoin.status_code == 403
    assert rejoin.json()["detail"] == "membership_requires_direct_invite"
    membership = await db_session.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == org["space"], SpaceUserMembership.user_id == org["member_id"]))
    assert membership.status == "removed"
    assert await db_session.scalar(select(SpaceRoleBinding).where(
        SpaceRoleBinding.user_membership_id == membership.id)) is None


@pytest.mark.asyncio
async def test_links_are_personal_by_default(client, db_session, org):
    link = (await _create(client, org, label="给 Alice")).json()
    assert link["max_uses"] == 1
    assert link["label"] == "给 Alice"
    assert link["expires_at"] is not None  # 7 days by default

    alice = uuid.uuid4()
    assert (await client.post(f"/api/org-invites/{link['code']}/accept", headers=token_for(alice))).status_code == 200
    # Forwarded to someone else: the personal link is already used.
    other = await client.post(f"/api/org-invites/{link['code']}/accept", headers=token_for(uuid.uuid4()))
    assert other.status_code == 410
    assert other.json()["detail"] == "invite_link_exhausted"
    # The invitee re-opening their own link still works (idempotent).
    assert (await client.post(f"/api/org-invites/{link['code']}/accept", headers=token_for(alice))).status_code == 200

    listed = (await client.get(f"/api/spaces/{org['space']}/invite-links",
                               headers=token_for(org["danny_sub"]))).json()["links"]
    used = next(item for item in listed if item["id"] == link["id"])
    assert used["status"] == "exhausted"
    assert used["redeemed_by_name"] is not None
    assert used["redeemed_at"] is not None

    shared = (await _create(client, org, max_uses=None)).json()
    assert shared["max_uses"] is None

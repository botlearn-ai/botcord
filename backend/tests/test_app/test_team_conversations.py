"""Real-auth, real-DB regression coverage for organization message boundaries."""
import uuid

import pytest

from hub.models import OrganizationPolicy, Space, SpaceUserMembership, User
from hub.services import spaces
from tests.test_app.test_spaces import actors, client, db_session, headers, setup_members  # noqa: F401

pytestmark = pytest.mark.asyncio


async def room(client, auth, base, **kwargs):
    response = await client.post(base, headers=auth, json={"name": "Project", **kwargs})
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def member_id(db, sid, uid):
    return str((await spaces.require_membership(db, sid, uid)).id)


async def test_room_messages_unread_pagination_and_idempotent_retry(client, db_session, actors):
    sid = await setup_members(db_session, actors)
    base = f"/api/spaces/{sid}/conversations"
    owner, alice = [await headers(db_session, uid) for uid in actors[:2]]
    rid = await room(client, owner, base)
    path = f"{base}/{rid}/messages"
    retry = {"content": "First", "client_id": str(uuid.uuid4())}
    first = await client.post(path, headers=owner, json=retry)
    assert first.status_code == 201
    assert (await client.post(path, headers=owner, json=retry)).json() == first.json()
    assert (await client.post(path, headers=owner, json={**retry, "content": "Changed"})).status_code == 409
    for i in range(2, 5):
        assert (await client.post(path, headers=alice, json={"content": f"Message {i}", "client_id": str(uuid.uuid4())})).status_code == 201
    listing = (await client.get(base, headers=owner)).json()["conversations"]
    assert listing[0]["unread_count"] == 4
    latest = (await client.get(path + "?limit=2", headers=owner)).json()
    assert [m["sequence"] for m in latest["messages"]] == [3, 4]
    assert latest["has_more"] is True
    earlier = (await client.get(path + "?before=3&limit=2", headers=owner)).json()
    assert [m["sequence"] for m in earlier["messages"]] == [1, 2]
    assert earlier["has_more"] is False
    after = (await client.get(path + "?after=1&limit=2", headers=owner)).json()
    assert [m["sequence"] for m in after["messages"]] == [2, 3]
    assert after["has_more"] is True
    assert (await client.get(path + "?after=1&before=4", headers=owner)).status_code == 422
    read_path = f"{base}/{rid}/read"
    assert (await client.put(read_path, headers=owner, json={"sequence": 999})).json()["sequence"] == 4
    assert (await client.put(read_path, headers=owner, json={"sequence": 1})).json()["sequence"] == 4
    assert (await client.get(base, headers=owner)).json()["conversations"][0]["unread_count"] == 0
    assert (await client.get(base, headers=alice)).json()["conversations"][0]["unread_count"] == 4


async def test_private_rooms_and_dms_do_not_grant_admin_bypass(client, db_session, actors):
    sid = await setup_members(db_session, actors)
    await spaces.invite_user(db_session, sid, actors[0], actors[2])
    await spaces.accept_invitation(db_session, sid, actors[2])
    await db_session.commit()
    owner, alice, eve = [await headers(db_session, uid) for uid in actors]
    base = f"/api/spaces/{sid}/conversations"
    rid = await room(client, alice, base, visibility="private")
    assert (await client.get(base, headers=owner)).json()["conversations"] == []
    for suffix, method, body in [("/messages", "GET", None), ("/messages", "POST", {"content": "secret", "client_id": str(uuid.uuid4())}), ("/read", "PUT", {"sequence": 1})]:
        response = await client.request(method, f"{base}/{rid}{suffix}", headers=owner, **({"json": body} if body else {}))
        assert response.status_code == 404
    dm = {"kind": "dm", "visibility": "private", "member_ids": [await member_id(db_session, sid, actors[2])]}
    first = await client.post(base, headers=alice, json=dm)
    assert first.status_code == 201
    reverse = {**dm, "member_ids": [await member_id(db_session, sid, actors[1])]}
    assert (await client.post(base, headers=eve, json=reverse)).json()["id"] == first.json()["id"]
    # A stored admin policy is not a content-audit endpoint.
    from sqlalchemy import select
    policy = await db_session.scalar(select(OrganizationPolicy))
    policy.admin_dm_content_access_enabled = True
    await db_session.commit()
    assert (await client.get(base, headers=owner)).json()["conversations"] == []


async def test_other_spaces_invited_removed_and_rejoined_members(client, db_session, actors):
    sid = await setup_members(db_session, actors)
    owner, alice, eve = [await headers(db_session, uid) for uid in actors]
    base = f"/api/spaces/{sid}/conversations"
    rid = await room(client, owner, base)
    private = await room(client, owner, base, visibility="private", member_ids=[await member_id(db_session, sid, actors[1])])
    other = await spaces.create_organization(db_session, actors[1], "other", "Other")
    other_id = other.space_id
    await spaces.invite_user(db_session, sid, actors[0], actors[2])
    await db_session.commit()
    assert (await client.get(base, headers=eve)).status_code == 404
    assert (await client.get(f"/api/spaces/{other_id}/conversations/{rid}/messages", headers=alice)).status_code == 404
    await spaces.remove_user(db_session, sid, actors[0], actors[1])
    await db_session.commit()
    assert (await client.get(f"{base}/{rid}/messages", headers=alice)).status_code == 404
    await spaces.invite_user(db_session, sid, actors[0], actors[1])
    await spaces.accept_invitation(db_session, sid, actors[1])
    await db_session.commit()
    assert (await client.get(f"{base}/{rid}/messages", headers=alice)).status_code == 200
    assert (await client.get(f"{base}/{private}/messages", headers=alice)).status_code == 404
    assert (await client.get(base, headers=alice)).json()["conversations"][0]["id"] == rid
    current = await db_session.get(Space, sid)
    current.status = "suspended"
    await db_session.commit()
    assert (await client.get(base, headers=owner)).status_code == 404


async def test_validation_and_personal_spaces_rejected(client, db_session, actors):
    sid = await setup_members(db_session, actors)
    auth = await headers(db_session, actors[0])
    base = f"/api/spaces/{sid}/conversations"
    for body in [{"name": " "}, {"name": "x", "visibility": "public"}, {"kind": "dm", "member_ids": []}, {"name": "x", "visibility": "private", "member_ids": [str(uuid.uuid4())]}]:
        assert (await client.post(base, headers=auth, json=body)).status_code == 422
    personal = await spaces.ensure_personal_space(db_session, actors[0])
    await db_session.commit()
    assert (await client.get(f"/api/spaces/{personal.id}/conversations", headers=auth)).status_code == 404
    assert (await client.get(base)).status_code == 401
    rid = await room(client, auth, base)
    for content in [" ", "x" * 8001]:
        assert (await client.post(f"{base}/{rid}/messages", headers=auth, json={"content": content, "client_id": str(uuid.uuid4())})).status_code == 422
    user = await db_session.get(User, actors[0])
    user.status = "suspended"
    await db_session.commit()
    assert (await client.get(base, headers=auth)).status_code in (403, 404)


async def test_manager_can_add_owned_agent_atomically(client, db_session, actors):
    from hub.models import SpaceRoleBinding
    sid = await setup_members(db_session, actors)
    alice = await spaces.require_membership(db_session, sid, actors[1])
    alice_id = alice.id
    auth = await headers(db_session, actors[1])
    path = f"/api/spaces/{sid}/agents/ag_barry/admission/add"
    assert (await client.post(path, headers=auth)).status_code == 403
    db_session.add(SpaceRoleBinding(space_id=sid, user_membership_id=alice_id, role_key="admin"))
    await db_session.commit()
    response = await client.post(path, headers=auth)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "active"
    assert (await client.post(path, headers=auth)).json() == response.json()
    assert (await client.post(path, headers=await headers(db_session, actors[0]))).status_code == 403


async def test_dm_becomes_read_only_when_peer_leaves(client, db_session, actors):
    sid = await setup_members(db_session, actors)
    owner, alice = [await headers(db_session, uid) for uid in actors[:2]]
    base = f"/api/spaces/{sid}/conversations"
    response = await client.post(base, headers=owner, json={"kind": "dm", "visibility": "private", "member_ids": [await member_id(db_session, sid, actors[1])]})
    dm = response.json()
    assert dm["can_send"] is True
    path = f"{base}/{dm['id']}/messages"
    assert (await client.post(path, headers=alice, json={"content": "Before leaving", "client_id": str(uuid.uuid4())})).status_code == 201
    await spaces.remove_user(db_session, sid, actors[0], actors[1])
    await db_session.commit()
    assert (await client.get(base, headers=owner)).json()["conversations"][0]["can_send"] is False
    assert (await client.get(path, headers=owner)).json()["messages"][0]["content"] == "Before leaving"
    assert (await client.post(path, headers=owner, json={"content": "After leaving", "client_id": str(uuid.uuid4())})).status_code == 409

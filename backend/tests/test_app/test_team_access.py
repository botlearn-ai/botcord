"""Team access UI endpoints: directory, requests, room access, agent rooms, overview, default capability."""

import asyncio
import datetime

import pytest
from sqlalchemy import select

from hub.enums import ParticipantType
from hub.models import AccessEdge, AccessGraphSetting, Contact
from hub.services.access_graph_sync import LEGACY_FULL_BEFORE_KEY, sync_access_graph
from tests.test_app.test_org_rooms import client, db_session, org  # noqa: F401 — shared fixtures


def base(org):  # noqa: F811
    return f"/api/spaces/{org['space']}"


def by_agent(rows):
    return {r["agent_id"]: r for r in rows}


@pytest.mark.asyncio
async def test_directory_and_request_lifecycle(client, org):  # noqa: F811
    d = by_agent((await client.get(f"{base(org)}/agent-directory", headers=org["alice"])).json()["agents"])
    assert d["ag_barry"]["my_access"] == "none" and d["ag_rex"]["my_access"] == "owner"
    assert d["ag_barry"]["owner_name"] == "Danny"

    # Outsiders cannot ask; owners cannot ask for their own agent.
    assert (await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["eve"],
                              json={"role": "consultant"})).status_code in (403, 404)
    assert (await client.post(f"{base(org)}/agents/ag_rex/access-requests", headers=org["alice"],
                              json={"role": "consultant"})).status_code == 422

    r = await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                          json={"role": "collaborator", "message": "想让它改登录页"})
    assert r.status_code == 201, r.text
    req_id = r.json()["id"]
    # Asking again updates the pending request instead of piling up.
    again = await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                              json={"role": "consultant"})
    assert again.json()["id"] == req_id and again.json()["requested_role"] == "consultant"

    d = by_agent((await client.get(f"{base(org)}/agent-directory", headers=org["alice"])).json()["agents"])
    assert d["ag_barry"]["pending_request"]["id"] == req_id
    danny_view = (await client.get(f"{base(org)}/access-requests", headers=org["danny"])).json()
    assert [x["id"] for x in danny_view["to_decide"]] == [req_id]
    assert danny_view["to_decide"][0]["agent_name"] == "Barry"
    assert danny_view["to_decide"][0]["requester_name"] == "Alice"
    alice_view = (await client.get(f"{base(org)}/access-requests", headers=org["alice"])).json()
    assert alice_view["to_decide"] == [] and [x["id"] for x in alice_view["mine"]] == [req_id]

    # Only the agent owner decides.
    assert (await client.post(f"{base(org)}/access-requests/{req_id}/approve", headers=org["alice"],
                              json={})).status_code == 403
    ok = await client.post(f"{base(org)}/access-requests/{req_id}/approve", headers=org["danny"],
                           json={"role": "collaborator", "workspace_path": "/repo", "allowed_commands": ["npm test"]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "approved" and ok.json()["grant_role"] == "collaborator"
    d = by_agent((await client.get(f"{base(org)}/agent-directory", headers=org["alice"])).json()["agents"])
    assert d["ag_barry"]["my_access"] == "collaborator" and d["ag_barry"]["pending_request"] is None
    # Asking for what you already have is rejected.
    assert (await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                              json={"role": "consultant"})).status_code == 409

    overview = (await client.get(f"{base(org)}/access-overview", headers=org["danny"])).json()
    assert overview["counts"]["collaborator"] == 1
    assert overview["grants"][0]["grantee_name"] == "Alice" and overview["grants"][0]["agent_name"] == "Barry"
    assert (await client.get(f"{base(org)}/access-overview", headers=org["alice"])).status_code == 403


@pytest.mark.asyncio
async def test_reject_and_cancel(client, org):  # noqa: F811
    r1 = (await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                            json={"role": "consultant"})).json()
    rej = await client.post(f"{base(org)}/access-requests/{r1['id']}/reject", headers=org["danny"])
    assert rej.json()["status"] == "rejected"
    assert (await client.post(f"{base(org)}/access-requests/{r1['id']}/approve", headers=org["danny"],
                              json={})).status_code == 409
    r2 = (await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                            json={"role": "consultant"})).json()
    assert r2["id"] != r1["id"]
    assert (await client.post(f"{base(org)}/access-requests/{r2['id']}/cancel", headers=org["danny"])).status_code == 404
    assert (await client.post(f"{base(org)}/access-requests/{r2['id']}/cancel", headers=org["alice"])).json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_room_agent_access_and_agent_rooms(client, db_session, org):  # noqa: F811
    room_id = (await client.post(f"{base(org)}/rooms", headers=org["danny"],
                                 json={"name": "dev", "visibility": "organization", "agent_ids": ["ag_barry"]})).json()["room_id"]
    await client.post(f"{base(org)}/rooms/{room_id}/join", headers=org["alice"])
    await sync_access_graph(db_session)
    await db_session.commit()

    alice = by_agent((await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["alice"])).json()["agents"])
    assert (alice["ag_barry"]["my_capability"], alice["ag_barry"]["basis"]) == ("consult", "room")
    assert alice["ag_barry"]["reply_mode"] == "always"
    danny = by_agent((await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["danny"])).json()["agents"])
    assert danny["ag_barry"]["my_capability"] == "full"

    # A collaborator grant applies in organization rooms too.
    await client.post(f"{base(org)}/agents/ag_barry/access-grants", headers=org["danny"],
                      json={"human_id": org["alice_hu"], "role": "collaborator"})
    alice = by_agent((await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["alice"])).json()["agents"])
    assert (alice["ag_barry"]["my_capability"], alice["ag_barry"]["basis"]) == ("collaborator", "grant")

    # Per-sender rule shows up for that sender only.
    await client.put("/api/agents/ag_barry/reply-rules", headers=org["danny"],
                     json={"sender_id": org["alice_hu"], "room_id": room_id, "attention_mode": "mention_only"})
    alice = by_agent((await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["alice"])).json()["agents"])
    assert alice["ag_barry"]["reply_mode"] == "mention_only"

    rooms = (await client.get(f"{base(org)}/agents/ag_barry/rooms", headers=org["danny"])).json()["rooms"]
    assert [r["room_id"] for r in rooms] == [room_id]
    assert rooms[0]["sender_rules"] == [{"sender_id": org["alice_hu"], "sender_name": "Alice",
                                         "attention_mode": "mention_only"}]
    assert (await client.get(f"{base(org)}/agents/ag_barry/rooms", headers=org["alice"])).status_code == 403
    assert (await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["eve"])).status_code in (403, 404)


@pytest.mark.asyncio
async def test_personal_default_capability(client, db_session, org):  # noqa: F811
    db_session.add(AccessGraphSetting(key=LEGACY_FULL_BEFORE_KEY,
                                      value=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    await db_session.commit()
    await asyncio.sleep(1.1)  # SQLite server timestamps have one-second resolution
    rel = (await client.get("/api/agents/ag_barry/access/relations", headers=org["danny"])).json()
    assert rel["default_capability"] == "consult"
    r = await client.patch("/api/agents/ag_barry/access/default", headers=org["danny"], json={"capability": "full"})
    assert r.status_code == 200 and r.json()["default_capability"] == "full"
    assert (await client.patch("/api/agents/ag_barry/access/default", headers=org["alice"],
                               json={"capability": "full"})).status_code == 404

    db_session.add(Contact(owner_id="ag_barry", owner_type=ParticipantType.agent,
                           contact_agent_id=org["eve_hu"], peer_type=ParticipantType.human))
    await db_session.commit()
    await sync_access_graph(db_session)
    await db_session.commit()
    cap = await db_session.scalar(select(AccessEdge.capability).where(
        AccessEdge.kind == "connection", AccessEdge.from_id == org["eve_hu"], AccessEdge.to_id == "ag_barry"))
    assert cap == "full"


@pytest.mark.asyncio
async def test_private_room_access_needs_membership_and_upgrade_replaces_grant(client, org):  # noqa: F811
    room_id = (await client.post(f"{base(org)}/rooms", headers=org["danny"],
                                 json={"name": "secret", "visibility": "private", "agent_ids": ["ag_barry"]})).json()["room_id"]
    assert (await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["alice"])).status_code == 404
    assert (await client.get(f"{base(org)}/rooms/{room_id}/agent-access", headers=org["danny"])).status_code == 200

    # A consultant who asks for collaborator and gets it ends up with exactly one live grant.
    await client.post(f"{base(org)}/agents/ag_barry/access-grants", headers=org["danny"],
                      json={"human_id": org["alice_hu"], "role": "consultant"})
    req = (await client.post(f"{base(org)}/agents/ag_barry/access-requests", headers=org["alice"],
                             json={"role": "collaborator"})).json()
    await client.post(f"{base(org)}/access-requests/{req['id']}/approve", headers=org["danny"], json={})
    grants = (await client.get(f"{base(org)}/agents/ag_barry/access-grants", headers=org["danny"])).json()["grants"]
    assert [g["role"] for g in grants] == ["collaborator"]
    d = by_agent((await client.get(f"{base(org)}/agent-directory", headers=org["alice"])).json()["agents"])
    assert d["ag_barry"]["my_access"] == "collaborator"


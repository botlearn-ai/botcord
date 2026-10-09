"""Team access read views load in a bounded number of queries with unchanged results."""

import datetime

import pytest
from sqlalchemy import event, select

from hub.models import Agent, AgentAccessRequest, AgentOwnership, User
from hub.policy import resolve_effective_attention
from hub.services import agent_access, org_rooms, spaces, team_access
from hub.services.access_graph_sync import sync_access_graph
from tests.test_app.test_org_rooms import client, db_session, org  # noqa: F401 — shared fixtures


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


async def _add_agents(db, org, names):  # noqa: F811
    """Danny's agents, admitted to the organization."""
    owner = org["danny_id"]
    for name in names:
        db.add(Agent(agent_id=f"ag_{name}", display_name=name.title(), user_id=owner, claimed_at=_now()))
    await db.flush()
    for name in names:
        await spaces.request_agent_admission(db, org["space"], owner, f"ag_{name}")
        await spaces.approve_agent(db, org["space"], org["danny_id"], f"ag_{name}")
    await db.commit()


# Fields added after the batching rewrite (presence, runtime, owner stats) are
# checked in test_team_access.py; equivalence covers the original fields.
_EXTRA = {"avatar_url", "runtime", "hosting_kind", "status", "room_count", "grant_count", "pending_request_count"}


def _base(rows):
    return [{k: v for k, v in r.items() if k not in _EXTRA} for r in rows]


async def _reference_directory(db, space_id, user_id):
    """The per-agent implementation the batched directory replaced (PR #1054)."""
    agents = await team_access._org_agents(db, space_id)
    names = await team_access._names(db, {owner for *_, owner in agents})
    pending = {r.agent_id: r for r in (await db.scalars(select(AgentAccessRequest).where(
        AgentAccessRequest.space_id == space_id, AgentAccessRequest.requester_user_id == user_id,
        AgentAccessRequest.status == "pending"))).all()}
    out = []
    for _membership, agent, display_name, owner_id in agents:
        if owner_id == user_id:
            access, grant_id = "owner", None
        else:
            grant = await agent_access.active_grant_for_pair(db, agent.agent_id, user_id)
            access, grant_id = (grant.role, grant.id) if grant is not None else ("none", None)
        req = pending.get(agent.agent_id)
        eff = await resolve_effective_attention(db, agent=agent, room_id=None)
        out.append({
            "agent_id": agent.agent_id,
            "display_name": display_name,
            "owner_user_id": owner_id,
            "owner_name": names.get(owner_id, ("", ""))[0],
            "owner_human_id": names.get(owner_id, ("", ""))[1],
            "my_access": access,
            "grant_id": grant_id,
            "pending_request": {"id": req.id, "requested_role": req.requested_role} if req else None,
            "default_reply_mode": eff.mode.value,
        })
    return out


class _Counter:
    def __init__(self, db):
        self.engine = db.bind.sync_engine
        self.count = 0

    def _on(self, *_args):
        self.count += 1

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._on)
        return self

    def __exit__(self, *_exc):
        event.remove(self.engine, "before_cursor_execute", self._on)


@pytest.mark.asyncio
async def test_directory_matches_per_agent_implementation(db_session, org):  # noqa: F811
    db = db_session
    space, danny, alice = org["space"], org["danny_id"], org["alice_id"]
    await _add_agents(db, org, ["consult", "nothing", "pending", "expired", "revoked", "moved", "quiet"])
    eve = await db.scalar(select(User).where(User.display_name == "Eve"))

    await agent_access.create_grant(db, space, danny, "ag_barry", alice, "collaborator")
    await agent_access.create_grant(db, space, danny, "ag_consult", alice, "consultant")
    await team_access.request_access(db, space, alice, "ag_pending", "collaborator", "please")
    expired = await agent_access.create_grant(db, space, danny, "ag_expired", alice, "consultant",
                                              expires_at=_now() + datetime.timedelta(hours=1))
    revoked = await agent_access.create_grant(db, space, danny, "ag_revoked", alice, "collaborator")
    await agent_access.create_grant(db, space, danny, "ag_moved", alice, "collaborator")
    await db.commit()
    await agent_access.revoke_grant(db, space, danny, revoked.id)
    expired.expires_at = _now() - datetime.timedelta(minutes=1)
    # Issuer no longer owns the agent: ownership edge moves to Eve, grant still says Danny.
    (await db.scalar(select(Agent).where(Agent.agent_id == "ag_moved"))).user_id = eve.id
    (await db.get(AgentOwnership, "ag_moved")).owner_user_id = eve.id
    (await db.scalar(select(Agent).where(Agent.agent_id == "ag_quiet"))).default_attention = "mention_only"
    await db.commit()
    await sync_access_graph(db)
    await db.commit()

    got = await team_access.agent_directory(db, space, alice)
    want = await _reference_directory(db, space, alice)
    assert _base(got) == want
    access = {r["agent_id"]: r["my_access"] for r in got}
    assert access == {
        "ag_barry": "collaborator", "ag_consult": "consultant", "ag_expired": "none", "ag_moved": "none",
        "ag_nothing": "none", "ag_pending": "none", "ag_quiet": "none", "ag_revoked": "none", "ag_rex": "owner",
    }
    by_id = {r["agent_id"]: r for r in got}
    assert by_id["ag_pending"]["pending_request"]["requested_role"] == "collaborator"
    assert by_id["ag_quiet"]["default_reply_mode"] == "mention_only"
    # Danny's view: owner of everything he sponsors, nothing else.
    assert _base(await team_access.agent_directory(db, space, danny)) == await _reference_directory(db, space, danny)


async def _bulk_agents_for_alice(db, org, names, room_id):  # noqa: F811
    """Danny's agents, each granted to Alice and sitting in the room."""
    await _add_agents(db, org, names)
    for i, name in enumerate(names):
        await agent_access.create_grant(db, org["space"], org["danny_id"], f"ag_{name}", org["alice_id"],
                                        "consultant" if i % 2 else "collaborator")
        await org_rooms.add_agent(db, org["space"], org["danny_id"], room_id, f"ag_{name}")
    await db.commit()
    await sync_access_graph(db)
    await db.commit()


async def _measure(db, org, room_id):  # noqa: F811
    with _Counter(db) as directory:
        rows = await team_access.agent_directory(db, org["space"], org["alice_id"])
    with _Counter(db) as room_access:
        in_room = await team_access.room_agent_access(db, org["space"], room_id, org["alice_id"])
    with _Counter(db) as overview:
        result = await team_access.access_overview(db, org["space"], org["danny_id"])
    return (len(rows), len(in_room), len(result["grants"])), (directory.count, room_access.count, overview.count)


@pytest.mark.asyncio
async def test_query_counts_do_not_grow_with_agents(db_session, org):  # noqa: F811
    db = db_session
    room = await org_rooms.create_room(db, org["space"], org["danny_id"], name="bulk", visibility="organization")
    await org_rooms.join_room(db, org["space"], org["alice_id"], room.room_id)
    await team_access.request_access(db, org["space"], org["alice_id"], "ag_barry", "consultant", None)
    await db.commit()

    await _bulk_agents_for_alice(db, org, ["bulk0", "bulk1"], room.room_id)
    sizes2, counts2 = await _measure(db, org, room.room_id)
    await _bulk_agents_for_alice(db, org, [f"bulk{i}" for i in range(2, 10)], room.room_id)
    sizes10, counts10 = await _measure(db, org, room.room_id)

    assert sizes2 == (4, 2, 2) and sizes10 == (12, 10, 10)
    print(f"query counts (directory, room_agent_access, access_overview): 2 agents={counts2} 10 agents={counts10}")
    assert counts2 == counts10, (counts2, counts10)

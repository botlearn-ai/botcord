"""Access-graph decisions and their shadow comparison (docs/access-graph-model.md §4, §8 PR 2)."""

import datetime
import json
import logging

import pytest
import pytest_asyncio
from sqlalchemy import select

from hub.enums import ParticipantType, RoomRole
from hub.i18n import I18nHTTPException
from hub.models import Agent, Room, RoomMember
from hub.policy import Principal, check_direct_admission
from hub.services import spaces
from hub.services.access_decide import (
    decide_direct,
    decide_execution_many,
    decide_room_invite,
    shadow_inbox,
)
from hub.services.access_graph_sync import sync_access_graph
from tests.test_app.test_access_graph_sync import db, world  # noqa: F401 — shared fixtures

H, A = ParticipantType.human, ParticipantType.agent


@pytest_asyncio.fixture
async def graph(db, world):  # noqa: F811
    """world + Danny's second agent Bolt + Zed who only shares a room with Rex."""
    from hub.models import User
    import uuid

    now = datetime.datetime.now(datetime.timezone.utc)
    zed = User(display_name="Zed", supabase_user_id=uuid.uuid4())
    db.add(zed)
    await db.flush()
    db.add(Agent(agent_id="ag_bolt", display_name="Bolt", user_id=world["users"]["Danny"].id, claimed_at=now))
    db.add(Room(room_id="rm_lounge", name="lounge", owner_id=zed.human_id, owner_type=H))
    await db.flush()
    db.add_all([
        RoomMember(room_id="rm_lounge", agent_id=zed.human_id, participant_type=H, role=RoomRole.owner),
        RoomMember(room_id="rm_lounge", agent_id="ag_rex", participant_type=A, role=RoomRole.member),
    ])
    await db.commit()
    await sync_access_graph(db)
    await db.commit()
    return {**world, "zed": zed.human_id}


async def agent(db, agent_id):  # noqa: F811
    return await db.scalar(select(Agent).where(Agent.agent_id == agent_id))


def shadow_lines(caplog):
    return [json.loads(r.getMessage().split(" ", 1)[1]) for r in caplog.records
            if r.name == "hub.access_shadow" and r.getMessage().startswith("access_shadow {")]


@pytest.mark.asyncio
async def test_decide_direct_paths(db, graph):  # noqa: F811
    hu = graph["hu"]
    barry, rex = await agent(db, "ag_barry"), await agent(db, "ag_rex")
    cases = {
        (hu["Danny"], "ag_barry"): (True, "ownership", "full"),
        ("ag_bolt", "ag_barry"): (True, "ownership", "full"),  # same owner, two hops
        (hu["Alice"], "ag_barry"): (True, "grant", "collaborator"),
        (hu["Eve"], "ag_barry"): (True, "offer", "consult"),  # Barry is open to everyone
        (hu["Eve"], "ag_rex"): (False, "blocked", None),
        (graph["zed"], "ag_rex"): (False, "room_only", None),  # shared room never opens a DM
    }
    for (sender, agent_id), want in cases.items():
        d = await decide_direct(db, sender_id=sender, agent=barry if agent_id == "ag_barry" else rex)
        assert (d.allowed, d.reason, d.capability) == want, (sender, agent_id, d)
    assert len((await decide_direct(db, sender_id="ag_bolt", agent=barry)).path) == 2


@pytest.mark.asyncio
async def test_grant_stops_when_dependency_breaks(db, graph):  # noqa: F811
    hu, users = graph["hu"], graph["users"]
    await spaces.remove_user(db, graph["acme"].space_id, users["Danny"].id, users["Alice"].id)
    await db.commit()
    await sync_access_graph(db)
    await db.commit()
    d = await decide_direct(db, sender_id=hu["Alice"], agent=await agent(db, "ag_barry"))
    # The grant depends on Alice's membership; she still has Barry's contact edge.
    assert (d.reason, d.capability) == ("connection", "consult")


@pytest.mark.asyncio
async def test_decide_room_invite(db, graph):  # noqa: F811
    hu = graph["hu"]
    barry = await agent(db, "ag_barry")
    assert (await decide_room_invite(db, inviter_id=hu["Danny"], agent=barry)).reason == "ownership"
    assert (await decide_room_invite(db, inviter_id=hu["Alice"], agent=barry)).reason == "connection"
    assert not (await decide_room_invite(db, inviter_id=hu["Eve"], agent=barry)).allowed


@pytest.mark.asyncio
async def test_decide_execution_many(db, graph):  # noqa: F811
    hu = graph["hu"]
    out = await decide_execution_many(db, agent_id="ag_barry",
                                      sender_ids={hu["Danny"], "ag_bolt", hu["Alice"], hu["Eve"]})
    assert {k: (v.reason, v.capability) for k, v in out.items()} == {
        hu["Danny"]: ("ownership", "full"),
        "ag_bolt": ("ownership", "full"),
        hu["Alice"]: ("grant", "collaborator"),
        hu["Eve"]: ("default", None),
    }


@pytest.mark.asyncio
async def test_shadow_logs_only_disagreements(db, graph, caplog):  # noqa: F811
    caplog.set_level(logging.INFO, logger="hub.access_shadow")
    hu = graph["hu"]
    rex, barry = await agent(db, "ag_rex"), await agent(db, "ag_barry")

    # Agreement: Barry is open, both sides allow -> no log line.
    await check_direct_admission(db, sender=Principal(hu["Eve"], H), receiver=barry)
    # Agreement: Rex blocked Eve, both sides deny.
    with pytest.raises(I18nHTTPException):
        await check_direct_admission(db, sender=Principal(hu["Eve"], H), receiver=rex)
    assert shadow_lines(caplog) == []

    # Legacy lets Zed DM Rex because they share a room; the graph does not (by design).
    await check_direct_admission(db, sender=Principal(graph["zed"], H), receiver=rex)
    [line] = shadow_lines(caplog)
    assert line["check"] == "direct" and line["kind"] == "expected_room_bypass"
    assert line["legacy"] == {"allowed": True, "reason": "same_room"}
    assert line["graph"] == {"allowed": False, "reason": "room_only"}


@pytest.mark.asyncio
async def test_shadow_inbox_agrees_with_legacy_signals(db, graph, caplog):  # noqa: F811
    from hub.routers.hub import _load_access_contexts, _load_same_owner_senders

    caplog.set_level(logging.INFO, logger="hub.access_shadow")
    hu = graph["hu"]
    senders = {hu["Danny"], "ag_bolt", hu["Alice"], hu["Eve"]}
    same = await _load_same_owner_senders(db, "ag_barry", senders)
    ctx = await _load_access_contexts(db, "ag_barry", senders - same)
    await shadow_inbox(db, agent_id="ag_barry", sender_ids=senders, legacy_same_owner=same, legacy_access=ctx)
    assert shadow_lines(caplog) == []


@pytest.mark.asyncio
async def test_same_owner_room_invite_is_expected_difference(db, graph, caplog):  # noqa: F811
    from hub.policy import check_room_invite_admission

    caplog.set_level(logging.INFO, logger="hub.access_shadow")
    # Legacy: Bolt may not pull its sibling Barry into a room without a contact edge.
    with pytest.raises(I18nHTTPException):
        await check_room_invite_admission(db, inviter=Principal("ag_bolt", A), invitee=await agent(db, "ag_barry"))
    [line] = shadow_lines(caplog)
    assert line["check"] == "room_invite" and line["kind"] == "expected_same_owner_invite"
    assert line["graph"] == {"allowed": True, "reason": "ownership"}


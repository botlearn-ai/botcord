"""Hub-side wake + execution decisions and owner capability controls (PR 4)."""

import asyncio
import datetime

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select

from app.auth import RequestContext
from app.routers.agent_relations import CapabilityIn, ReplyRuleIn, put_reply_rule, set_capability
from hub.enums import AttentionMode, ParticipantType, RoomRole
from hub.models import (
    AccessEdge,
    AccessGraphSetting,
    Agent,
    AgentRoomPolicyOverride,
    Contact,
    Room,
    RoomMember,
)
from hub.services.access_graph_sync import LEGACY_FULL_BEFORE_KEY, sync_access_graph
from hub.services.access_inbox import InboxItem, decide_inbox
from tests.test_app.test_access_graph_sync import db, world  # noqa: F401 — shared fixtures

H, A = ParticipantType.human, ParticipantType.agent


@pytest_asyncio.fixture
async def setup(db, world):  # noqa: F811
    """Everything in ``world`` predates the cutoff; Zed befriends Barry afterwards."""
    from hub.models import User
    import uuid

    db.add(AccessGraphSetting(key=LEGACY_FULL_BEFORE_KEY,
                              value=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    await db.commit()
    await sync_access_graph(db)
    await db.commit()
    await asyncio.sleep(1.1)  # SQLite server timestamps have one-second resolution
    zed = User(display_name="Zed", supabase_user_id=uuid.uuid4())
    db.add(zed)
    await db.flush()
    db.add(Contact(owner_id="ag_barry", owner_type=A, contact_agent_id=zed.human_id, peer_type=H))
    db.add(Room(room_id="rm_new", name="new", owner_id=world["hu"]["Danny"], owner_type=H))
    await db.flush()
    db.add(RoomMember(room_id="rm_new", agent_id="ag_barry", participant_type=A, role=RoomRole.member))
    await db.commit()
    await sync_access_graph(db)
    await db.commit()
    barry = await db.scalar(select(Agent).where(Agent.agent_id == "ag_barry"))
    return {**world, "zed": zed.human_id, "barry": barry}


def item(i, sender, room, *, text="hi", mentioned=False, source_type=None):
    return InboxItem(hub_msg_id=f"h{i}", sender_id=sender, room_id=room, source_type=source_type,
                     mentioned=mentioned, text=text)


async def capability(db, **where):  # noqa: F811
    q = select(AccessEdge.capability).where(AccessEdge.status == "active")
    for k, v in where.items():
        q = q.where(getattr(AccessEdge, k) == v)
    return await db.scalar(q)


@pytest.mark.asyncio
async def test_legacy_relations_full_new_ones_consult(db, setup):  # noqa: F811
    hu = setup["hu"]
    assert await capability(db, kind="connection", from_id=hu["Alice"], to_id="ag_barry") == "full"
    assert await capability(db, kind="connection", from_id=setup["zed"], to_id="ag_barry") == "consult"
    assert await capability(db, kind="member", from_id="ag_barry", to_id="rm_dev") == "full"
    assert await capability(db, kind="member", from_id="ag_barry", to_id="rm_new") == "consult"
    assert await capability(db, kind="offer", to_id="ag_barry") == "full"


@pytest.mark.asyncio
async def test_profiles(db, setup):  # noqa: F811
    hu, barry = setup["hu"], setup["barry"]
    dm_alice = f"rm_dm_{hu['Alice']}_ag_barry"
    items = [
        item(1, hu["Danny"], "rm_dev"),                          # owner
        item(2, hu["Danny"], "rm_oc_x", source_type="dashboard_user_chat"),  # owner channel
        item(3, hu["Alice"], dm_alice),                          # grant (collaborator)
        item(4, setup["zed"], f"rm_dm_{setup['zed']}_ag_barry"),  # new friend, but Barry is public (legacy full)
        item(5, hu["Eve"], f"rm_dm_{hu['Eve']}_ag_barry"),        # public offer (legacy) -> full
        item(6, hu["Eve"], "rm_new"),                            # new room -> consult
        item(7, hu["Eve"], "rm_dev"),                            # legacy room -> full
    ]
    out = await decide_inbox(db, agent=barry, items=items, access_contexts={})
    got = {k: (v["profile"], v["basis"]) for k, v in out.items()}
    assert got == {
        "h1": ("full", "owner"), "h2": ("full", "owner_channel"), "h3": ("collaborator", "grant"),
        "h4": ("full", "offer"), "h5": ("full", "offer"), "h6": ("consult", "room"), "h7": ("full", "room"),
    }
    # Once the owner lowers the public offer, the new friend falls back to 'consult'.
    ctx = RequestContext(user_id=setup["users"]["Danny"].id, supabase_user_id="x")
    await set_capability("ag_barry", CapabilityIn(kind="public", capability="consult"), ctx, db)
    await db.commit()
    again = await decide_inbox(db, agent=barry, items=[item(4, setup["zed"], f"rm_dm_{setup['zed']}_ag_barry")],
                               access_contexts={})
    assert (again["h4"]["profile"], again["h4"]["basis"]) == ("consult", "connection")
    # A sender whose grant went inactive is refused in the DM.
    inactive = await decide_inbox(db, agent=barry, items=[item(8, hu["Eve"], f"rm_dm_{hu['Eve']}_ag_barry")],
                                  access_contexts={hu["Eve"]: {"active": False, "role": "collaborator"}})
    assert inactive["h8"]["profile"] == "deny"


@pytest.mark.asyncio
async def test_owner_raises_and_org_room_stays_fixed(db, setup):  # noqa: F811
    users, barry = setup["users"], setup["barry"]
    ctx = RequestContext(user_id=users["Danny"].id, supabase_user_id="x")
    await set_capability("ag_barry", CapabilityIn(kind="public", capability="consult"), ctx, db)
    await set_capability("ag_barry", CapabilityIn(kind="connection", target_id=setup["zed"], capability="full"), ctx, db)
    await db.commit()
    out = await decide_inbox(db, agent=barry, items=[item(1, setup["zed"], f"rm_dm_{setup['zed']}_ag_barry")],
                             access_contexts={})
    assert out["h1"]["profile"] == "full"
    # The change is audited with the owner's principal id (fits the 32-char column).
    from hub.models import AccessEdgeEvent
    actors = set((await db.scalars(select(AccessEdgeEvent.actor_id).where(AccessEdgeEvent.event == "capability"))).all())
    assert actors == {setup["hu"]["Danny"]}
    # The projection never overwrites the owner's choice.
    await sync_access_graph(db)
    await db.commit()
    assert await capability(db, kind="connection", from_id=setup["zed"], to_id="ag_barry") == "full"

    room = await db.scalar(select(Room).where(Room.room_id == "rm_new"))
    room.space_id = setup["acme"].space_id
    await db.commit()
    with pytest.raises(HTTPException) as exc:
        await set_capability("ag_barry", CapabilityIn(kind="room", target_id="rm_new", capability="full"), ctx, db)
    assert exc.value.status_code == 409
    other = RequestContext(user_id=users["Alice"].id, supabase_user_id="y")
    with pytest.raises(HTTPException):
        await set_capability("ag_barry", CapabilityIn(kind="public", capability="consult"), other, db)


@pytest.mark.asyncio
async def test_wake_rules_and_sender_precedence(db, setup):  # noqa: F811
    hu, barry, users = setup["hu"], setup["barry"], setup["users"]
    ctx = RequestContext(user_id=users["Danny"].id, supabase_user_id="x")
    barry.default_attention = AttentionMode.mention_only
    await db.commit()

    out = await decide_inbox(db, agent=barry, items=[
        item(1, hu["Eve"], "rm_dev", text="hello all"),
        item(2, hu["Eve"], "rm_dev", text="hey @Barry look"),       # text mention
        item(3, hu["Eve"], f"rm_dm_{hu['Eve']}_ag_barry", text="x"),  # DMs always wake
    ], access_contexts={})
    assert [(out[k]["wake"], out[k]["wake_reason"]) for k in ("h1", "h2", "h3")] == [
        (False, "mention_required"), (True, "mentioned"), (True, "direct")]

    # Sender rule (all rooms): Alice wakes Barry without a mention.
    await put_reply_rule("ag_barry", ReplyRuleIn(sender_id=hu["Alice"], attention_mode=AttentionMode.always), ctx, db)
    await db.commit()
    out = await decide_inbox(db, agent=barry, items=[item(1, hu["Alice"], "rm_dev", text="plain")], access_contexts={})
    assert out["h1"]["wake"] is True
    # A room override beats the sender-wide rule...
    db.add(AgentRoomPolicyOverride(agent_id="ag_barry", room_id="rm_dev", attention_mode=AttentionMode.mention_only))
    await db.commit()
    out = await decide_inbox(db, agent=barry, items=[item(1, hu["Alice"], "rm_dev", text="plain")], access_contexts={})
    assert out["h1"]["wake"] is False
    # ...and a room + sender rule beats the room override.
    await put_reply_rule("ag_barry", ReplyRuleIn(sender_id=hu["Alice"], room_id="rm_dev",
                                                 attention_mode=AttentionMode.always), ctx, db)
    await db.commit()
    out = await decide_inbox(db, agent=barry, items=[item(1, hu["Alice"], "rm_dev", text="plain")], access_contexts={})
    assert out["h1"]["wake"] is True


@pytest.mark.asyncio
async def test_org_dm_is_direct(db, setup):  # noqa: F811
    """Team-mode DMs (rm_sdm_*) always wake and use DM rules, like rm_dm_*."""
    from hub.policy import is_direct_room_id, resolve_effective_attention

    barry, hu = setup["barry"], setup["hu"]
    assert is_direct_room_id("rm_sdm_4e232f38c2d98e6b31b3") and not is_direct_room_id("rm_dev")
    barry.default_attention = AttentionMode.mention_only
    await db.commit()
    eff = await resolve_effective_attention(db, agent=barry, room_id="rm_sdm_4e232f38c2d98e6b31b3")
    assert eff.source == "dm_forced"
    out = await decide_inbox(db, agent=barry, items=[item(1, hu["Danny"], "rm_sdm_4e232f38c2d98e6b31b3", text="hi")],
                             access_contexts={})
    assert (out["h1"]["wake"], out["h1"]["wake_reason"], out["h1"]["profile"]) == (True, "direct", "full")

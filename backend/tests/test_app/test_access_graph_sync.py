"""Legacy relation tables -> access graph projection (docs/access-graph-model.md §7)."""

import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.enums import ContactPolicy, ContactRequestState, ParticipantType, RoomRole
from hub.models import (
    PUBLIC_PRINCIPAL_ID,
    AccessEdge,
    AccessEdgeDep,
    AccessEdgeEvent,
    AccessPrincipal,
    Agent,
    AgentAccessGrant,
    Base,
    Block,
    Contact,
    ContactRequest,
    Organization,
    Room,
    RoomMember,
    SpaceAgentMembership,
    SpaceUserMembership,
    User,
)
from hub.services import spaces
from hub.services.access_graph_sync import sync_access_graph
from tests.test_app.conftest import create_test_engine

H, A = ParticipantType.human, ParticipantType.agent


@pytest_asyncio.fixture
async def db():
    engine = create_test_engine()

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def world(db):
    """Danny owns Barry (open to everyone) and Acme; Alice is a member with a grant on Barry."""
    now = datetime.datetime.now(datetime.timezone.utc)
    users = {n: User(display_name=n, supabase_user_id=uuid.uuid4()) for n in ("Danny", "Alice", "Eve")}
    db.add_all(users.values())
    await db.flush()
    hu = {n: u.human_id for n, u in users.items()}
    db.add_all([
        Agent(agent_id="ag_barry", display_name="Barry", user_id=users["Danny"].id, claimed_at=now,
              contact_policy=ContactPolicy.open),
        Agent(agent_id="ag_rex", display_name="Rex", user_id=users["Alice"].id, claimed_at=now),
    ])
    await db.flush()
    acme = await spaces.create_organization(db, users["Danny"].id, "acme", "Acme")
    await spaces.invite_user(db, acme.space_id, users["Danny"].id, users["Alice"].id)
    await spaces.accept_invitation(db, acme.space_id, users["Alice"].id)
    await spaces.request_agent_admission(db, acme.space_id, users["Danny"].id, "ag_barry")
    await spaces.approve_agent(db, acme.space_id, users["Danny"].id, "ag_barry")
    alice_m = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == acme.space_id, SpaceUserMembership.user_id == users["Alice"].id))
    barry_m = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == acme.space_id, SpaceAgentMembership.agent_id == "ag_barry"))
    db.add(AgentAccessGrant(
        space_id=acme.space_id, agent_id="ag_barry", agent_membership_id=barry_m.id,
        agent_membership_version=barry_m.version, grantee_user_id=users["Alice"].id,
        grantee_membership_id=alice_m.id, grantee_membership_version=alice_m.version,
        role="collaborator", workspace_path="/repo", created_by_user_id=users["Danny"].id,
    ))
    db.add_all([
        # Barry lists Alice and Alice lists Barry: mutual contacts.
        Contact(owner_id="ag_barry", owner_type=A, contact_agent_id=hu["Alice"], peer_type=H, alias="PM"),
        Contact(owner_id=hu["Alice"], owner_type=H, contact_agent_id="ag_barry", peer_type=A),
        ContactRequest(from_agent_id=hu["Eve"], from_type=H, to_agent_id="ag_rex", to_type=A,
                       state=ContactRequestState.pending, message="hi"),
        Block(owner_id="ag_rex", owner_type=A, blocked_agent_id=hu["Eve"], blocked_type=H),
        Room(room_id="rm_dev", name="dev", owner_id=hu["Danny"], owner_type=H),
    ])
    await db.flush()
    db.add_all([
        RoomMember(room_id="rm_dev", agent_id=hu["Danny"], participant_type=H, role=RoomRole.owner),
        RoomMember(room_id="rm_dev", agent_id="ag_barry", participant_type=A, role=RoomRole.member),
    ])
    await db.commit()
    org_pid = await db.scalar(select(Organization.principal_id).where(Organization.space_id == acme.space_id))
    return {"users": users, "hu": hu, "acme": acme, "org": org_pid}


async def live(db, **filters):
    q = select(AccessEdge).where(AccessEdge.status.in_(("pending", "active")))
    for k, v in filters.items():
        q = q.where(getattr(AccessEdge, k) == v)
    return list((await db.scalars(q)).all())


@pytest.mark.asyncio
async def test_projection_covers_every_relation(db, world):
    hu, org = world["hu"], world["org"]
    assert org.startswith("og_")
    await sync_access_graph(db)
    await db.commit()

    kinds = {p.id: p.kind for p in (await db.scalars(select(AccessPrincipal))).all()}
    assert kinds[PUBLIC_PRINCIPAL_ID] == "public" and kinds[org] == "organization"
    assert kinds[hu["Alice"]] == "user" and kinds["ag_barry"] == "agent"

    [own] = await live(db, kind="ownership", to_id="ag_barry")
    assert (own.from_id, own.from_kind) == (hu["Danny"], "user")

    members = {(e.from_id, e.role) for e in await live(db, kind="membership", to_id=org)}
    assert members == {(hu["Danny"], "owner"), (hu["Alice"], "member"), ("ag_barry", "participant")}

    [grant] = await live(db, kind="grant")
    assert (grant.from_id, grant.to_id, grant.role, grant.scope_org_id) == (hu["Alice"], "ag_barry", "collaborator", org)
    assert grant.terms["workspace_path"] == "/repo"
    deps = (await db.scalars(select(AccessEdgeDep).where(AccessEdgeDep.edge_id == grant.id))).all()
    dep_sources = {(await db.get(AccessEdge, d.depends_on_edge_id)).source.split(":")[0] for d in deps}
    assert dep_sources == {"space_user_membership", "space_agent_membership"}

    [offer] = await live(db, kind="offer")
    assert (offer.from_id, offer.to_id, offer.role) == (PUBLIC_PRINCIPAL_ID, "ag_barry", "consult")
    assert offer.terms["direct"] is True and offer.issued_by == hu["Danny"]

    # Contact "Barry lists Alice" = Barry accepted Alice -> edge Alice -> Barry, issued by Barry.
    conns = {(e.from_id, e.to_id, e.status, e.issued_by) for e in await live(db, kind="connection")}
    assert conns == {
        (hu["Alice"], "ag_barry", "active", "ag_barry"),
        ("ag_barry", hu["Alice"], "active", hu["Alice"]),
        (hu["Eve"], "ag_rex", "pending", hu["Eve"]),
    }
    assert all(e.role == "consult" for e in await live(db, kind="connection"))

    [block] = await live(db, kind="block")
    assert (block.from_id, block.to_id) == ("ag_rex", hu["Eve"])

    room = {(e.from_id, e.to_kind, e.role) for e in await live(db, kind="member", to_id="rm_dev")}
    assert room == {(hu["Danny"], "conversation", "owner"), ("ag_barry", "conversation", "member")}

    created = (await db.scalars(select(AccessEdgeEvent).where(AccessEdgeEvent.event == "created"))).all()
    assert len(created) == len(await live(db))


@pytest.mark.asyncio
async def test_second_run_is_a_no_op(db, world):
    await sync_access_graph(db)
    await db.commit()
    stats = await sync_access_graph(db)
    assert not stats.changed(), stats


@pytest.mark.asyncio
async def test_legacy_changes_flow_into_edges(db, world):
    hu, users = world["hu"], world["users"]
    await sync_access_graph(db)
    await db.commit()

    # Removing Alice from Acme bumps her membership version and revokes it.
    await spaces.remove_user(db, world["acme"].space_id, users["Danny"].id, users["Alice"].id)
    # Deleting a contact row revokes its edge; closing Barry withdraws the offer.
    await db.execute(delete(Contact).where(Contact.owner_id == "ag_barry"))
    barry = await db.scalar(select(Agent).where(Agent.agent_id == "ag_barry"))
    barry.contact_policy = ContactPolicy.contacts_only
    await db.commit()

    stats = await sync_access_graph(db)
    await db.commit()
    assert stats.edges_revoked >= 2 and stats.edges_updated >= 1

    [membership] = (await db.scalars(select(AccessEdge).where(
        AccessEdge.kind == "membership", AccessEdge.from_id == hu["Alice"]))).all()
    legacy = await db.scalar(select(SpaceUserMembership).where(SpaceUserMembership.user_id == users["Alice"].id,
                                                               SpaceUserMembership.space_id == world["acme"].space_id))
    assert membership.status == "revoked" and membership.version == legacy.version
    assert not await live(db, kind="connection", from_id=hu["Alice"])
    assert not await live(db, kind="offer")
    revoked = (await db.scalars(select(AccessEdgeEvent).where(AccessEdgeEvent.event == "revoked"))).all()
    assert revoked and all(e.before is not None for e in revoked)

    # Re-adding the contact creates a fresh live edge next to the revoked one.
    db.add(Contact(owner_id="ag_barry", owner_type=A, contact_agent_id=hu["Alice"], peer_type=H))
    await db.commit()
    await sync_access_graph(db)
    await db.commit()
    assert len(await live(db, kind="connection", from_id=hu["Alice"])) == 1


@pytest.mark.asyncio
async def test_pending_request_skipped_once_accepted(db, world):
    hu = world["hu"]
    db.add(Contact(owner_id="ag_rex", owner_type=A, contact_agent_id=hu["Eve"], peer_type=H))
    await db.commit()
    stats = await sync_access_graph(db)
    [edge] = await live(db, kind="connection", from_id=hu["Eve"], to_id="ag_rex")
    assert edge.status == "active" and edge.source.startswith("contact:")
    assert not stats.skipped.get("connection:duplicate")

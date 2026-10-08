"""Ownership / membership / grant edges stay current inside the writing transaction (PR 3)."""

import datetime

import pytest
from sqlalchemy import select, update

from hub.models import AccessEdge, Agent, AgentAccessGrant, AgentOwnership, Space, User
from hub.services import agent_access, spaces
from hub.services.access_graph_hooks import WRITE_THROUGH_KINDS
from hub.services.access_graph_sync import sync_access_graph
from tests.test_app.test_access_graph_sync import db, world  # noqa: F401 — shared fixtures


async def grant_row(db):  # noqa: F811
    return await db.scalar(select(AgentAccessGrant))


async def assert_projection_current(db):  # noqa: F811
    stats = await sync_access_graph(db, kinds=WRITE_THROUGH_KINDS)
    assert not stats.changed(), stats
    await db.commit()


@pytest.mark.asyncio
async def test_service_writes_leave_no_projection_work(db, world):  # noqa: F811
    users, acme = world["users"], world["acme"]
    await assert_projection_current(db)
    grant = await grant_row(db)
    assert await agent_access.grant_is_valid(db, grant)

    await agent_access.revoke_grant(db, acme.space_id, users["Danny"].id, grant.id)
    await db.commit()
    await assert_projection_current(db)
    assert not await agent_access.grant_is_valid(db, grant)

    await spaces.remove_agent(db, acme.space_id, users["Danny"].id, "ag_barry")
    await spaces.remove_user(db, acme.space_id, users["Danny"].id, users["Alice"].id)
    await db.commit()
    await assert_projection_current(db)


@pytest.mark.asyncio
async def test_bulk_revocation_is_immediate(db, world):  # noqa: F811
    grant = await grant_row(db)
    await db.execute(update(AgentAccessGrant).values(revoked_at=datetime.datetime.now(datetime.timezone.utc)))
    await db.commit()
    edge = await db.scalar(select(AccessEdge).where(AccessEdge.source == f"agent_access_grant:{grant.id}"))
    assert edge.status == "revoked"
    assert not await agent_access.grant_is_valid(db, grant)


@pytest.mark.asyncio
async def test_read_your_writes_before_commit(db, world):  # noqa: F811
    users, acme = world["users"], world["acme"]
    grant = await grant_row(db)
    await agent_access.revoke_grant(db, acme.space_id, users["Danny"].id, grant.id)
    # Same transaction, not committed yet.
    assert not await agent_access.grant_is_valid(db, grant)
    await db.rollback()
    grant = await grant_row(db)
    assert grant.revoked_at is None and await agent_access.grant_is_valid(db, grant)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["owner_changed", "grantee_banned", "org_suspended"])
async def test_grant_needs_owner_active_parties(db, world, change):  # noqa: F811
    users, acme = world["users"], world["acme"]
    grant = await grant_row(db)
    if change == "owner_changed":
        barry = await db.scalar(select(Agent).where(Agent.agent_id == "ag_barry"))
        barry.user_id = users["Eve"].id
        ownership = await db.get(AgentOwnership, "ag_barry")
        ownership.owner_user_id = users["Eve"].id
    elif change == "grantee_banned":
        alice = await db.get(User, users["Alice"].id)
        alice.banned_at = datetime.datetime.now(datetime.timezone.utc)
    else:
        space = await db.get(Space, acme.space_id)
        space.status = "suspended"
    await db.commit()
    assert not await agent_access.grant_is_valid(db, grant)

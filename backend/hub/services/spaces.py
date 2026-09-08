"""Space identity lifecycle. Membership is not task or resource authorization.

Callers commit once after a successful operation. Organization mutations lock
the space row, so admission, removal and policy updates share one lock order.
"""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import (
    Agent, AgentOwnership, Organization, OrganizationPolicy, PersonalSpace,
    Space, SpaceAgentMembership, SpaceAgentProfile, SpaceAuditEvent,
    SpaceRoleBinding, SpaceUserMembership, User,
)


def reject(code: str, status: int = 403):
    raise HTTPException(status_code=status, detail=code)


def audit(db, space_id, actor_id, action, resource_id, **details):
    db.add(SpaceAuditEvent(
        space_id=space_id, actor_user_id=actor_id, action=action,
        resource_id=str(resource_id), details=details,
    ))


async def active_user(db: AsyncSession, user_id: UUID, *, lock=False) -> User:
    query = select(User).where(User.id == user_id)
    if lock:
        query = query.with_for_update()
    user = await db.scalar(query.execution_options(populate_existing=True))
    if user is None or user.status != "active" or user.banned_at is not None:
        reject("user_not_active")
    return user


async def ensure_personal_space(db: AsyncSession, user_id: UUID) -> Space:
    # Serialize lazy initialization and backfill on the stable user row.
    await active_user(db, user_id, lock=True)
    personal = await db.scalar(select(PersonalSpace).where(PersonalSpace.user_id == user_id))
    if personal:
        return await db.get(Space, personal.space_id)
    space = Space(kind="personal")
    db.add(space)
    await db.flush()
    db.add(PersonalSpace(space_id=space.id, user_id=user_id))
    membership = SpaceUserMembership(space_id=space.id, user_id=user_id)
    db.add(membership)
    await db.flush()
    db.add(SpaceRoleBinding(space_id=space.id, user_membership_id=membership.id, role_key="owner"))
    audit(db, space.id, user_id, "personal_space.created", space.id)
    return space


async def organization_space(db, space_id):
    space = await db.scalar(select(Space).where(Space.id == space_id).with_for_update()
                            .execution_options(populate_existing=True))
    if space is None or space.kind != "organization" or space.status != "active":
        reject("space_not_available", 404)
    return space


async def require_membership(db, space_id, user_id):
    await active_user(db, user_id)
    membership = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == space_id, SpaceUserMembership.user_id == user_id,
    ).execution_options(populate_existing=True))
    space = await db.get(Space, space_id, populate_existing=True)
    if space is None or space.status != "active" or membership is None or membership.status != "active":
        reject("space_not_available", 404)
    return membership


async def roles_for(db, membership):
    return set((await db.scalars(select(SpaceRoleBinding.role_key).where(
        SpaceRoleBinding.space_id == membership.space_id,
        SpaceRoleBinding.user_membership_id == membership.id,
    ))).all())


async def require_manager(db, space_id, user_id, *, owner_only=False):
    membership = await require_membership(db, space_id, user_id)
    allowed = {"owner"} if owner_only else {"owner", "admin"}
    if not (await roles_for(db, membership)) & allowed:
        reject("organization_role_required")
    return membership


async def create_organization(db, user_id, slug, name):
    await ensure_personal_space(db, user_id)
    space = Space(kind="organization")
    db.add(space)
    await db.flush()
    org = Organization(space_id=space.id, slug=slug, name=name)
    membership = SpaceUserMembership(space_id=space.id, user_id=user_id)
    db.add_all([org, membership])
    await db.flush()
    db.add_all([
        OrganizationPolicy(organization_id=org.id),
        SpaceRoleBinding(space_id=space.id, user_membership_id=membership.id, role_key="owner"),
    ])
    audit(db, space.id, user_id, "organization.created", org.id)
    return org


async def invite_user(db, space_id, actor_id, target_id):
    await organization_space(db, space_id)
    await require_manager(db, space_id, actor_id)
    await active_user(db, target_id)
    membership = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == space_id, SpaceUserMembership.user_id == target_id,
    ))
    if membership is None:
        membership = SpaceUserMembership(space_id=space_id, user_id=target_id, status="invited")
        db.add(membership)
        await db.flush()
    elif membership.status in {"active", "invited"}:
        return membership
    else:
        membership.status = "invited"
        membership.version += 1
        await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.user_membership_id == membership.id))
    audit(db, space_id, actor_id, "membership.invited", membership.id, version=membership.version)
    return membership


async def accept_invitation(db, space_id, user_id):
    await organization_space(db, space_id)
    await active_user(db, user_id)
    membership = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == space_id, SpaceUserMembership.user_id == user_id,
    ))
    if membership is None or membership.status not in {"invited", "active"}:
        reject("invitation_not_found", 404)
    if membership.status == "active":
        return membership
    membership.status = "active"
    membership.version += 1
    db.add(SpaceRoleBinding(space_id=space_id, user_membership_id=membership.id, role_key="member"))
    audit(db, space_id, user_id, "membership.accepted", membership.id, version=membership.version)
    return membership


async def remove_user(db, space_id, actor_id, target_id):
    await organization_space(db, space_id)
    if actor_id == target_id:
        await require_membership(db, space_id, actor_id)
    else:
        await require_manager(db, space_id, actor_id)
    target = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == space_id, SpaceUserMembership.user_id == target_id,
    ))
    if target is None:
        reject("membership_not_found", 404)
    target_roles = await roles_for(db, target)
    if "owner" in target_roles:
        # No ownership transfer API in this first foundation slice.
        reject("organization_owner_cannot_be_removed")
    if "admin" in target_roles and actor_id != target_id:
        await require_manager(db, space_id, actor_id, owner_only=True)
    if target.status == "removed":
        return
    target.status = "removed"
    target.version += 1
    await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.user_membership_id == target.id))
    agents = (await db.scalars(select(SpaceAgentMembership).where(
        SpaceAgentMembership.sponsor_user_membership_id == target.id,
        SpaceAgentMembership.status != "removed",
    ))).all()
    for membership in agents:
        membership.status = "removed"
        membership.version += 1
        await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.agent_membership_id == membership.id))
        audit(db, space_id, actor_id, "agent_membership.removed", membership.id, version=membership.version)
    audit(db, space_id, actor_id, "membership.removed", target.id, version=target.version)


async def register_personal_agent(db, user_id, agent_id):
    personal = await ensure_personal_space(db, user_id)
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id).with_for_update()
                            .execution_options(populate_existing=True))
    if agent is None or agent.user_id != user_id or not agent.is_active or agent.claimed_at is None:
        reject("owned_agent_required")
    ownership = await db.get(AgentOwnership, agent_id)
    if ownership and (ownership.owner_user_id != user_id or ownership.owner_organization_id is not None):
        reject("agent_ownership_conflict", 409)
    if ownership is None:
        db.add(AgentOwnership(agent_id=agent_id, owner_user_id=user_id))
    sponsor = await require_membership(db, personal.id, user_id)
    membership = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == personal.id, SpaceAgentMembership.agent_id == agent_id,
    ))
    if membership is None:
        membership = SpaceAgentMembership(space_id=personal.id, agent_id=agent_id,
            sponsor_user_membership_id=sponsor.id, sponsor_version=sponsor.version, status="active")
        db.add(membership)
        await db.flush()
        db.add_all([
            SpaceAgentProfile(membership_id=membership.id, display_name=agent.display_name),
            SpaceRoleBinding(space_id=personal.id, agent_membership_id=membership.id, role_key="participant"),
        ])
    return agent


async def request_agent_admission(db, space_id, user_id, agent_id):
    await organization_space(db, space_id)
    sponsor = await require_membership(db, space_id, user_id)
    agent = await register_personal_agent(db, user_id, agent_id)
    membership = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == space_id, SpaceAgentMembership.agent_id == agent_id,
    ))
    if membership and membership.status in {"active", "invited"}:
        return membership
    if membership is None:
        membership = SpaceAgentMembership(space_id=space_id, agent_id=agent_id,
            sponsor_user_membership_id=sponsor.id, sponsor_version=sponsor.version)
        db.add(membership)
        await db.flush()
        db.add(SpaceAgentProfile(membership_id=membership.id, display_name=agent.display_name))
    else:
        membership.status = "invited"
        membership.version += 1
        membership.sponsor_user_membership_id = sponsor.id
        membership.sponsor_version = sponsor.version
        await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.agent_membership_id == membership.id))
    audit(db, space_id, user_id, "agent_membership.requested", membership.id, version=membership.version)
    return membership


async def require_agent_membership(db, space_id, agent_id, *, expected_version=None):
    membership = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == space_id, SpaceAgentMembership.agent_id == agent_id,
    ).execution_options(populate_existing=True))
    if membership is None or membership.status != "active":
        reject("agent_membership_required")
    if expected_version is not None and membership.version != expected_version:
        reject("membership_version_stale")
    sponsor = await db.get(SpaceUserMembership, membership.sponsor_user_membership_id, populate_existing=True)
    if sponsor is None or sponsor.version != membership.sponsor_version:
        reject("sponsor_not_active")
    await require_membership(db, space_id, sponsor.user_id)
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id).execution_options(populate_existing=True))
    ownership = await db.get(AgentOwnership, agent_id, populate_existing=True)
    if (agent is None or not agent.is_active or agent.claimed_at is None
            or agent.user_id != sponsor.user_id or ownership is None
            or ownership.owner_user_id != sponsor.user_id or ownership.owner_organization_id is not None):
        reject("owned_agent_required")
    return membership


async def approve_agent(db, space_id, actor_id, agent_id):
    await organization_space(db, space_id)
    await require_manager(db, space_id, actor_id)
    membership = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == space_id, SpaceAgentMembership.agent_id == agent_id,
    ))
    if membership is None or membership.status not in {"invited", "active"}:
        reject("agent_admission_not_found", 404)
    was_invited = membership.status == "invited"
    membership.status = "active"
    await db.flush()
    await require_agent_membership(db, space_id, agent_id)
    if was_invited:
        membership.version += 1
        db.add(SpaceRoleBinding(space_id=space_id, agent_membership_id=membership.id, role_key="participant"))
        audit(db, space_id, actor_id, "agent_membership.approved", membership.id, version=membership.version)
    return membership


async def remove_agent(db, space_id, actor_id, agent_id):
    await organization_space(db, space_id)
    actor = await require_membership(db, space_id, actor_id)
    membership = await db.scalar(select(SpaceAgentMembership).where(
        SpaceAgentMembership.space_id == space_id, SpaceAgentMembership.agent_id == agent_id,
    ))
    if membership is None:
        reject("agent_membership_not_found", 404)
    if membership.sponsor_user_membership_id != actor.id:
        await require_manager(db, space_id, actor_id)
    if membership.status != "removed":
        membership.status = "removed"
        membership.version += 1
        await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.agent_membership_id == membership.id))
        audit(db, space_id, actor_id, "agent_membership.removed", membership.id, version=membership.version)

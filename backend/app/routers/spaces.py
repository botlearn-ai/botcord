"""User-authenticated identity APIs; Agent execution remains unavailable."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent, Organization, OrganizationPolicy, Space, SpaceAgentMembership, SpaceAgentProfile, SpaceRoleBinding, SpaceUserMembership, User
from hub.services import spaces as service

router = APIRouter(prefix="/api", tags=["app-spaces"])


async def transaction(db: AsyncSession = Depends(get_db)):
    # Routes use function scope: commit must finish before sending success.
    try:
        yield db
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="space_identity_conflict")
    except Exception:
        await db.rollback()
        raise


class OrganizationIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=128)


class InviteIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    user_id: UUID | None = None
    human_id: str | None = Field(default=None, pattern=r"^hu_[a-zA-Z0-9]+$", max_length=32)

    @model_validator(mode="after")
    def exactly_one_identity(self):
        if (self.user_id is None) == (self.human_id is None):
            raise ValueError("Provide exactly one of user_id or human_id")
        return self


class PolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    admin_dm_content_access_enabled: bool
    external_communication_enabled: bool = False


def member_out(member):
    return {"id": member.id, "space_id": member.space_id, "status": member.status,
            "version": member.version}


@router.get("/spaces")
async def list_spaces(ctx: RequestContext = Depends(require_user), db: AsyncSession = Depends(transaction, scope="function")):
    await service.ensure_personal_space(db, ctx.user_id)
    rows = (await db.execute(select(Space, SpaceUserMembership, Organization, OrganizationPolicy)
        .join(SpaceUserMembership, SpaceUserMembership.space_id == Space.id)
        .outerjoin(Organization, Organization.space_id == Space.id)
        .outerjoin(OrganizationPolicy, OrganizationPolicy.organization_id == Organization.id)
        .where(SpaceUserMembership.user_id == ctx.user_id,
               SpaceUserMembership.status.in_(["active", "invited"]))
        .order_by(Space.kind, Space.id))).all()
    return {"spaces": [{
        "id": space.id, "kind": space.kind, "status": space.status,
        "membership": member_out(member), "roles": sorted(await service.roles_for(db, member)),
        "organization_id": org.id if org else None, "name": org.name if org else None,
        "policy_version": space.policy_version,
        "admin_dm_content_access_enabled": policy.admin_dm_content_access_enabled if policy else False,
        "external_communication_enabled": False,
        "organization_execution_available": False,
        "organization_messaging_available": space.kind == "organization",
        "agent_direct_admission_available": space.kind == "organization",
    } for space, member, org, policy in rows]}


@router.post("/organizations", status_code=201)
async def create_organization(body: OrganizationIn, ctx: RequestContext = Depends(require_user),
                              db: AsyncSession = Depends(transaction, scope="function")):
    org = await service.create_organization(db, ctx.user_id, body.slug, body.name)
    return {"id": org.id, "space_id": org.space_id, "slug": org.slug, "name": org.name}


@router.post("/spaces/{space_id}/invitations")
async def invite(space_id: UUID, body: InviteIn, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    # Authorize before resolving a public identity; this is not a user lookup API.
    await service.organization_space(db, space_id)
    await service.require_manager(db, space_id, ctx.user_id)
    target_id = body.user_id
    if body.human_id is not None:
        target_id = await db.scalar(select(User.id).where(User.human_id == body.human_id))
        if target_id is None:
            service.reject("invitation_user_not_found", 404)
    return member_out(await service.invite_user(db, space_id, ctx.user_id, target_id))


@router.post("/spaces/{space_id}/invitations/accept")
async def accept(space_id: UUID, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    return member_out(await service.accept_invitation(db, space_id, ctx.user_id))


@router.get("/spaces/{space_id}/members")
async def members(space_id: UUID, ctx: RequestContext = Depends(require_user),
                  db: AsyncSession = Depends(transaction, scope="function")):
    await service.require_membership(db, space_id, ctx.user_id)
    users = (await db.execute(select(SpaceUserMembership, User)
        .join(User, User.id == SpaceUserMembership.user_id)
        .where(SpaceUserMembership.space_id == space_id).order_by(User.display_name, User.id))).all()
    agents = (await db.execute(select(SpaceAgentMembership, Agent, SpaceAgentProfile)
        .join(Agent, Agent.agent_id == SpaceAgentMembership.agent_id)
        .outerjoin(SpaceAgentProfile, SpaceAgentProfile.membership_id == SpaceAgentMembership.id)
        .where(SpaceAgentMembership.space_id == space_id).order_by(Agent.display_name, Agent.agent_id))).all()
    role_rows = (await db.execute(select(SpaceRoleBinding.user_membership_id, SpaceRoleBinding.role_key)
        .where(SpaceRoleBinding.space_id == space_id, SpaceRoleBinding.user_membership_id.is_not(None)))).all()
    roles = {}
    for membership_id, role_key in role_rows:
        roles.setdefault(membership_id, []).append(role_key)
    return {"users": [dict(member_out(m), user_id=u.id, human_id=u.human_id,
                            display_name=u.display_name, roles=sorted(roles.get(m.id, []))) for m, u in users],
            "agents": [dict(member_out(m), agent_id=a.agent_id,
                             display_name=p.display_name if p else a.display_name,
                             sponsor_user_membership_id=m.sponsor_user_membership_id) for m, a, p in agents]}


@router.delete("/spaces/{space_id}/members/{user_id}", status_code=204)
async def remove_member(space_id: UUID, user_id: UUID, ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    await service.remove_user(db, space_id, ctx.user_id, user_id)
    return Response(status_code=204)


@router.post("/spaces/{space_id}/agents/{agent_id}/admission")
async def request_admission(space_id: UUID, agent_id: str, ctx: RequestContext = Depends(require_user),
                            db: AsyncSession = Depends(transaction, scope="function")):
    return member_out(await service.request_agent_admission(db, space_id, ctx.user_id, agent_id))


@router.post("/spaces/{space_id}/agents/{agent_id}/admission/add")
async def add_owned_agent(space_id: UUID, agent_id: str, ctx: RequestContext = Depends(require_user),
                          db: AsyncSession = Depends(transaction, scope="function")):
    # One UI action, one transaction, retaining both ownership and manager checks.
    await service.organization_space(db, space_id)
    await service.require_manager(db, space_id, ctx.user_id)
    await service.request_agent_admission(db, space_id, ctx.user_id, agent_id)
    return member_out(await service.approve_agent(db, space_id, ctx.user_id, agent_id))


@router.post("/spaces/{space_id}/agents/{agent_id}/admission/approve")
async def approve_admission(space_id: UUID, agent_id: str, ctx: RequestContext = Depends(require_user),
                            db: AsyncSession = Depends(transaction, scope="function")):
    return member_out(await service.approve_agent(db, space_id, ctx.user_id, agent_id))


@router.delete("/spaces/{space_id}/agents/{agent_id}", status_code=204)
async def remove_agent(space_id: UUID, agent_id: str, ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    await service.remove_agent(db, space_id, ctx.user_id, agent_id)
    return Response(status_code=204)


@router.patch("/organizations/{organization_id}/policies")
async def update_policy(organization_id: UUID, body: PolicyIn, ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    org = await db.get(Organization, organization_id)
    if org is None:
        service.reject("space_not_available", 404)
    space = await service.organization_space(db, org.space_id)
    await service.require_manager(db, space.id, ctx.user_id, owner_only=True)
    if body.external_communication_enabled:
        service.reject("cross_space_disabled")
    if body.expected_version != space.policy_version:
        service.reject("policy_version_stale", 409)
    policy = await db.get(OrganizationPolicy, org.id, populate_existing=True)
    previous = policy.admin_dm_content_access_enabled
    policy.admin_dm_content_access_enabled = body.admin_dm_content_access_enabled
    space.policy_version += 1
    service.audit(db, space.id, ctx.user_id, "organization.policy.updated", org.id,
                  previous_admin_dm_content_access_enabled=previous,
                  admin_dm_content_access_enabled=body.admin_dm_content_access_enabled,
                  policy_version=space.policy_version)
    return {"policy_version": space.policy_version,
            "admin_dm_content_access_enabled": policy.admin_dm_content_access_enabled,
            "external_communication_enabled": False,
            "content_audit_available": False}

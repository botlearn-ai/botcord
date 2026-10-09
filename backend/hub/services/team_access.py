"""Team-mode access views and access requests (docs/access-graph-model.md, team UI).

* ``agent_directory`` — every agent in the organization with what the caller
  may do with it (owner / grant role / none) and any pending request.
* Access requests — a member asks the agent's owner for consultant or
  collaborator access; approving creates a regular grant issued by the owner.
* ``room_agent_access`` — for each agent in an organization room: how far the
  caller's messages may make it act there and whether they wake it.
* ``agent_rooms`` — the owner's view of the organization rooms an agent sits in
  and its reply mode in each.
* ``access_overview`` — managers: every live grant and pending request.
"""

from __future__ import annotations

import datetime
import logging
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import (
    AccessEdge,
    Agent,
    AgentAccessGrant,
    AgentAccessRequest,
    AgentPresence,
    AgentRoomPolicyOverride,
    AgentSenderReplyRule,
    Room,
    RoomMember,
    SpaceAgentMembership,
    SpaceAgentProfile,
    SpaceUserMembership,
    User,
)
from hub.policy import _agent_default_attention, effective_attention_from, resolve_effective_attention
from hub.services import agent_access, spaces

_ROLE_RANK = {"consultant": 1, "collaborator": 2}

ACCESS_REQUEST_EVENT = "access_request_changed"

logger = logging.getLogger(__name__)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


async def _org_agents(db: AsyncSession, space_id: UUID) -> list[tuple[SpaceAgentMembership, Agent, str, UUID]]:
    """Active agent memberships with display name and owner (sponsor) user id."""
    rows = (await db.execute(
        select(SpaceAgentMembership, Agent, SpaceAgentProfile.display_name, SpaceUserMembership.user_id)
        .join(Agent, Agent.agent_id == SpaceAgentMembership.agent_id)
        .join(SpaceUserMembership, SpaceUserMembership.id == SpaceAgentMembership.sponsor_user_membership_id)
        .outerjoin(SpaceAgentProfile, SpaceAgentProfile.membership_id == SpaceAgentMembership.id)
        .where(SpaceAgentMembership.space_id == space_id, SpaceAgentMembership.status == "active",
               Agent.status == "active")
        .order_by(Agent.display_name, Agent.agent_id)
    )).all()
    return [(m, a, name or a.display_name, owner) for m, a, name, owner in rows]


async def _names(db: AsyncSession, user_ids: set[UUID]) -> dict[UUID, tuple[str, str]]:
    if not user_ids:
        return {}
    rows = await db.execute(select(User.id, User.display_name, User.human_id).where(User.id.in_(user_ids)))
    return {uid: (name, hu) for uid, name, hu in rows.all()}


async def _attention_mode(db: AsyncSession, agent: Agent, room_id: str | None) -> dict:
    eff = await resolve_effective_attention(db, agent=agent, room_id=room_id)
    mode = eff.mode.value if hasattr(eff.mode, "value") else str(eff.mode)
    return {"mode": mode, "keywords": list(eff.keywords), "source": eff.source}


async def agent_directory(db: AsyncSession, space_id: UUID, user_id: UUID) -> list[dict]:
    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, user_id)
    agents = await _org_agents(db, space_id)
    names = await _names(db, {owner for *_, owner in agents})
    pending = {r.agent_id: r for r in (await db.scalars(select(AgentAccessRequest).where(
        AgentAccessRequest.space_id == space_id, AgentAccessRequest.requester_user_id == user_id,
        AgentAccessRequest.status == "pending"))).all()}
    grants = await agent_access.active_grants_for_grantee(
        db, [a.agent_id for _, a, _, owner in agents if owner != user_id], user_id)
    agent_ids = [a.agent_id for _, a, _, _ in agents]
    owned = [a.agent_id for _, a, _, owner in agents if owner == user_id]
    presence = dict((await db.execute(select(AgentPresence.agent_id, AgentPresence.effective_status).where(
        AgentPresence.agent_id.in_(agent_ids)))).all()) if agent_ids else {}
    room_counts = dict((await db.execute(
        select(RoomMember.agent_id, func.count()).join(Room, Room.room_id == RoomMember.room_id)
        .where(RoomMember.agent_id.in_(agent_ids), Room.space_id == space_id)
        .group_by(RoomMember.agent_id))).all()) if agent_ids else {}
    pending_counts: dict[str, int] = {}
    grant_counts: dict[str, int] = {}
    if owned:
        pending_counts = dict((await db.execute(
            select(AgentAccessRequest.agent_id, func.count()).where(
                AgentAccessRequest.space_id == space_id, AgentAccessRequest.agent_id.in_(owned),
                AgentAccessRequest.status == "pending").group_by(AgentAccessRequest.agent_id))).all())
        live = list((await db.scalars(select(AgentAccessGrant).where(
            AgentAccessGrant.space_id == space_id, AgentAccessGrant.agent_id.in_(owned),
            AgentAccessGrant.revoked_at.is_(None)))).all())
        valid = await agent_access.valid_grant_ids(db, live)
        for g in live:
            if g.id in valid:
                grant_counts[g.agent_id] = grant_counts.get(g.agent_id, 0) + 1
    out = []
    for _membership, agent, display_name, owner_id in agents:
        if owner_id == user_id:
            access, grant_id = "owner", None
        else:
            grant = grants.get(agent.agent_id)
            access, grant_id = (grant.role, grant.id) if grant is not None else ("none", None)
        req = pending.get(agent.agent_id)
        out.append({
            "agent_id": agent.agent_id,
            "display_name": display_name,
            "owner_user_id": owner_id,
            "owner_name": names.get(owner_id, ("", ""))[0],
            "owner_human_id": names.get(owner_id, ("", ""))[1],
            "my_access": access,
            "grant_id": grant_id,
            "pending_request": {"id": req.id, "requested_role": req.requested_role} if req else None,
            "default_reply_mode": _agent_default_attention(agent).value,
            "avatar_url": agent.avatar_url,
            "runtime": agent.runtime,
            "hosting_kind": agent.hosting_kind,
            "status": presence.get(agent.agent_id, "offline"),
            "room_count": room_counts.get(agent.agent_id, 0),
            # Owner-only usage numbers (None for agents the caller does not own).
            "grant_count": grant_counts.get(agent.agent_id, 0) if owner_id == user_id else None,
            "pending_request_count": pending_counts.get(agent.agent_id, 0) if owner_id == user_id else None,
        })
    return out


async def _owned_org_agent(db: AsyncSession, space_id: UUID, agent_id: str) -> UUID:
    """Return the owner (sponsor) user id of an active org agent."""
    membership = await spaces.require_agent_membership(db, space_id, agent_id)
    sponsor = await db.get(SpaceUserMembership, membership.sponsor_user_membership_id)
    return sponsor.user_id


async def request_access(db: AsyncSession, space_id: UUID, user_id: UUID, agent_id: str, role: str,
                         message: str | None) -> AgentAccessRequest:
    if role not in _ROLE_RANK:
        spaces.reject("invalid_role", 422)
    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, user_id)
    owner_id = await _owned_org_agent(db, space_id, agent_id)
    if owner_id == user_id:
        spaces.reject("cannot_request_own_agent", 422)
    grant = await agent_access.active_grant_for_pair(db, agent_id, user_id)
    if grant is not None and _ROLE_RANK[grant.role] >= _ROLE_RANK[role]:
        spaces.reject("access_already_granted", 409)
    existing = await db.scalar(select(AgentAccessRequest).where(
        AgentAccessRequest.space_id == space_id, AgentAccessRequest.agent_id == agent_id,
        AgentAccessRequest.requester_user_id == user_id, AgentAccessRequest.status == "pending"))
    if existing is not None:
        existing.requested_role, existing.message = role, message
        return existing
    req = AgentAccessRequest(space_id=space_id, agent_id=agent_id, requester_user_id=user_id,
                             requested_role=role, message=message)
    db.add(req)
    await db.flush()
    spaces.audit(db, space_id, user_id, "agent_access.requested", req.id, agent_id=agent_id, role=role)
    return req


async def list_requests(db: AsyncSession, space_id: UUID, user_id: UUID, *, status: str | None = "pending") -> dict:
    """Requests the caller must decide (agents they own) and the caller's own requests."""
    await spaces.require_membership(db, space_id, user_id)
    owned = {a.agent_id for _, a, _, owner in await _org_agents(db, space_id) if owner == user_id}
    q = select(AgentAccessRequest).where(AgentAccessRequest.space_id == space_id)
    if status:
        q = q.where(AgentAccessRequest.status == status)
    rows = (await db.scalars(q.order_by(AgentAccessRequest.created_at.desc()))).all()
    names = await _names(db, {r.requester_user_id for r in rows})
    agent_names = {a.agent_id: name for _, a, name, _ in await _org_agents(db, space_id)}
    def out(r):
        name, hu = names.get(r.requester_user_id, ("", ""))
        return {"id": r.id, "agent_id": r.agent_id, "agent_name": agent_names.get(r.agent_id, r.agent_id),
                "requester_user_id": r.requester_user_id,
                "requester_name": name, "requester_human_id": hu, "requested_role": r.requested_role,
                "message": r.message, "status": r.status, "grant_id": r.grant_id, "created_at": r.created_at,
                "decided_at": r.decided_at}
    return {"to_decide": [out(r) for r in rows if r.agent_id in owned],
            "mine": [out(r) for r in rows if r.requester_user_id == user_id]}


async def _pending_request(db: AsyncSession, space_id: UUID, request_id: UUID) -> AgentAccessRequest:
    req = await db.get(AgentAccessRequest, request_id)
    if req is None or req.space_id != space_id:
        spaces.reject("request_not_found", 404)
    if req.status != "pending":
        spaces.reject("request_not_pending", 409)
    return req


async def approve_request(db: AsyncSession, space_id: UUID, user_id: UUID, request_id: UUID, *,
                          role: str | None = None, workspace_path: str | None = None,
                          allowed_commands: list[str] | None = None,
                          expires_at: datetime.datetime | None = None) -> tuple[AgentAccessRequest, AgentAccessGrant]:
    req = await _pending_request(db, space_id, request_id)
    if await _owned_org_agent(db, space_id, req.agent_id) != user_id:
        spaces.reject("agent_owner_required")
    grant = await agent_access.create_grant(
        db, space_id, user_id, req.agent_id, req.requester_user_id, role or req.requested_role,
        expires_at=expires_at, workspace_path=workspace_path, allowed_commands=allowed_commands)
    req.status, req.decided_by_user_id, req.decided_at, req.grant_id = "approved", user_id, _now(), grant.id
    return req, grant


async def reject_request(db: AsyncSession, space_id: UUID, user_id: UUID, request_id: UUID) -> AgentAccessRequest:
    req = await _pending_request(db, space_id, request_id)
    if await _owned_org_agent(db, space_id, req.agent_id) != user_id:
        spaces.reject("agent_owner_required")
    req.status, req.decided_by_user_id, req.decided_at = "rejected", user_id, _now()
    spaces.audit(db, space_id, user_id, "agent_access.request_rejected", req.id, agent_id=req.agent_id)
    return req


async def cancel_request(db: AsyncSession, space_id: UUID, user_id: UUID, request_id: UUID) -> AgentAccessRequest:
    req = await _pending_request(db, space_id, request_id)
    if req.requester_user_id != user_id:
        spaces.reject("request_not_found", 404)
    req.status, req.decided_at = "cancelled", _now()
    return req


async def access_request_events(db: AsyncSession, req: AgentAccessRequest) -> list[dict]:
    """Realtime hints for a created / updated / decided request.

    Recipients: the agent's owner and the requester, on their ``human:<hu_id>``
    channels. The payload only says *which* request changed; clients refetch
    through the authorized endpoints, so nothing about the request leaks.
    """
    from hub.routers.hub import build_agent_realtime_event

    owner = (select(SpaceUserMembership.user_id)
             .join(SpaceAgentMembership, SpaceAgentMembership.sponsor_user_membership_id == SpaceUserMembership.id)
             .where(SpaceAgentMembership.space_id == req.space_id, SpaceAgentMembership.agent_id == req.agent_id))
    human_ids = set((await db.scalars(select(User.human_id).where(
        User.id.in_(owner) | (User.id == req.requester_user_id)))).all())
    ext = {"space_id": str(req.space_id), "request_id": str(req.id), "status": req.status}
    return [build_agent_realtime_event(type=ACCESS_REQUEST_EVENT, agent_id=hu, ext=dict(ext))
            for hu in sorted(h for h in human_ids if h)]


async def publish_realtime_events(events: list[dict]) -> None:
    """Send events on a fresh session; run after the request transaction committed."""
    if not events:
        return
    from hub.database import async_session
    from hub.routers import hub as hub_router

    try:
        async with async_session() as db:
            for event in events:
                await hub_router._publish_agent_realtime_event(db, event)
    except Exception:  # notification must never surface as a request error
        logger.exception("access request realtime publish failed")


async def room_agent_access(db: AsyncSession, space_id: UUID, room_id: str, user_id: UUID) -> list[dict]:
    """What the caller's messages can make each agent in this org room do."""
    from hub.services.access_inbox import _attention_for

    await spaces.require_membership(db, space_id, user_id)
    room = await db.scalar(select(Room).where(Room.room_id == room_id, Room.space_id == space_id))
    if room is None:
        spaces.reject("room_not_found", 404)
    me = await db.scalar(select(User.human_id).where(User.id == user_id))
    is_member = await db.scalar(select(RoomMember.id).where(RoomMember.room_id == room_id, RoomMember.agent_id == me))
    if is_member is None and room.space_visibility != "organization":
        spaces.reject("room_not_found", 404)
    agent_ids = (await db.scalars(select(RoomMember.agent_id).where(
        RoomMember.room_id == room_id, RoomMember.agent_id.like("ag_%")))).all()
    org_agents = await _org_agents(db, space_id)
    owners = {a.agent_id: owner for _, a, _, owner in org_agents}
    org_names = {a.agent_id: name for _, a, name, _ in org_agents}
    agents = (await db.scalars(select(Agent).where(Agent.agent_id.in_(agent_ids)))).all()
    ids = [a.agent_id for a in agents]
    grants = await agent_access.active_grants_for_grantee(
        db, [a.agent_id for a in agents if not (owners.get(a.agent_id) == user_id or a.user_id == user_id)], user_id)
    room_caps: dict[str, str | None] = {}
    for from_id, cap in (await db.execute(select(AccessEdge.from_id, AccessEdge.capability).where(
            AccessEdge.kind == "member", AccessEdge.status == "active",
            AccessEdge.from_id.in_(ids), AccessEdge.to_id == room_id))).all():
        room_caps.setdefault(from_id, cap)
    overrides = {o.agent_id: o for o in (await db.scalars(select(AgentRoomPolicyOverride).where(
        AgentRoomPolicyOverride.agent_id.in_(ids), AgentRoomPolicyOverride.room_id == room_id))).all()}
    rules_by_agent: dict[str, dict] = {}
    for r in (await db.scalars(select(AgentSenderReplyRule).where(
            AgentSenderReplyRule.agent_id.in_(ids), AgentSenderReplyRule.sender_id == me))).all():
        rules_by_agent.setdefault(r.agent_id, {})[(r.sender_id, r.room_scope)] = r
    out = []
    for agent in agents:
        if owners.get(agent.agent_id) == user_id or agent.user_id == user_id:
            capability, basis = "full", "owner"
        elif (grant := grants.get(agent.agent_id)) is not None:
            capability, basis = ("collaborator" if grant.role == "collaborator" else "consult"), "grant"
        else:
            capability, basis = (room_caps.get(agent.agent_id) or "consult"), "room"
        # Pre-filled cache: _attention_for then needs no queries.
        cache = {room_id: effective_attention_from(agent, room_id, overrides.get(agent.agent_id))}
        eff = await _attention_for(db, agent, room_id, me, rules_by_agent.get(agent.agent_id, {}), cache)
        mode = eff.mode.value if hasattr(eff.mode, "value") else str(eff.mode)
        out.append({"agent_id": agent.agent_id, "display_name": org_names.get(agent.agent_id, agent.display_name),
                    "my_capability": capability, "basis": basis,
                    "reply_mode": mode, "keywords": list(eff.keywords)})
    return out


async def agent_rooms(db: AsyncSession, space_id: UUID, agent_id: str, user_id: UUID) -> list[dict]:
    """Owner's view: org rooms the agent is in, its reply mode and per-sender rules there."""
    await spaces.require_membership(db, space_id, user_id)
    if await _owned_org_agent(db, space_id, agent_id) != user_id:
        spaces.reject("agent_owner_required")
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    rooms = (await db.execute(select(Room.room_id, Room.name, Room.space_kind).join(
        RoomMember, RoomMember.room_id == Room.room_id).where(
        RoomMember.agent_id == agent_id, Room.space_id == space_id).order_by(Room.name))).all()
    rules = (await db.scalars(select(AgentSenderReplyRule).where(AgentSenderReplyRule.agent_id == agent_id))).all()
    sender_names = dict((await db.execute(select(User.human_id, User.display_name).where(
        User.human_id.in_({r.sender_id for r in rules})))).all()) if rules else {}
    out = []
    for room_id, name, kind in rooms:
        att = await _attention_mode(db, agent, room_id)
        out.append({"room_id": room_id, "name": name, "kind": kind, "reply_mode": att["mode"],
                    "keywords": att["keywords"], "inherits_default": att["source"] == "global",
                    "sender_rules": [{"sender_id": r.sender_id, "sender_name": sender_names.get(r.sender_id),
                                      "attention_mode": r.attention_mode.value if hasattr(r.attention_mode, "value") else r.attention_mode}
                                     for r in rules if r.room_scope == room_id]})
    return out


async def access_overview(db: AsyncSession, space_id: UUID, user_id: UUID) -> dict:
    """Managers: live grants across org agents and pending requests."""
    await spaces.require_manager(db, space_id, user_id)
    agents = {a.agent_id: (name, owner) for _, a, name, owner in await _org_agents(db, space_id)}
    candidates = [g for g in (await db.scalars(select(AgentAccessGrant).where(
        AgentAccessGrant.space_id == space_id, AgentAccessGrant.revoked_at.is_(None)))).all()
        if g.agent_id in agents]
    valid = await agent_access.valid_grant_ids(db, candidates)
    grants = [g for g in candidates if g.id in valid]
    pending = (await db.scalars(select(AgentAccessRequest).where(
        AgentAccessRequest.space_id == space_id, AgentAccessRequest.status == "pending"))).all()
    names = await _names(db, {g.grantee_user_id for g in grants} | {o for _, o in agents.values()}
                         | {r.requester_user_id for r in pending})
    return {
        "grants": [{"grant_id": g.id, "agent_id": g.agent_id, "agent_name": agents[g.agent_id][0],
                    "owner_name": names.get(agents[g.agent_id][1], ("", ""))[0],
                    "grantee_name": names.get(g.grantee_user_id, ("", ""))[0],
                    "grantee_human_id": names.get(g.grantee_user_id, ("", ""))[1],
                    "role": g.role, "workspace_path": g.workspace_path, "expires_at": g.expires_at,
                    "created_at": g.created_at} for g in grants],
        "counts": {"collaborator": sum(g.role == "collaborator" for g in grants),
                   "consultant": sum(g.role == "consultant" for g in grants),
                   "pending_requests": len(pending)},
    }

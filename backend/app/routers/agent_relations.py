"""Owner controls for how non-owners may use an agent (docs/access-graph-model.md §4–§5, PR 4).

* Capability per relation: a friend (connection edge), a personal room the
  agent sits in (its member edge), or the public offer. Values: consult | full.
  Organization rooms stay 'consult'; organization members get access through
  grants instead.
* Per-sender reply rules: whether a given sender's messages wake the agent,
  in one room or in every room.
"""

import datetime
import json

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.spaces import transaction
from hub.enums import AttentionMode
from hub.models import PUBLIC_PRINCIPAL_ID, AccessEdge, AccessEdgeEvent, Agent, AgentSenderReplyRule, Room

router = APIRouter(prefix="/api/agents/{agent_id}", tags=["app-agent-relations"])


async def _owned_agent(db: AsyncSession, agent_id: str, ctx: RequestContext) -> Agent:
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    if agent is None or agent.status != "active" or agent.user_id != ctx.user_id:
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


def _edge_out(e: AccessEdge) -> dict:
    return {"edge_id": str(e.id), "kind": e.kind, "peer_id": e.from_id if e.kind == "connection" else e.to_id,
            "capability": e.capability or "consult", "status": e.status}


@router.get("/access/relations")
async def list_relations(agent_id: str, ctx: RequestContext = Depends(require_user),
                         db: AsyncSession = Depends(transaction, scope="function")):
    await _owned_agent(db, agent_id, ctx)
    edges = (await db.scalars(select(AccessEdge).where(AccessEdge.status == "active", (
        ((AccessEdge.kind == "connection") & (AccessEdge.to_id == agent_id))
        | ((AccessEdge.kind == "member") & (AccessEdge.from_id == agent_id))
        | ((AccessEdge.kind == "offer") & (AccessEdge.to_id == agent_id)))))).all()
    org_rooms = set((await db.scalars(select(Room.room_id).where(
        Room.room_id.in_([e.to_id for e in edges if e.kind == "member"]), Room.space_id.is_not(None)))).all())
    out = {"connections": [], "rooms": [], "public": None}
    for e in edges:
        if e.kind == "connection":
            out["connections"].append(_edge_out(e))
        elif e.kind == "member":
            out["rooms"].append({**_edge_out(e), "organization_room": e.to_id in org_rooms})
        else:
            out["public"] = _edge_out(e)
    return out


class CapabilityIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: str = Field(pattern=r"^(connection|room|public)$")
    target_id: str | None = Field(default=None, max_length=64)
    capability: str = Field(pattern=r"^(consult|full)$")


@router.patch("/access/capability")
async def set_capability(agent_id: str, body: CapabilityIn, ctx: RequestContext = Depends(require_user),
                         db: AsyncSession = Depends(transaction, scope="function")):
    """Raise or lower what non-owners may make the agent do through one relation."""
    agent = await _owned_agent(db, agent_id, ctx)
    if body.kind == "public":
        cond = [AccessEdge.kind == "offer", AccessEdge.from_id == PUBLIC_PRINCIPAL_ID, AccessEdge.to_id == agent_id]
    elif not body.target_id:
        raise HTTPException(status_code=422, detail="target_id_required")
    elif body.kind == "connection":
        cond = [AccessEdge.kind == "connection", AccessEdge.from_id == body.target_id, AccessEdge.to_id == agent_id]
    else:
        room = await db.scalar(select(Room).where(Room.room_id == body.target_id))
        if room is not None and room.space_id is not None:
            raise HTTPException(status_code=409, detail="organization_room_capability_fixed")
        cond = [AccessEdge.kind == "member", AccessEdge.from_id == agent_id, AccessEdge.to_id == body.target_id]
    edge = await db.scalar(select(AccessEdge).where(AccessEdge.status == "active", *cond))
    if edge is None:
        raise HTTPException(status_code=404, detail="relation_not_found")
    if (edge.capability or "consult") != body.capability:
        before = edge.capability
        edge.capability = body.capability
        db.add(AccessEdgeEvent(edge_id=edge.id, event="capability", actor_id=agent.user_id and str(agent.user_id),
                               version=edge.version, before={"capability": before},
                               after={"capability": body.capability}))
    return _edge_out(edge)


class ReplyRuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    sender_id: str = Field(pattern=r"^(ag|hu)_[A-Za-z0-9_]+$", max_length=32)
    room_id: str | None = Field(default=None, max_length=64)
    attention_mode: AttentionMode
    keywords: list[str] | None = Field(default=None, max_length=50)
    muted_until: datetime.datetime | None = None


def _rule_out(r: AgentSenderReplyRule) -> dict:
    return {"sender_id": r.sender_id, "room_id": r.room_scope or None,
            "attention_mode": r.attention_mode.value if hasattr(r.attention_mode, "value") else r.attention_mode,
            "keywords": json.loads(r.keywords) if r.keywords else None, "muted_until": r.muted_until}


@router.get("/reply-rules")
async def list_reply_rules(agent_id: str, ctx: RequestContext = Depends(require_user),
                           db: AsyncSession = Depends(transaction, scope="function")):
    await _owned_agent(db, agent_id, ctx)
    rows = (await db.scalars(select(AgentSenderReplyRule).where(AgentSenderReplyRule.agent_id == agent_id)
                             .order_by(AgentSenderReplyRule.id))).all()
    return {"rules": [_rule_out(r) for r in rows]}


@router.put("/reply-rules")
async def put_reply_rule(agent_id: str, body: ReplyRuleIn, ctx: RequestContext = Depends(require_user),
                         db: AsyncSession = Depends(transaction, scope="function")):
    """Upsert the rule for (sender, room); ``room_id`` omitted = every room."""
    await _owned_agent(db, agent_id, ctx)
    scope = body.room_id or ""
    rule = await db.scalar(select(AgentSenderReplyRule).where(
        AgentSenderReplyRule.agent_id == agent_id, AgentSenderReplyRule.sender_id == body.sender_id,
        AgentSenderReplyRule.room_scope == scope))
    if rule is None:
        rule = AgentSenderReplyRule(agent_id=agent_id, sender_id=body.sender_id, room_scope=scope,
                                    attention_mode=body.attention_mode)
        db.add(rule)
    rule.attention_mode = body.attention_mode
    rule.keywords = json.dumps(body.keywords) if body.keywords is not None else None
    rule.muted_until = body.muted_until
    await db.flush()
    return _rule_out(rule)


@router.delete("/reply-rules", status_code=204)
async def delete_reply_rule(agent_id: str, sender_id: str, room_id: str | None = None,
                            ctx: RequestContext = Depends(require_user),
                            db: AsyncSession = Depends(transaction, scope="function")):
    await _owned_agent(db, agent_id, ctx)
    rule = await db.scalar(select(AgentSenderReplyRule).where(
        AgentSenderReplyRule.agent_id == agent_id, AgentSenderReplyRule.sender_id == sender_id,
        AgentSenderReplyRule.room_scope == (room_id or "")))
    if rule is not None:
        await db.delete(rule)
    return Response(status_code=204)

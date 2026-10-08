"""Authorization over the access graph (docs/access-graph-model.md §4).

``decide_direct`` / ``decide_room_invite`` / ``decide_execution_many`` answer the
same questions the legacy checks answer, but only from ``access_edges`` plus a
few agent node attributes (the sender-class toggles). During the shadow phase
nothing acts on the result: ``hub.policy`` and ``poll_inbox`` call the
``shadow_*`` helpers, which compare against the legacy outcome and log one
``access_shadow`` line per disagreement. Shadow work runs in a SAVEPOINT and
never raises into the caller.
"""

from __future__ import annotations

import datetime
import json
import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.models import PUBLIC_PRINCIPAL_ID, AccessEdge, AccessEdgeDep, AccessPrincipal, Agent

logger = logging.getLogger("hub.access_shadow")

LIVE = "active"
_CAPABILITY_RANK = {"consult": 1, "collaborator": 2, "full": 3}


@dataclass
class Decision:
    allowed: bool
    reason: str
    # "full" | "collaborator" | "consult" | None (denied)
    capability: str | None = None
    path: list[dict] = field(default_factory=list)


def _aware(ts):
    if ts is not None and ts.tzinfo is None:
        return ts.replace(tzinfo=datetime.timezone.utc)
    return ts


def _hop(edge: AccessEdge) -> dict:
    return {"edge_id": str(edge.id), "kind": edge.kind, "version": edge.version}


async def _live_edges(db: AsyncSession, *conditions, now: datetime.datetime) -> list[AccessEdge]:
    """Active, unexpired edges whose dependencies are still live at the recorded version."""
    edges = list((await db.scalars(select(AccessEdge).where(AccessEdge.status == LIVE, *conditions))).all())
    edges = [e for e in edges if e.expires_at is None or _aware(e.expires_at) > now]
    if not edges:
        return edges
    deps = (await db.execute(
        select(AccessEdgeDep.edge_id, AccessEdge.status, AccessEdge.version, AccessEdgeDep.depends_on_version)
        .join(AccessEdge, AccessEdge.id == AccessEdgeDep.depends_on_edge_id)
        .where(AccessEdgeDep.edge_id.in_([e.id for e in edges]))
    )).all()
    broken = {d.edge_id for d in deps if d.status != LIVE or d.version != d.depends_on_version}
    return [e for e in edges if e.id not in broken]


async def valid_grants(db: AsyncSession, edges: list[AccessEdge], now) -> list[AccessEdge]:
    """Grant edges that are live *and* still backed by the agent's current owner.

    Beyond edge liveness and dependencies: the issuer must still own the agent,
    and the grantee, the agent and the scoping organization must be active.
    """
    edges = [e for e in edges if e.kind == "grant"]
    if not edges:
        return edges
    owners = {e.to_id: e.from_id for e in await _live_edges(
        db, AccessEdge.kind == "ownership", AccessEdge.to_id.in_({g.to_id for g in edges}), now=now)}
    ids = {x for g in edges for x in (g.from_id, g.to_id, g.scope_org_id) if x}
    active = set((await db.scalars(select(AccessPrincipal.id).where(
        AccessPrincipal.id.in_(ids), AccessPrincipal.status == "active"))).all())
    return [g for g in edges
            if g.issued_by and owners.get(g.to_id) == g.issued_by
            and g.from_id in active and g.to_id in active and (not g.scope_org_id or g.scope_org_id in active)]


async def grant_edge_valid(db: AsyncSession, edge: AccessEdge, now=None) -> bool:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    live = await _live_edges(db, AccessEdge.id == edge.id, now=now)
    return bool(await valid_grants(db, live, now))


async def _owner_of(db: AsyncSession, agent_id: str, now) -> AccessEdge | None:
    rows = await _live_edges(db, AccessEdge.kind == "ownership", AccessEdge.to_id == agent_id, now=now)
    return rows[0] if rows else None


async def _same_owner_path(db: AsyncSession, sender_id: str, agent_id: str, now) -> list[AccessEdge] | None:
    """Sender is the agent's owner, or another agent with the same owner."""
    own = await _owner_of(db, agent_id, now)
    if own is None:
        return None
    if own.from_id == sender_id:
        return [own]
    if sender_id.startswith("ag_"):
        sender_own = await _owner_of(db, sender_id, now)
        if sender_own is not None and sender_own.from_id == own.from_id:
            return [sender_own, own]
    return None


async def _blocked(db: AsyncSession, agent_id: str, sender_id: str, now) -> AccessEdge | None:
    rows = await _live_edges(db, AccessEdge.kind == "block", AccessEdge.from_id == agent_id,
                             AccessEdge.to_id == sender_id, now=now)
    return rows[0] if rows else None


async def _shared_conversation(db: AsyncSession, a: str, b: str) -> str | None:
    mine = select(AccessEdge.to_id).where(AccessEdge.kind == "member", AccessEdge.status == LIVE,
                                          AccessEdge.from_id == a)
    row = await db.scalar(select(AccessEdge.to_id).where(
        AccessEdge.kind == "member", AccessEdge.status == LIVE, AccessEdge.from_id == b,
        AccessEdge.to_id.in_(mine)).limit(1))
    return row


def _sender_class_allowed(agent: Agent, sender_id: str) -> str | None:
    """Agent node attribute: inbound filter by sender class (narrows only)."""
    if sender_id.startswith("ag_") and not getattr(agent, "allow_agent_sender", True):
        return "agent_senders_disabled"
    if sender_id.startswith("hu_") and not getattr(agent, "allow_human_sender", True):
        return "human_senders_disabled"
    return None


async def decide_direct(
    db: AsyncSession, *, sender_id: str, agent: Agent, contact_request: bool = False,
    now: datetime.datetime | None = None,
) -> Decision:
    """May ``sender_id`` message ``agent`` directly (DM / direct send)?"""
    from hub.services.access_graph_hooks import ensure_current

    await ensure_current(db)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if (blk := await _blocked(db, agent.agent_id, sender_id, now)) is not None:
        return Decision(False, "blocked", path=[_hop(blk)])
    if contact_request:
        return Decision(True, "contact_request", "consult")
    if (denied := _sender_class_allowed(agent, sender_id)) is not None:
        return Decision(False, denied)
    if (path := await _same_owner_path(db, sender_id, agent.agent_id, now)) is not None:
        return Decision(True, "ownership", "full", [_hop(e) for e in path])
    grants = await valid_grants(db, await _live_edges(
        db, AccessEdge.kind == "grant", AccessEdge.from_id == sender_id, AccessEdge.to_id == agent.agent_id, now=now), now)
    if grants:
        best = max(grants, key=lambda e: _CAPABILITY_RANK.get(e.role or "", 0))
        return Decision(True, "grant", best.role, [_hop(best)])
    conns = await _live_edges(db, AccessEdge.kind == "connection", AccessEdge.from_id == sender_id,
                              AccessEdge.to_id == agent.agent_id, now=now)
    if conns:
        return Decision(True, "connection", conns[0].role or "consult", [_hop(conns[0])])
    offers = await _live_edges(db, AccessEdge.kind == "offer", AccessEdge.from_id == PUBLIC_PRINCIPAL_ID,
                               AccessEdge.to_id == agent.agent_id, now=now)
    if offers and (offers[0].terms or {}).get("direct"):
        return Decision(True, "offer", offers[0].role or "consult", [_hop(offers[0])])
    if await _shared_conversation(db, sender_id, agent.agent_id):
        # By design a shared room does not open a DM (docs §4).
        return Decision(False, "room_only")
    return Decision(False, "no_path")


async def decide_room_invite(
    db: AsyncSession, *, inviter_id: str, agent: Agent, now: datetime.datetime | None = None,
) -> Decision:
    """May ``inviter_id`` pull ``agent`` into a conversation?"""
    from hub.services.access_graph_hooks import ensure_current

    await ensure_current(db)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if (blk := await _blocked(db, agent.agent_id, inviter_id, now)) is not None:
        return Decision(False, "blocked", path=[_hop(blk)])
    if (denied := _sender_class_allowed(agent, inviter_id)) is not None:
        return Decision(False, denied)
    if (path := await _same_owner_path(db, inviter_id, agent.agent_id, now)) is not None:
        return Decision(True, "ownership", "full", [_hop(e) for e in path])
    offers = await _live_edges(db, AccessEdge.kind == "offer", AccessEdge.from_id == PUBLIC_PRINCIPAL_ID,
                               AccessEdge.to_id == agent.agent_id, now=now)
    if offers and (offers[0].terms or {}).get("room_invite"):
        return Decision(True, "offer", "consult", [_hop(offers[0])])
    conns = await _live_edges(db, AccessEdge.kind == "connection", AccessEdge.from_id == inviter_id,
                              AccessEdge.to_id == agent.agent_id, now=now)
    if conns:
        return Decision(True, "connection", "consult", [_hop(conns[0])])
    return Decision(False, "no_path")


async def decide_execution_many(
    db: AsyncSession, *, agent_id: str, sender_ids: set[str], now: datetime.datetime | None = None,
) -> dict[str, Decision]:
    """Batch: how far may each sender's message make ``agent_id`` act (inbox)?

    Only the owner / same-owner and grant paths are resolved here — exactly the
    two signals the legacy inbox computes (``sender_same_owner``,
    ``access_context``). Other senders get ``Decision(False, "default")``.
    """
    from hub.services.access_graph_hooks import ensure_current

    await ensure_current(db)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    out: dict[str, Decision] = {}
    if not sender_ids:
        return out
    own = await _owner_of(db, agent_id, now)
    sender_agents = {s for s in sender_ids if s.startswith("ag_")}
    sender_owners: dict[str, AccessEdge] = {}
    if own is not None and sender_agents:
        for e in await _live_edges(db, AccessEdge.kind == "ownership", AccessEdge.to_id.in_(sender_agents), now=now):
            sender_owners[e.to_id] = e
    grants: dict[str, AccessEdge] = {}
    humans = {s for s in sender_ids if s.startswith("hu_")}
    if humans:
        for e in await valid_grants(db, await _live_edges(
                db, AccessEdge.kind == "grant", AccessEdge.to_id == agent_id, AccessEdge.from_id.in_(humans),
                now=now), now):
            best = grants.get(e.from_id)
            if best is None or _CAPABILITY_RANK.get(e.role or "", 0) > _CAPABILITY_RANK.get(best.role or "", 0):
                grants[e.from_id] = e
    for sid in sender_ids:
        if own is not None and own.from_id == sid:
            out[sid] = Decision(True, "ownership", "full", [_hop(own)])
        elif own is not None and sid in sender_owners and sender_owners[sid].from_id == own.from_id:
            out[sid] = Decision(True, "ownership", "full", [_hop(sender_owners[sid]), _hop(own)])
        elif sid in grants:
            out[sid] = Decision(True, "grant", grants[sid].role, [_hop(grants[sid])])
        else:
            out[sid] = Decision(False, "default")
    return out


# ---------------------------------------------------------------------------
# Shadow comparison
# ---------------------------------------------------------------------------

def _log_mismatch(check: str, **fields) -> None:
    from hub.services import access_graph_sync

    last = access_graph_sync.LAST_SYNC_AT
    # Relations created after the last sync are not in the graph yet; analysis
    # should discount mismatches with graph_age_s >= the sync interval.
    age = round((datetime.datetime.now(datetime.timezone.utc) - last).total_seconds(), 1) if last else None
    logger.info("access_shadow %s", json.dumps({"check": check, "graph_age_s": age, **fields},
                                               default=str, sort_keys=True))


def _classify(legacy_allowed: bool, legacy_reason: str, decision: Decision) -> str:
    if legacy_allowed and legacy_reason == "same_room" and decision.reason == "room_only":
        return "expected_room_bypass"
    return "unexpected"


async def shadow_direct(
    db: AsyncSession, *, sender_id: str, agent: Agent, contact_request: bool,
    legacy_allowed: bool, legacy_reason: str, entry: str,
) -> Decision | None:
    if not hub_config.ACCESS_DECIDE_SHADOW:
        return None
    try:
        async with db.begin_nested():
            decision = await decide_direct(db, sender_id=sender_id, agent=agent, contact_request=contact_request)
    except Exception:
        logger.warning("access_shadow direct failed", exc_info=True)
        return None
    if decision.allowed != legacy_allowed:
        _log_mismatch("direct", entry=entry, sender=sender_id, agent=agent.agent_id,
                      legacy={"allowed": legacy_allowed, "reason": legacy_reason},
                      graph={"allowed": decision.allowed, "reason": decision.reason},
                      kind=_classify(legacy_allowed, legacy_reason, decision))
    return decision


async def shadow_room_invite(
    db: AsyncSession, *, inviter_id: str, agent: Agent, legacy_allowed: bool, legacy_reason: str,
) -> Decision | None:
    if not hub_config.ACCESS_DECIDE_SHADOW:
        return None
    try:
        async with db.begin_nested():
            decision = await decide_room_invite(db, inviter_id=inviter_id, agent=agent)
    except Exception:
        logger.warning("access_shadow room_invite failed", exc_info=True)
        return None
    if decision.allowed != legacy_allowed:
        # Same-owner agents may pull each other into rooms (docs §4); legacy wants a contact.
        kind = ("expected_same_owner_invite"
                if not legacy_allowed and decision.reason == "ownership" else "unexpected")
        _log_mismatch("room_invite", inviter=inviter_id, agent=agent.agent_id,
                      legacy={"allowed": legacy_allowed, "reason": legacy_reason},
                      graph={"allowed": decision.allowed, "reason": decision.reason}, kind=kind)
    return decision


async def shadow_inbox(
    db: AsyncSession, *, agent_id: str, sender_ids: set[str],
    legacy_same_owner: set[str], legacy_access: dict[str, dict],
) -> dict[str, Decision] | None:
    """Compare the inbox's owner / grant signals with the graph."""
    if not hub_config.ACCESS_DECIDE_SHADOW or not sender_ids:
        return None
    try:
        async with db.begin_nested():
            decisions = await decide_execution_many(db, agent_id=agent_id, sender_ids=sender_ids)
    except Exception:
        logger.warning("access_shadow inbox failed", exc_info=True)
        return None
    for sid, d in decisions.items():
        legacy_owner = sid in legacy_same_owner
        ctx = legacy_access.get(sid)
        legacy_role = ctx.get("role") if ctx and ctx.get("active") else None
        graph_owner = d.reason == "ownership"
        graph_role = d.capability if d.reason == "grant" else None
        if legacy_owner != graph_owner or legacy_role != graph_role:
            _log_mismatch("inbox", agent=agent_id, sender=sid,
                          legacy={"same_owner": legacy_owner, "grant_role": legacy_role},
                          graph={"same_owner": graph_owner, "grant_role": graph_role}, kind="unexpected")
    return decisions

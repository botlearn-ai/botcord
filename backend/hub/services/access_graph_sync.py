"""Project legacy relation tables into the access graph (docs/access-graph-model.md §7).

During the migration window the legacy tables stay the source of truth and
every write path keeps writing them. ``sync_access_graph`` rebuilds the
expected principal + edge set from those tables and applies the difference to
``principals`` / ``access_edges`` / ``access_edge_deps``, recording each change
in ``access_edge_events``. It is idempotent: running it twice changes nothing.

Edges projected here carry ``source`` (``contact:12``) so a legacy row maps to
exactly one edge; when the row disappears or stops qualifying, its edge is
revoked rather than deleted.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.enums import ContactPolicy, ContactRequestState, ParticipantType, RoomInvitePolicy
from hub.models import (
    PUBLIC_PRINCIPAL_ID,
    AccessEdge,
    AccessEdgeDep,
    AccessEdgeEvent,
    AccessGraphSetting,
    AccessPrincipal,
    Agent,
    AgentAccessGrant,
    AgentManagementGrant,
    AgentOwnership,
    Block,
    Contact,
    ContactRequest,
    Organization,
    Room,
    RoomMember,
    Space,
    SpaceAgentMembership,
    SpaceRoleBinding,
    SpaceUserMembership,
    User,
)
from hub.policy import _effective_contact_policy, _effective_room_invite_policy
import hub.services.access_graph_hooks  # noqa: E402,F401 — registers write-through hooks

logger = logging.getLogger(__name__)

_ADVISORY_LOCK_KEY = 0x6163_6365_7373_6772  # "accessgr"
# When this process last finished a sync (shadow logs report the graph's age).
LAST_SYNC_AT: datetime.datetime | None = None
_MEMBERSHIP_STATUS = {"invited": "pending", "active": "active", "suspended": "revoked", "removed": "revoked"}
_ROLE_RANK = {"owner": 3, "admin": 2, "member": 1}
# Edge fields compared to decide whether a projected edge changed.
_FIELDS = ("kind", "from_id", "from_kind", "to_id", "to_kind", "scope_org_id", "role", "terms",
           "status", "issued_by", "expires_at", "revoked_at")


@dataclass
class _Edge:
    source: str
    kind: str
    from_id: str
    from_kind: str
    to_id: str
    to_kind: str
    scope_org_id: str = ""
    role: str | None = None
    terms: dict = field(default_factory=dict)
    status: str = "active"
    issued_by: str | None = None
    expires_at: datetime.datetime | None = None
    revoked_at: datetime.datetime | None = None
    # Legacy version to mirror; None = bump on every change.
    version: int | None = None
    # (source, version) of edges this edge depends on.
    deps: list[tuple[str, int]] = field(default_factory=list)
    # Initial capability; applied only when the edge is created.
    capability: str | None = None


@dataclass
class SyncStats:
    principals_added: int = 0
    principals_updated: int = 0
    edges_added: int = 0
    edges_updated: int = 0
    edges_revoked: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def changed(self) -> bool:
        return any((self.principals_added, self.principals_updated, self.edges_added,
                    self.edges_updated, self.edges_revoked))


def _participant_kind(value: ParticipantType | str) -> str:
    raw = value.value if isinstance(value, ParticipantType) else str(value)
    return "agent" if raw == ParticipantType.agent.value else "user"


def _aware(ts: datetime.datetime | None) -> datetime.datetime | None:
    if ts is not None and ts.tzinfo is None:
        return ts.replace(tzinfo=datetime.timezone.utc)
    return ts


LEGACY_FULL_BEFORE_KEY = "legacy_full_before"


async def legacy_full_before(db: AsyncSession) -> datetime.datetime | None:
    """Relations older than this keep full capability (set by migration 009)."""
    raw = await db.scalar(select(AccessGraphSetting.value).where(AccessGraphSetting.key == LEGACY_FULL_BEFORE_KEY))
    return _aware(datetime.datetime.fromisoformat(raw)) if raw else None


def _initial_capability(created_at, cutoff, default: str | None = None) -> str:
    """Pre-cutoff relations keep 'full'; newer ones start at the agent's default."""
    created_at = _aware(created_at)
    if cutoff is not None and created_at is not None and created_at < cutoff:
        return "full"
    return default if default in ("consult", "full") else "consult"


def _lifecycle(expires_at, revoked_at, now) -> str:
    if revoked_at is not None:
        return "revoked"
    if expires_at is not None and _aware(expires_at) <= now:
        return "expired"
    return "active"


async def _desired_principals(db: AsyncSession) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {
        PUBLIC_PRINCIPAL_ID: {"kind": "public", "display_name": "Anyone", "avatar_url": None, "status": "active"},
    }
    for u in (await db.execute(select(User.human_id, User.display_name, User.avatar_url, User.status,
                                      User.banned_at))).all():
        active = u.status == "active" and u.banned_at is None
        out[u.human_id] = {"kind": "user", "display_name": u.display_name or "", "avatar_url": u.avatar_url,
                           "status": "active" if active else "inactive"}
    for a in (await db.execute(select(Agent.agent_id, Agent.display_name, Agent.avatar_url, Agent.status))).all():
        out[a.agent_id] = {"kind": "agent", "display_name": a.display_name or "", "avatar_url": a.avatar_url,
                           "status": "active" if a.status == "active" else "inactive"}
    for o in (await db.execute(select(Organization.principal_id, Organization.name, Space.status)
                               .join(Space, Space.id == Organization.space_id))).all():
        out[o.principal_id] = {"kind": "organization", "display_name": o.name, "avatar_url": None,
                               "status": "active" if o.status == "active" else "inactive"}
    return out


async def _desired_edges(db: AsyncSession, now: datetime.datetime, kinds: set[str] | None = None) -> list[_Edge]:
    def want(kind: str) -> bool:
        return kinds is None or kind in kinds

    cutoff = await legacy_full_before(db)
    human_by_user = {r.id: r.human_id for r in (await db.execute(select(User.id, User.human_id))).all()}
    org_by_space = {r.space_id: r.principal_id
                    for r in (await db.execute(select(Organization.space_id, Organization.principal_id))).all()}
    org_by_id = {r.id: r.principal_id
                 for r in (await db.execute(select(Organization.id, Organization.principal_id))).all()}
    edges: list[_Edge] = []

    # ownership + offer
    owner_rows = {r.agent_id: r for r in (await db.scalars(select(AgentOwnership))).all()}
    for agent in (await db.scalars(select(Agent).where(Agent.status == "active"))).all():
        own = owner_rows.get(agent.agent_id)
        owner_id, owner_kind = None, "user"
        if own is not None and own.owner_organization_id is not None:
            owner_id, owner_kind = org_by_id.get(own.owner_organization_id), "organization"
        elif own is not None and own.owner_user_id is not None:
            owner_id = human_by_user.get(own.owner_user_id)
        elif agent.user_id is not None:
            owner_id = human_by_user.get(agent.user_id)
        if owner_id and want("ownership"):
            edges.append(_Edge(f"ownership:{agent.agent_id}", "ownership", owner_id, owner_kind,
                               agent.agent_id, "agent"))
        direct = _effective_contact_policy(agent) == ContactPolicy.open
        room_invite = _effective_room_invite_policy(agent) == RoomInvitePolicy.open
        if (direct or room_invite) and want("offer"):
            edges.append(_Edge(
                f"offer:{agent.agent_id}", "offer", PUBLIC_PRINCIPAL_ID, "public", agent.agent_id, "agent",
                role="consult", issued_by=owner_id,
                capability=_initial_capability(agent.created_at, cutoff, agent.non_owner_capability),
                terms={"direct": direct, "room_invite": room_invite, "price": 0,
                       "audience": {"human": bool(agent.allow_human_sender), "agent": bool(agent.allow_agent_sender)}},
            ))

    # organization memberships (personal spaces are not projected)
    if not want("membership"):
        return edges + await _desired_rest(db, now, kinds, human_by_user, org_by_space)
    roles: dict[Any, str] = {}
    for b in (await db.scalars(select(SpaceRoleBinding).where(SpaceRoleBinding.user_membership_id.is_not(None)))).all():
        if _ROLE_RANK.get(b.role_key, 0) > _ROLE_RANK.get(roles.get(b.user_membership_id, ""), 0):
            roles[b.user_membership_id] = b.role_key
    for m in (await db.scalars(select(SpaceUserMembership))).all():
        org = org_by_space.get(m.space_id)
        human = human_by_user.get(m.user_id)
        if org is None or human is None:
            continue
        edges.append(_Edge(
            f"space_user_membership:{m.id}", "membership", human, "user", org, "organization",
            role=roles.get(m.id, "member"), status=_MEMBERSHIP_STATUS.get(m.status, "revoked"),
            terms={"legacy_status": m.status} if m.status == "suspended" else {}, version=m.version,
        ))
    for m in (await db.scalars(select(SpaceAgentMembership))).all():
        org = org_by_space.get(m.space_id)
        if org is None:
            continue
        edges.append(_Edge(
            f"space_agent_membership:{m.id}", "membership", m.agent_id, "agent", org, "organization",
            role="participant", status=_MEMBERSHIP_STATUS.get(m.status, "revoked"), version=m.version,
            terms={"legacy_status": m.status} if m.status == "suspended" else {},
            deps=[(f"space_user_membership:{m.sponsor_user_membership_id}", m.sponsor_version)],
        ))

    return edges + await _desired_rest(db, now, kinds, human_by_user, org_by_space)


async def _desired_rest(db, now, kinds, human_by_user, org_by_space) -> list[_Edge]:
    def want(kind: str) -> bool:
        return kinds is None or kind in kinds

    cutoff = await legacy_full_before(db)
    agent_defaults = dict((await db.execute(select(Agent.agent_id, Agent.non_owner_capability))).all())

    edges: list[_Edge] = []
    # grants
    for g in (await db.scalars(select(AgentAccessGrant))).all() if want("grant") else ():
        grantee = human_by_user.get(g.grantee_user_id)
        if grantee is None:
            continue
        edges.append(_Edge(
            f"agent_access_grant:{g.id}", "grant", grantee, "user", g.agent_id, "agent",
            scope_org_id=org_by_space.get(g.space_id, ""), role=g.role,
            terms={"workspace_path": g.workspace_path, "allowed_commands": list(g.allowed_commands or [])},
            status=_lifecycle(g.expires_at, g.revoked_at, now),
            issued_by=human_by_user.get(g.created_by_user_id), expires_at=g.expires_at, revoked_at=g.revoked_at,
            deps=[(f"space_user_membership:{g.grantee_membership_id}", g.grantee_membership_version),
                  (f"space_agent_membership:{g.agent_membership_id}", g.agent_membership_version)],
        ))
    for g in (await db.scalars(select(AgentManagementGrant))).all() if want("manage") else ():
        user = human_by_user.get(g.user_id)
        if user is None:
            continue
        edges.append(_Edge(
            f"agent_management_grant:{g.id}", "manage", user, "user", g.agent_id, "agent", role=g.scope,
            terms={"daemon_instance_id": g.daemon_instance_id, "limits": g.limits_json or {}, "use_count": g.use_count},
            status=_lifecycle(g.expires_at, g.revoked_at, now),
            issued_by=human_by_user.get(g.created_by_user_id) if g.created_by_user_id else None,
            expires_at=g.expires_at, revoked_at=g.revoked_at,
        ))

    # connections: a Contact row "owner lists peer" means owner accepted peer -> edge peer -> owner.
    accepted_pairs: set[tuple[str, str]] = set()
    if not want("connection") and not want("block") and not want("member"):
        return edges
    for c in (await db.scalars(select(Contact))).all() if want("connection") else ():
        accepted_pairs.add((c.contact_agent_id, c.owner_id))
        edges.append(_Edge(
            f"contact:{c.id}", "connection", c.contact_agent_id, _participant_kind(c.peer_type),
            c.owner_id, _participant_kind(c.owner_type), role="consult", issued_by=c.owner_id,
            terms={"alias": c.alias} if c.alias else {},
            capability=_initial_capability(c.created_at, cutoff, agent_defaults.get(c.owner_id)),
        ))
    pending = select(ContactRequest).where(ContactRequest.state == ContactRequestState.pending)
    for r in (await db.scalars(pending)).all() if want("connection") else ():
        if (r.from_agent_id, r.to_agent_id) in accepted_pairs:
            continue
        edges.append(_Edge(
            f"contact_request:{r.id}", "connection", r.from_agent_id, _participant_kind(r.from_type),
            r.to_agent_id, _participant_kind(r.to_type), role="consult", status="pending",
            issued_by=r.from_agent_id, terms={"message": r.message} if r.message else {}, capability="consult",
        ))
    for b in (await db.scalars(select(Block))).all() if want("block") else ():
        edges.append(_Edge(
            f"block:{b.id}", "block", b.owner_id, _participant_kind(b.owner_type),
            b.blocked_agent_id, _participant_kind(b.blocked_type), issued_by=b.owner_id,
        ))

    # conversation membership; an agent's member edge carries what non-owners
    # may make it do in that room (organization rooms: always 'consult').
    org_rooms = set((await db.scalars(select(Room.room_id).where(Room.space_id.is_not(None)))).all()) if want("member") else set()
    for m in (await db.scalars(select(RoomMember))).all() if want("member") else ():
        terms = {k: v for k, v in (("can_send", m.can_send), ("can_invite", m.can_invite)) if v is not None}
        role = m.role.value if hasattr(m.role, "value") else str(m.role)
        kind = _participant_kind(m.participant_type)
        capability = None
        if kind == "agent":
            capability = ("consult" if m.room_id in org_rooms
                          else _initial_capability(m.joined_at, cutoff, agent_defaults.get(m.agent_id)))
        edges.append(_Edge(
            f"room_member:{m.id}", "member", m.agent_id, kind,
            m.room_id, "conversation", role=role, terms=terms, capability=capability,
        ))
    return edges


def _snapshot(edge: AccessEdge) -> dict[str, Any]:
    out = {f: getattr(edge, f) for f in _FIELDS}
    for k in ("expires_at", "revoked_at"):
        if out[k] is not None:
            out[k] = _aware(out[k]).isoformat()
    out["version"] = edge.version
    out["capability"] = edge.capability
    return out


def _same(edge: AccessEdge, want: _Edge) -> bool:
    for f in _FIELDS:
        a, b = getattr(edge, f), getattr(want, f)
        if f in ("expires_at", "revoked_at"):
            a, b = _aware(a), _aware(b)
        if a != b:
            return False
    return want.version is None or edge.version == want.version


async def sync_access_graph(
    db: AsyncSession, *, now: datetime.datetime | None = None, kinds: set[str] | None = None,
) -> SyncStats:
    """Apply the legacy → graph projection inside the caller's transaction.

    ``kinds`` limits the edge projection (principals are always synced).
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stats = SyncStats()

    # 1. principals
    want_p = await _desired_principals(db)
    have_p = {p.id: p for p in (await db.scalars(select(AccessPrincipal))).all()}
    for pid, attrs in want_p.items():
        row = have_p.get(pid)
        if row is None:
            db.add(AccessPrincipal(id=pid, **attrs))
            stats.principals_added += 1
        elif any(getattr(row, k) != v for k, v in attrs.items() if k != "kind"):
            for k, v in attrs.items():
                setattr(row, k, v)
            stats.principals_updated += 1
    for pid, row in have_p.items():
        if pid not in want_p and row.status != "inactive":
            row.status = "inactive"
            stats.principals_updated += 1
    await db.flush()
    known = set(want_p) | set(have_p)

    # 2. edges
    wanted: dict[str, _Edge] = {}
    live_keys: set[tuple] = set()
    for e in await _desired_edges(db, now, kinds):
        if e.from_id not in known or (e.to_kind != "conversation" and e.to_id not in known):
            stats.skip(f"{e.kind}:unknown_principal")
            continue
        if e.status in ("pending", "active"):
            key = (e.kind, e.from_id, e.to_id, e.scope_org_id)
            if key in live_keys:
                stats.skip(f"{e.kind}:duplicate")
                continue
            live_keys.add(key)
        wanted[e.source] = e

    have_q = select(AccessEdge).where(AccessEdge.source.is_not(None))
    if kinds is not None:
        have_q = have_q.where(AccessEdge.kind.in_(kinds))
    have = {e.source: e for e in (await db.scalars(have_q)).all()}
    # Revoke first so a re-created relation can take over the live unique key.
    for source, edge in have.items():
        if source not in wanted and edge.status in ("pending", "active"):
            before = _snapshot(edge)
            edge.status, edge.revoked_at, edge.version = "revoked", now, edge.version + 1
            db.add(AccessEdgeEvent(edge_id=edge.id, event="revoked", version=edge.version,
                                   before=before, after=_snapshot(edge)))
            stats.edges_revoked += 1
    await db.flush()

    # Edges leaving the live states go first: a relation replaced in the same
    # transaction (e.g. a grant upgraded from consultant to collaborator) must
    # free the live-edge unique key before its successor is inserted.
    ordered = sorted(wanted.items(), key=lambda kv: kv[1].status in ("pending", "active"))
    for source, want in ordered:
        edge = have.get(source)
        values = {f: getattr(want, f) for f in _FIELDS}
        if edge is None:
            edge = AccessEdge(source=source, version=want.version or 1, capability=want.capability, **values)
            db.add(edge)
            await db.flush()
            db.add(AccessEdgeEvent(edge_id=edge.id, event="created", version=edge.version, after=_snapshot(edge)))
            have[source] = edge
            stats.edges_added += 1
        elif not _same(edge, want):
            before = _snapshot(edge)
            for f, v in values.items():
                setattr(edge, f, v)
            edge.version = want.version if want.version is not None else edge.version + 1
            db.add(AccessEdgeEvent(edge_id=edge.id, event="updated", version=edge.version,
                                   before=before, after=_snapshot(edge)))
            stats.edges_updated += 1
    await db.flush()

    # 3. dependencies
    ids = [have[src].id for src in wanted]
    have_deps: dict[Any, set[tuple]] = {}
    if ids:
        for d in (await db.scalars(select(AccessEdgeDep).where(AccessEdgeDep.edge_id.in_(ids)))).all():
            have_deps.setdefault(d.edge_id, set()).add((d.depends_on_edge_id, d.depends_on_version))
    missing = {src for w in wanted.values() for src, _ in w.deps if src not in have}
    if missing:
        for e in (await db.scalars(select(AccessEdge).where(AccessEdge.source.in_(missing)))).all():
            have[e.source] = e
    for source, want in wanted.items():
        edge = have[source]
        target = {(have[s].id, v) for s, v in want.deps if s in have}
        if target != have_deps.get(edge.id, set()):
            for d in (await db.scalars(select(AccessEdgeDep).where(AccessEdgeDep.edge_id == edge.id))).all():
                await db.delete(d)
            await db.flush()
            for dep_id, version in target:
                db.add(AccessEdgeDep(edge_id=edge.id, depends_on_edge_id=dep_id, depends_on_version=version))
    await db.flush()
    return stats


async def run_sync_once() -> SyncStats | None:
    """One locked sync in its own transaction; None when another process holds the lock."""
    from hub.database import async_session

    async with async_session() as db:
        if db.get_bind().dialect.name == "postgresql":
            got = (await db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": _ADVISORY_LOCK_KEY})).scalar_one()
            if not got:
                return None
        try:
            stats = await sync_access_graph(db)
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    global LAST_SYNC_AT
    LAST_SYNC_AT = datetime.datetime.now(datetime.timezone.utc)
    return stats


async def access_graph_sync_loop() -> None:
    """Keep the graph projection fresh until the legacy tables are retired."""
    while True:
        try:
            stats = await run_sync_once()
            if stats is not None and stats.changed():
                logger.info("access graph sync: %s", stats)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("access_graph_sync_loop error")
        await asyncio.sleep(hub_config.ACCESS_GRAPH_SYNC_INTERVAL_SECONDS)

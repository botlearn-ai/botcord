"""Keep authorization edges current inside the writing transaction (PR 3).

Organization membership, access grants and agent ownership are read from the
access graph, so they must not lag behind the legacy tables. Any flush that
touches those tables (ORM objects or bulk ``update()``/``delete()``) marks the
session; right before it commits, the ownership / membership / grant edges are
re-projected in the same transaction. The background loop still covers every
other kind.

On Postgres the projection takes a transaction-scoped advisory lock (the same
key the background loop try-locks) so concurrent writers serialize instead of
racing on the live-edge unique index. A projection error fails the commit:
a stale grant edge must never outlive a revocation.
"""

from __future__ import annotations

import logging

from sqlalchemy import event, inspect, text
from sqlalchemy.ext.asyncio import async_session as async_proxy
from sqlalchemy.orm import Session
from sqlalchemy.util import await_only

from hub import config as hub_config
from hub.models import (
    Agent,
    AgentAccessGrant,
    AgentOwnership,
    Organization,
    Space,
    SpaceAgentMembership,
    SpaceRoleBinding,
    SpaceUserMembership,
    User,
)

logger = logging.getLogger(__name__)

WRITE_THROUGH_KINDS = {"ownership", "membership", "grant"}
_ALWAYS = (AgentAccessGrant, AgentOwnership, Organization, Space, SpaceAgentMembership,
           SpaceRoleBinding, SpaceUserMembership)
# Only these columns of hot tables affect principals or the projected kinds.
_WATCHED = {
    Agent: ("user_id", "status", "display_name", "avatar_url"),
    User: ("status", "banned_at", "display_name", "avatar_url"),
}
_FLAG = "access_graph_dirty"
_RUNNING = "access_graph_projecting"


def _relevant(obj, *, new_or_deleted: bool) -> bool:
    if isinstance(obj, _ALWAYS):
        return True
    for cls, cols in _WATCHED.items():
        if isinstance(obj, cls):
            if new_or_deleted:
                return True
            state = inspect(obj)
            return any(state.attrs[c].history.has_changes() for c in cols)
    return False


@event.listens_for(Session, "after_flush")
def _mark_dirty(session: Session, _flush_context) -> None:
    if session.info.get(_RUNNING):
        return
    if any(_relevant(o, new_or_deleted=True) for o in (*session.new, *session.deleted)) or any(
        _relevant(o, new_or_deleted=False) for o in session.dirty
    ):
        session.info[_FLAG] = True


@event.listens_for(Session, "do_orm_execute")
def _mark_bulk(state) -> None:
    if not (state.is_update or state.is_delete) or state.session.info.get(_RUNNING):
        return
    mapper = state.bind_mapper
    if mapper is not None and issubclass(mapper.class_, (*_ALWAYS, *_WATCHED)):
        state.session.info[_FLAG] = True


async def _project(proxy) -> None:
    from hub.services.access_graph_sync import _ADVISORY_LOCK_KEY, sync_access_graph

    session = proxy.sync_session
    session.info[_RUNNING] = True
    try:
        if proxy.get_bind().dialect.name == "postgresql":
            await proxy.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _ADVISORY_LOCK_KEY})
        await sync_access_graph(proxy, kinds=WRITE_THROUGH_KINDS)
    finally:
        session.info.pop(_RUNNING, None)


async def ensure_current(db) -> None:
    """Read-your-writes: project pending legacy changes before reading edges."""
    if not hub_config.ACCESS_GRAPH_WRITE_THROUGH or db.sync_session.info.get(_RUNNING):
        return
    await db.flush()
    if db.sync_session.info.pop(_FLAG, False):
        await _project(db)


@event.listens_for(Session, "before_commit")
def _project_before_commit(session: Session) -> None:
    if not hub_config.ACCESS_GRAPH_WRITE_THROUGH or session.info.get(_RUNNING):
        return
    proxy = async_proxy(session)
    if proxy is None:  # plain sync session (scripts); the background loop catches up
        return

    # before_commit fires before commit's own flush; flush first so pending
    # changes reach after_flush and set the flag. Flush errors (constraint
    # violations) propagate exactly as commit would have raised them.
    await_only(proxy.flush())
    if not session.info.pop(_FLAG, False):
        return
    try:
        await_only(_project(proxy))
    except Exception:
        logger.exception("access graph write-through failed; aborting commit")
        raise

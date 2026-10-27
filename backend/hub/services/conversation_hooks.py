"""Project ordinary Hub writes before commit; fail atomically on errors.

DB triggers are the durable capture mechanism. This hook provides immediate
read-after-write for AsyncSession callers; the worker recovers direct SQL writes.
"""
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_session
from sqlalchemy.orm import Session
from sqlalchemy.util import await_only


@event.listens_for(Session, "before_commit")
def project_before_commit(session):
    if session.info.get("conversation_projection_failed"):
        raise RuntimeError("Conversation projection failed; rollback is required before retry")
    if session.info.get("conversation_projecting"):
        return
    bind = session.get_bind()
    engine = getattr(bind, "engine", bind)
    if not getattr(engine, "_conversation_capture_installed", False):
        return
    proxy = async_session(session)
    if proxy is None:
        return
    from hub.services.conversation_projection import project_pending
    session.info["conversation_projecting"] = True
    try:
        await_only(proxy.flush())
        # Ordinary sends affect one room. Large imports are drained by the
        # recovery worker rather than delaying their transaction indefinitely.
        await_only(project_pending(proxy, own_transaction=True))
    except Exception:
        # A Python exception in before_commit does not itself put SQLAlchemy
        # into failed-transaction state. Never let a caller catch it and then
        # commit partially projected data without rolling back first.
        session.info["conversation_projection_failed"] = True
        raise
    finally:
        session.info.pop("conversation_projecting", None)


@event.listens_for(Session, "after_soft_rollback")
def clear_failure_after_rollback(session, _previous_transaction):
    session.info.pop("conversation_projection_failed", None)

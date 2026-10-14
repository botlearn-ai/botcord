"""Explicit agent decisions. Delivery ACKs never complete a response."""
import datetime as dt
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import Agent, MessageRecord, MessageResponseLink, MessageResponseRun

from hub.services.message_response_states import (
    TERMINAL, RESOLVED, ResponseReason, current_state, transition,
)
LEASE_SECONDS = 180


class ResponseRunUpdate(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    action: Literal["queue", "register", "start", "ignore", "no_reply", "replying", "heartbeat", "finish"]
    room_id: str = Field(min_length=1, max_length=64)
    message_ids: list[str] = Field(default_factory=list, max_length=100)
    outcome: Literal["unconfirmed", "failed", "interrupted"] = "unconfirmed"
    reason: ResponseReason | None = None
    only_if_queued: bool = False


class ResponseMetadata(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    responds_to: list[str] = Field(default_factory=list, max_length=100)
    kind: Literal["progress", "final"]


def now():
    return dt.datetime.now(dt.timezone.utc)


def expired(run):
    return run.expires_at.replace(tzinfo=dt.timezone.utc) <= now()


async def owned_run(db, run_id, agent_id, room_id):
    run = (await db.execute(select(MessageResponseRun).where(
        MessageResponseRun.run_id == run_id,
    ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if run is None or run.agent_id != agent_id or run.room_id != room_id:
        raise HTTPException(404, "Response run not found")
    return run


async def lock_response_agent(db: AsyncSession, agent_id: str):
    # Serialize response transactions for an agent, including the first register
    # where no run row exists yet. This also prevents cross-run lock inversion
    # while transferring batched inputs. SQLite tests have no row-level locks.
    await db.execute(select(Agent.agent_id).where(Agent.agent_id == agent_id).with_for_update().execution_options(populate_existing=True))


async def update_run(db: AsyncSession, agent_id: str, body: ResponseRunUpdate):
    if body.only_if_queued and body.action != "finish":
        raise HTTPException(422, "only_if_queued is valid only for finish")
    await lock_response_agent(db, agent_id)
    ids = list(dict.fromkeys(body.message_ids))
    if body.action in {"heartbeat", "finish"} and ids:
        raise HTTPException(422, "Run lifecycle updates apply to the entire execution")
    if body.action in {"queue", "register"}:
        if not ids:
            raise HTTPException(422, "Run inputs are required")
        existing = (await db.execute(select(MessageResponseRun).where(
            MessageResponseRun.run_id == body.run_id,
        ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
        if existing and (existing.agent_id != agent_id or existing.room_id != body.room_id):
            raise HTTPException(409, "Run ID already used")
        promoting = existing is not None and existing.status == "queued" and body.action == "register"
        if existing and not promoting:
            if set(existing.message_ids) != set(ids):
                raise HTTPException(409, "Run ID already used")
            if existing.status not in {"queued", "running"} or expired(existing):
                raise HTTPException(409, "Response run is no longer active")
            return existing
        if existing and expired(existing):
            raise HTTPException(409, "Response run is no longer active")
        # Include the prior queued inputs so batch trimming can be recorded.
        locked_ids = set(ids) | (set(existing.message_ids) if existing else set())
        records = (await db.execute(select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.room_id == body.room_id,
            MessageRecord.msg_id.in_(locked_ids),
        ).order_by(MessageRecord.id).with_for_update().execution_options(populate_existing=True))).scalars().all()
        if len(records) != len(locked_ids) or any(r.recalled_at for r in records):
            raise HTTPException(404, "Run input is not an available delivery to this agent")
        # A queued attempt cannot preempt running inputs, but may recover
        # inputs whose previous execution has ended or lost its lease.
        if body.action == "queue" or promoting:
            owners = {r.response_run_id for r in records if r.response_run_id != body.run_id
                      and r.response_run_id and current_state(r) not in TERMINAL
                      and current_state(r) != "queued"}
            if owners:
                old_runs = (await db.execute(select(MessageResponseRun).where(
                    MessageResponseRun.run_id.in_(owners),
                ).execution_options(populate_existing=True))).scalars().all()
                if any(r.status == "running" and not expired(r) for r in old_runs):
                    raise HTTPException(409, "Input already belongs to an active execution")
        run = existing or MessageResponseRun(run_id=body.run_id, agent_id=agent_id,
            room_id=body.room_id, message_ids=ids)
        run.message_ids = ids
        run.status = "queued" if body.action == "queue" else "running"
        run.expires_at = now() + dt.timedelta(seconds=LEASE_SECONDS)
        db.add(run)
        for record in records:
            if current_state(record) in RESOLVED:
                continue
            if record.msg_id not in ids:
                if record.response_run_id == run.run_id and current_state(record) not in TERMINAL:
                    transition(db, record, run.run_id, "failed", "batch_trimmed")
                continue
            transition(db, record, run.run_id, "queued" if body.action == "queue" else "waiting")
        await db.flush()
        return run

    run = await owned_run(db, body.run_id, agent_id, body.room_id)
    if not set(ids).issubset(run.message_ids):
        raise HTTPException(422, "Decision targets must be run inputs")
    if body.action == "finish" and (run.status == "finished" or (body.only_if_queued and run.status != "queued")):
        return run
    if run.status not in {"queued", "running"} or expired(run):
        raise HTTPException(409, "Response run is no longer active")
    if body.action == "heartbeat":
        run.expires_at = now() + dt.timedelta(seconds=LEASE_SECONDS)
        return run
    if body.action not in {"heartbeat", "finish"} and run.status != "running":
        raise HTTPException(409, "Queued inputs must be registered before decisions")
    if body.action in {"start", "ignore", "no_reply", "replying"} and not ids:
        raise HTTPException(422, "Explicit decision targets are required")
    records = (await db.execute(select(MessageRecord).where(
        MessageRecord.response_run_id == run.run_id,
        MessageRecord.receiver_id == agent_id,
        MessageRecord.msg_id.in_(ids or run.message_ids),
    ).order_by(MessageRecord.id).with_for_update().execution_options(populate_existing=True))).scalars().all()
    if body.action != "finish" and len(records) != len(ids):
        raise HTTPException(409, "Targets have moved to another execution")
    if body.action == "ignore" and any(current_state(r) in {"processing", "replying"} for r in records):
        raise HTTPException(409, "Started inputs cannot be ignored; use no_reply")
    if body.action == "no_reply" and any(current_state(r) == "replying" for r in records):
        raise HTTPException(409, "Inputs with a reply in progress cannot be marked no_reply")
    for record in records:
        if current_state(record) in TERMINAL:
            continue
        state = {"start": "processing", "ignore": "ignored", "no_reply": "no_reply",
                 "replying": "replying", "finish": body.outcome}[body.action]
        transition(db, record, run.run_id, state, body.reason)
    await db.flush()
    if body.action == "finish":
        run.status = "finished"
    return run


async def record_response(db: AsyncSession, envelope, room_id: str):
    """Called inside the message-send transaction; metadata is in signed payload."""
    raw = envelope.payload.get("response")
    if raw is None:
        return
    if envelope.type.value != "message":
        raise HTTPException(422, "Response metadata requires a message")
    try:
        meta = ResponseMetadata.model_validate(raw)
    except ValueError:
        raise HTTPException(422, "Invalid response metadata")
    visible_text = any(isinstance(envelope.payload.get(key), str) and envelope.payload[key].strip()
                       for key in ("text", "body", "message"))
    attachments = envelope.payload.get("attachments")
    visible_files = isinstance(attachments, list) and any(
        isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"].strip()
        for item in attachments
    )
    if not visible_text and not visible_files:
        raise HTTPException(422, "A response requires visible text or an attachment")
    await lock_response_agent(db, envelope.from_)
    run = await owned_run(db, meta.run_id, envelope.from_, room_id)
    # A successful retry must stay successful even if the run has since ended.
    links = (await db.execute(select(MessageResponseLink).where(
        MessageResponseLink.reply_msg_id == envelope.msg_id,
        MessageResponseLink.agent_id == envelope.from_,
    ))).scalars().all()
    if links:
        if any(link.run_id != meta.run_id or link.kind != meta.kind for link in links) or (
            meta.responds_to and set(meta.responds_to) != {link.target_msg_id for link in links}
        ):
            raise HTTPException(409, "Reply ID already used with different targets")
        return
    if run.status != "running" or expired(run):
        raise HTTPException(409, "Response run is no longer active")
    records = (await db.execute(select(MessageRecord).where(
        MessageRecord.response_run_id == run.run_id,
        MessageRecord.receiver_id == run.agent_id,
    ).order_by(MessageRecord.id).with_for_update().execution_options(populate_existing=True))).scalars().all()
    ids = set(meta.responds_to)
    if not ids:
        # Automatic final-text delivery may use a single input or an explicit
        # prior start decision. Never guess the newest message in a batch.
        ids = {r.msg_id for r in records if r.response_status == "processing"}
        if not ids and len(run.message_ids) == 1:
            ids = set(run.message_ids)
    targets = [r for r in records if r.msg_id in ids]
    if not ids or len(targets) != len(ids):
        raise HTTPException(409, "Explicit current response targets are required")
    if any(current_state(r) in TERMINAL or r.recalled_at for r in targets):
        raise HTTPException(409, "Response target is already resolved or unavailable")
    for record in targets:
        db.add(MessageResponseLink(run_id=run.run_id, agent_id=run.agent_id,
                                  reply_msg_id=envelope.msg_id, target_msg_id=record.msg_id, kind=meta.kind))
        transition(db, record, run.run_id, "completed" if meta.kind == "final" else "replying",
                   reply_msg_id=envelope.msg_id)
    await db.flush()

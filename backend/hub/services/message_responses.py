"""Explicit agent decisions. Delivery ACKs never complete a response."""
import datetime as dt
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import MessageRecord, MessageResponseLink, MessageResponseRun

TERMINAL = {"completed", "no_reply", "failed", "interrupted", "unconfirmed"}
LEASE_SECONDS = 180


class ResponseRunUpdate(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    action: Literal["register", "start", "no_reply", "heartbeat", "finish"]
    room_id: str = Field(min_length=1, max_length=64)
    message_ids: list[str] = Field(default_factory=list, max_length=100)
    outcome: Literal["unconfirmed", "failed", "interrupted"] = "unconfirmed"


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
    ).with_for_update())).scalar_one_or_none()
    if run is None or run.agent_id != agent_id or run.room_id != room_id:
        raise HTTPException(404, "Response run not found")
    return run


async def update_run(db: AsyncSession, agent_id: str, body: ResponseRunUpdate):
    ids = list(dict.fromkeys(body.message_ids))
    if body.action in {"heartbeat", "finish"} and ids:
        raise HTTPException(422, "Run lifecycle updates apply to the entire execution")
    if body.action == "register":
        if not ids:
            raise HTTPException(422, "Run inputs are required")
        # Lock deliveries before registering so concurrent retries cannot create
        # conflicting ownership. Input IDs are canonical message IDs, not hub IDs.
        records = (await db.execute(select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.room_id == body.room_id,
            MessageRecord.msg_id.in_(ids),
        ).order_by(MessageRecord.id).with_for_update())).scalars().all()
        if len(records) != len(ids) or any(r.recalled_at for r in records):
            raise HTTPException(404, "Run input is not an available delivery to this agent")
        existing = await db.get(MessageResponseRun, body.run_id)
        if existing:
            if existing.agent_id != agent_id or existing.room_id != body.room_id or set(existing.message_ids) != set(ids):
                raise HTTPException(409, "Run ID already used")
            if existing.status != "running" or expired(existing):
                raise HTTPException(409, "Response run is no longer active")
            return existing
        run = MessageResponseRun(run_id=body.run_id, agent_id=agent_id, room_id=body.room_id,
                                 message_ids=ids, status="running", expires_at=now() + dt.timedelta(seconds=LEASE_SECONDS))
        db.add(run)
        for record in records:
            if record.response_status in {"completed", "no_reply"}:
                continue
            record.response_run_id = body.run_id
            record.response_status = "waiting"
        await db.flush()
        return run

    run = await owned_run(db, body.run_id, agent_id, body.room_id)
    if not set(ids).issubset(run.message_ids):
        raise HTTPException(422, "Decision targets must be run inputs")
    if body.action == "finish" and run.status != "running":
        return run
    if run.status != "running" or expired(run):
        raise HTTPException(409, "Response run is no longer active")
    if body.action == "heartbeat":
        run.expires_at = now() + dt.timedelta(seconds=LEASE_SECONDS)
        return run
    if body.action in {"start", "no_reply"} and not ids:
        raise HTTPException(422, "Explicit decision targets are required")
    records = (await db.execute(select(MessageRecord).where(
        MessageRecord.response_run_id == run.run_id,
        MessageRecord.receiver_id == agent_id,
        MessageRecord.msg_id.in_(ids or run.message_ids),
    ).order_by(MessageRecord.id).with_for_update())).scalars().all()
    if body.action != "finish" and len(records) != len(ids):
        raise HTTPException(409, "Targets have moved to another execution")
    for record in records:
        if record.response_status in TERMINAL:
            continue
        record.response_status = {"start": "processing", "no_reply": "no_reply", "finish": body.outcome}[body.action]
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
    ).order_by(MessageRecord.id).with_for_update())).scalars().all()
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
    if any(r.response_status in TERMINAL or r.recalled_at for r in targets):
        raise HTTPException(409, "Response target is already resolved or unavailable")
    for record in targets:
        db.add(MessageResponseLink(run_id=run.run_id, agent_id=run.agent_id,
                                  reply_msg_id=envelope.msg_id, target_msg_id=record.msg_id, kind=meta.kind))
        record.response_status = "completed" if meta.kind == "final" else "processing"
        if meta.kind == "final":
            record.response_reply_msg_id = envelope.msg_id
    await db.flush()

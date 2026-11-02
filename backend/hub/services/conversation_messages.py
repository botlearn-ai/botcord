"""Incremental, delivery-independent room summaries.

Call only while holding the room's transactional outbox lock. Source changes,
logical messages, unread deltas and account cursors commit or roll back together.
Full source scans are reserved for explicit rebuilds / first initialization.
"""
from __future__ import annotations

from dataclasses import dataclass
import datetime as dt

from sqlalchemy import JSON, case, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.routers.dashboard import _preview_for_record
from hub.models import (
    ConversationDirtyMessage, ConversationEntry, ConversationMessage, ConversationRoomSummary,
    MessageRecord,
)

METADATA = 1
MESSAGES = 2
READ = 4
REBUILD = 8


def utc(value: dt.datetime | str | None) -> dt.datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = dt.datetime.fromisoformat(value)
    return value.replace(tzinfo=value.tzinfo or dt.timezone.utc).astimezone(dt.timezone.utc)


@dataclass(frozen=True)
class MessageValue:
    canonical_id: int
    sender_id: str
    created_at: dt.datetime
    recalled_at: dt.datetime | None
    preview: str | None

    @classmethod
    def from_projection(cls, row: ConversationMessage) -> MessageValue:
        return cls(row.canonical_id, row.sender_id, utc(row.created_at), utc(row.recalled_at), row.preview)

    @classmethod
    def from_source(cls, row: MessageRecord) -> MessageValue:
        return cls(row.id, row.sender_id, utc(row.created_at), utc(row.recalled_at), _preview_for_record(row)[1])

    def unread_for(self, human_id: str | None, read_at: dt.datetime | None) -> bool:
        return bool(human_id and self.sender_id != human_id and self.recalled_at is None
                    and (read_at is None or self.created_at > read_at))


def display_message(db: AsyncSession) -> ColumnElement[bool]:
    if db.get_bind().dialect.name == "postgresql":
        kind = cast(MessageRecord.envelope_json, JSON)["type"].as_string()
    else:
        kind = func.json_extract(case((func.json_valid(MessageRecord.envelope_json),
            MessageRecord.envelope_json), else_="{}"), "$.type")
    return func.coalesce(kind, "message").in_(["message", "system"])


async def rebuild_messages(db: AsyncSession, room_id: str) -> None:
    """Stream canonical records in bounded batches; never load full envelopes at once."""
    await db.execute(delete(ConversationMessage).where(ConversationMessage.room_id == room_id))
    after = None
    while True:
        ids = select(func.min(MessageRecord.id)).where(
            MessageRecord.room_id == room_id, display_message(db))
        if after is not None:
            ids = ids.where(MessageRecord.msg_id > after)
        ids = ids.group_by(MessageRecord.msg_id).order_by(MessageRecord.msg_id).limit(500)
        rows = (await db.scalars(select(MessageRecord).where(MessageRecord.id.in_(ids))
            .order_by(MessageRecord.msg_id))).all()
        if not rows:
            break
        for row in rows:
            db.add(ConversationMessage(room_id=room_id, msg_id=row.msg_id,
                **vars(MessageValue.from_source(row))))
        await db.flush()
        after = rows[-1].msg_id


async def refresh_room(
    db: AsyncSession, room_id: str, reasons: int,
) -> tuple[ConversationRoomSummary, list[tuple[MessageValue | None, MessageValue | None]], bool]:
    summary = await db.get(ConversationRoomSummary, room_id, populate_existing=True)
    rebuild = summary is None or bool(reasons & REBUILD)
    changes = []
    if rebuild:
        await rebuild_messages(db, room_id)
        if summary is None:
            summary = ConversationRoomSummary(room_id=room_id)
            db.add(summary)
    elif reasons & MESSAGES:
        keys = (await db.scalars(select(ConversationDirtyMessage.msg_id)
            .where(ConversationDirtyMessage.room_id == room_id).order_by(ConversationDirtyMessage.msg_id))).all()
        for msg_id in keys:
            old = await db.get(ConversationMessage, (room_id, msg_id), populate_existing=True)
            before = MessageValue.from_projection(old) if old else None
            # The existing product selects the lowest *display* delivery ID.
            # Recall/type/order changes or deletion can promote another copy.
            source = await db.scalar(select(MessageRecord).where(
                MessageRecord.room_id == room_id, MessageRecord.msg_id == msg_id,
                display_message(db)).order_by(MessageRecord.id).limit(1).execution_options(populate_existing=True))
            after = MessageValue.from_source(source) if source else None
            if before == after:
                continue
            changes.append((before, after))
            if after is None:
                if old is not None:
                    await db.delete(old)
            elif old is None:
                db.add(ConversationMessage(room_id=room_id, msg_id=msg_id, **vars(after)))
            else:
                for key, value in vars(after).items():
                    setattr(old, key, value)
    await db.flush()
    if rebuild or changes:
        latest = await db.scalar(select(ConversationMessage).where(ConversationMessage.room_id == room_id)
            .order_by(ConversationMessage.created_at.desc(), ConversationMessage.canonical_id.desc()).limit(1))
        summary.last_message_at = latest.created_at if latest else None
        summary.last_sender_id = latest.sender_id if latest else None
        summary.last_message_preview = latest.preview if latest else None
    await db.execute(delete(ConversationDirtyMessage).where(ConversationDirtyMessage.room_id == room_id))
    return summary, changes, rebuild


async def unread_count(
    db: AsyncSession, room_id: str, human_id: str | None, read_at: dt.datetime | None,
    previous: ConversationEntry | None, changes: list[tuple[MessageValue | None, MessageValue | None]],
    rebuild: bool, latest_at: dt.datetime | None,
) -> int:
    """Apply only changed logical messages; reading latest is a constant-size update."""
    if not human_id:
        return 0
    read_at = utc(read_at)
    latest_at = utc(latest_at)
    if latest_at is None or (read_at is not None and read_at >= latest_at):
        return 0
    base = select(func.count()).select_from(ConversationMessage).where(
        ConversationMessage.room_id == room_id, ConversationMessage.sender_id != human_id,
        ConversationMessage.recalled_at.is_(None))
    old_at = utc(previous.payload.get("last_viewed_at")) if previous else None
    if rebuild or previous is None or previous.deleted or previous.read_member_id != human_id or (
        old_at is not None and (read_at is None or read_at < old_at)
    ):
        if read_at is not None:
            base = base.where(ConversationMessage.created_at > read_at)
        return await db.scalar(base)
    count = previous.payload["unread_count"]
    for before, after in changes:
        count += int(after.unread_for(human_id, old_at)) if after else 0
        count -= int(before.unread_for(human_id, old_at)) if before else 0
    if read_at != old_at:
        # The projection already includes message deltas; subtract only the
        # newly read interval using its compact room/time index.
        base = base.where(ConversationMessage.created_at <= read_at)
        if old_at is not None:
            base = base.where(ConversationMessage.created_at > old_at)
        count -= await db.scalar(base)
    return count

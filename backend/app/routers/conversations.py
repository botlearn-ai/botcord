"""Account-scoped snapshot/keyset and commit-ordered delta reads.

This endpoint never aggregates message history. Source writes transactionally
maintain the directory through conversation_projection and its durable outbox.
"""
import base64
import datetime as dt
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent, ConversationAccount, ConversationChange, ConversationEntry, Room, RoomMember, User

router = APIRouter(prefix="/api/conversations", tags=["app-conversations"])


class ConversationSyncRequest(BaseModel):
    cursor: str | None = Field(default=None, max_length=2048)
    limit: int = Field(default=100, ge=1, le=200)
    # Compatibility for the previous manifest client. It reads the
    # same persisted directory, never the old historical aggregation.
    known: dict[str, str] = Field(default_factory=dict, max_length=20000)


def encode_cursor(account, **state):
    return base64.urlsafe_b64encode(json.dumps({"v": 2, "account": str(account.user_id),
        "epoch": account.epoch, **state}, separators=(",", ":")).encode()).decode()


def decode_cursor(value, account):
    if not value:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(value))
        if data["v"] != 2 or data["account"] != str(account.user_id):
            raise ValueError("wrong scope")
        if data["epoch"] != account.epoch:
            return None
        if type(data["at"]) is not int or not account.floor <= data["at"] <= account.version:
            return None
        if data["phase"] not in ("snapshot", "delta"):
            raise ValueError("phase")
        if data["phase"] == "snapshot":
            dt.datetime.fromisoformat(data["time"])
            if not isinstance(data["room"], str):
                raise ValueError("room")
        return data
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid conversation cursor") from None


async def current_access(db, user, room_ids):
    if not room_ids:
        return set()
    bots = select(Agent.agent_id).where(Agent.user_id == user.id)
    return set((await db.execute(select(RoomMember.room_id).join(Room, Room.room_id == RoomMember.room_id)
        .where(RoomMember.room_id.in_(room_ids), Room.space_id.is_(None), ~Room.room_id.startswith("rm_sdm_"),
               or_(RoomMember.agent_id == user.human_id, RoomMember.agent_id.in_(bots))))).scalars())


@router.post("/sync")
async def sync_conversations(body: ConversationSyncRequest, ctx: RequestContext = Depends(require_user),
                             db: AsyncSession = Depends(get_db)):
    user = await db.get(User, ctx.user_id)
    account = await db.get(ConversationAccount, ctx.user_id)
    if account is None:
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        await db.execute(insert(ConversationAccount).values(user_id=user.id, epoch=uuid.uuid4().hex)
            .on_conflict_do_nothing(index_elements=["user_id"]))
        await db.commit()
        account = (await db.execute(select(ConversationAccount).where(ConversationAccount.user_id == user.id)
            .execution_options(populate_existing=True))).scalar_one()
    base_query = select(ConversationEntry).where(ConversationEntry.user_id == user.id)
    common = {"account_id": ctx.supabase_user_id, "human_id": user.human_id}
    if "cursor" not in body.model_fields_set:
        rows = (await db.execute(base_query.where(ConversationEntry.deleted.is_(False))
            .order_by(ConversationEntry.activity_at.desc(), ConversationEntry.room_id))).scalars().all()
        allowed = await current_access(db, user, [r.room_id for r in rows])
        changes = [r.payload for r in rows if r.room_id in allowed and body.known.get(r.room_id) != r.payload["revision"]]
        return {**common, "upserts": changes[:body.limit], "removed_ids": sorted(set(body.known) - allowed),
                "has_more": len(changes) > body.limit}

    cursor = decode_cursor(body.cursor, account)
    reset = cursor is None
    if cursor is None or cursor["phase"] == "snapshot":
        baseline = account.version if cursor is None else cursor["at"]
        query = base_query.where(ConversationEntry.deleted.is_(False))
        if cursor:
            after = dt.datetime.fromisoformat(cursor["time"])
            query = query.where(or_(ConversationEntry.activity_at < after,
                (ConversationEntry.activity_at == after) & (ConversationEntry.room_id > cursor["room"])))
        batch = (await db.execute(query.order_by(ConversationEntry.activity_at.desc(), ConversationEntry.room_id)
            .limit(body.limit + 1))).scalars().all()
        more_snapshot = len(batch) > body.limit
        rows = batch[:body.limit]
        if more_snapshot:
            last = rows[-1]
            next_cursor = encode_cursor(account, phase="snapshot", at=baseline,
                time=last.activity_at.isoformat(), room=last.room_id)
        else:
            # Catch up all writes after the snapshot's initial watermark. A row
            # moving above our keyset boundary cannot be permanently skipped.
            next_cursor = encode_cursor(account, phase="delta", at=baseline)
        has_more = more_snapshot or account.version > baseline
        ids = [row.room_id for row in rows]
    else:
        batch = (await db.execute(select(ConversationChange).where(ConversationChange.user_id == user.id,
            ConversationChange.version > cursor["at"], ConversationChange.version <= account.version)
            .order_by(ConversationChange.version).limit(body.limit + 1))).scalars().all()
        has_more = len(batch) > body.limit
        batch = batch[:body.limit]
        ids = list(dict.fromkeys(row.room_id for row in batch))
        rows = (await db.execute(base_query.where(ConversationEntry.room_id.in_(ids)))).scalars().all() if ids else []
        next_cursor = encode_cursor(account, phase="delta", at=batch[-1].version if has_more else account.version)
    allowed = await current_access(db, user, ids)
    entries = {r.room_id: r for r in rows}
    return {**common, "reset": reset, "next_cursor": next_cursor, "has_more": has_more,
        "upserts": [entries[rid].payload for rid in ids if rid in allowed and rid in entries and not entries[rid].deleted],
        "removed_ids": [rid for rid in ids if rid not in allowed or rid not in entries or entries[rid].deleted]}

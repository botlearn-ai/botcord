"""Write-side, account-scoped conversation projection and outbox recovery.

Historical aggregation is restricted to affected rooms during source writes or
backfill. Normal sync reads persisted entries and never executes this builder.
"""

import datetime as dt
import hashlib
import json

from sqlalchemy import JSON, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext
from app.auth_room import strongest_room_role, room_member_can_invite
from app.routers.dashboard import (
    _build_member_previews,
    _preview_for_record,
    load_agent_display_names,
    load_user_display_names,
)
from hub.models import Agent, MessageRecord, Room, RoomMember, User

def iso(value):
    if value is None:
        return None
    return value.replace(tzinfo=value.tzinfo or dt.timezone.utc).astimezone(dt.timezone.utc).isoformat()


def enum_value(value):
    return value.value if hasattr(value, "value") else value


async def conversation_summaries(db: AsyncSession, ctx: RequestContext, only_rooms: list[str] | None = None) -> list[dict]:
    agents = (await db.execute(
        select(Agent.agent_id, Agent.display_name).where(Agent.user_id == ctx.user_id)
        .order_by(Agent.agent_id)
    )).all()
    agent_names = dict(agents)
    participants = [ctx.human_id, *agent_names]
    memberships = (await db.execute(
        select(RoomMember, Room).join(Room, Room.room_id == RoomMember.room_id)
        .where(RoomMember.agent_id.in_(participants), Room.space_id.is_(None),
               ~Room.room_id.startswith("rm_sdm_"))
        .where(Room.room_id.in_(only_rooms) if only_rooms is not None else True)
        .order_by(Room.room_id, RoomMember.agent_id)
    )).all()
    rooms = {}
    members = {}
    for member, room in memberships:
        rooms[room.room_id] = room
        members.setdefault(room.room_id, []).append(member)
    if not rooms:
        return []
    room_ids = list(rooms)

    # Filter receipts before ranking; only one canonical delivery per logical
    # message contributes to previews and unread counts. Both operations stay
    # in SQL instead of loading all historical messages into Python per Bot.
    if db.bind.dialect.name == "postgresql":
        message_type = cast(MessageRecord.envelope_json, JSON)["type"].as_string()
    else:
        message_type = func.json_extract(
            case((func.json_valid(MessageRecord.envelope_json), MessageRecord.envelope_json), else_="{}"),
            "$.type",
        )
    canonical_ids = (
        select(func.min(MessageRecord.id).label("id"))
        .where(MessageRecord.room_id.in_(room_ids),
               func.coalesce(message_type, "message").in_(["message", "system"]))
        .group_by(MessageRecord.room_id, MessageRecord.msg_id).subquery()
    )
    # Carry the fields needed for counting into one materialized relation.
    # An IN(min(id) GROUP BY ...) semijoin combined with the member join can
    # produce a catastrophically bad nested-loop plan during large backfills.
    canonical = select(MessageRecord.id, MessageRecord.room_id, MessageRecord.sender_id,
        MessageRecord.created_at, MessageRecord.recalled_at).join(canonical_ids,
        canonical_ids.c.id == MessageRecord.id).cte("canonical_conversation_messages")
    if db.get_bind().dialect.name == "postgresql":
        canonical = canonical.prefix_with("MATERIALIZED")
    ranked = select(
        canonical.c.id,
        func.row_number().over(partition_by=canonical.c.room_id,
            order_by=(canonical.c.created_at.desc(), canonical.c.id.desc())).label("rank"),
    ).subquery()
    latest = {record.room_id: record for record in (await db.execute(
        select(MessageRecord).join(ranked, ranked.c.id == MessageRecord.id).where(ranked.c.rank == 1)
    )).scalars().all()}
    unread = dict((await db.execute(
        select(canonical.c.room_id, func.count())
        .join(RoomMember, (RoomMember.room_id == canonical.c.room_id) & (RoomMember.agent_id == ctx.human_id))
        .where(canonical.c.recalled_at.is_(None), canonical.c.sender_id != ctx.human_id,
               (RoomMember.last_viewed_at.is_(None)) | (canonical.c.created_at > RoomMember.last_viewed_at))
        .group_by(canonical.c.room_id)
    )).all())
    counts = dict((await db.execute(
        select(RoomMember.room_id, func.count()).where(RoomMember.room_id.in_(room_ids))
        .group_by(RoomMember.room_id)
    )).all())
    previews = await _build_member_previews(db, room_ids)
    sender_ids = {record.sender_id for record in latest.values()}
    sender_names = await load_agent_display_names(db, {sid for sid in sender_ids if not sid.startswith("hu_")})
    sender_names.update(await load_user_display_names(db, {sid for sid in sender_ids if sid.startswith("hu_")}))
    summaries = []
    for rid, room in rooms.items():
        memberships = members[rid]
        human_member = next((member for member in memberships if member.agent_id == ctx.human_id), None)
        bots = [{"agent_id": member.agent_id, "display_name": agent_names[member.agent_id] or member.agent_id}
                for member in memberships if member.agent_id in agent_names]
        observer = bool(bots) and (rid.startswith("rm_oc_") or (human_member is None and room.owner_id != ctx.human_id))
        member = human_member or memberships[0]
        roles = [m.role for m in memberships]
        if room.owner_id == ctx.human_id or room.owner_id in agent_names:
            roles.append("owner")
        role = strongest_room_role(roles) or member.role
        record = latest.get(rid)
        summary = {
            "room_id": rid, "name": room.name, "description": room.description,
            "owner_id": room.owner_id, "owner_type": enum_value(room.owner_type),
            "visibility": enum_value(room.visibility), "join_policy": enum_value(room.join_policy),
            "my_role": enum_value(role), "member_count": counts.get(rid, 0),
            "can_invite": enum_value(role) == "owner" or any(room_member_can_invite(room, m) for m in memberships),
            "rule": room.rule, "created_at": iso(room.created_at),
            "required_subscription_product_id": room.required_subscription_product_id,
            "allow_human_send": room.allow_human_send, "default_send": room.default_send,
            "default_invite": room.default_invite, "max_members": room.max_members,
            "slow_mode_seconds": room.slow_mode_seconds,
            "last_viewed_at": iso(human_member.last_viewed_at) if human_member else None,
            "last_message_at": iso(record.created_at) if record else None,
            "last_message_preview": _preview_for_record(record)[1] if record else None,
            "last_sender_name": sender_names.get(record.sender_id) if record else None,
            "last_sender_id": record.sender_id if record else None,
            "has_unread": unread.get(rid, 0) > 0, "unread_count": unread.get(rid, 0),
            "members_preview": previews.get(rid, []),
            "_originAgent": bots[0] if observer else None,
            "_originAgents": bots,
        }
        # Stable tie-break and fingerprint cover metadata, membership and unread
        # changes too, including recalls that do not advance message time.
        summary["revision"] = hashlib.sha256(json.dumps(summary, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]
        summaries.append(summary)
    summaries.sort(key=lambda row: row["room_id"])
    summaries.sort(key=lambda row: row["last_message_at"] or "", reverse=True)
    return summaries



# The expensive historical aggregation above is a WRITE-side projection only.
# Sync endpoints read persisted entries/change rows and never invoke it.
async def project_pending(db: AsyncSession, *, limit: int = 500, own_transaction: bool = False) -> int:
    import uuid
    from sqlalchemy import delete, or_
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    from hub.models import ConversationAccount, ConversationChange, ConversationDirtyRoom, ConversationEntry

    query = select(ConversationDirtyRoom.room_id)
    if own_transaction and db.get_bind().dialect.name == "postgresql":
        from sqlalchemy import String
        # A normal send must not pay for unrelated backfill/recovery work.
        # txid is only an ownership tag for this queue row, NEVER a sync cursor.
        query = query.where(ConversationDirtyRoom.writer_xid == cast(func.txid_current(), String))
    dirty = (await db.execute(query.order_by(ConversationDirtyRoom.room_id)
        .limit(limit).with_for_update(skip_locked=True))).scalars().all()
    if not dirty:
        return 0
    # Locks remain held until commit. Concurrent source writes update/reinsert
    # this row after our commit, so deleting it here cannot swallow a new event.
    await db.execute(delete(ConversationDirtyRoom).where(ConversationDirtyRoom.room_id.in_(dirty)))
    participants = select(RoomMember.agent_id).where(RoomMember.room_id.in_(dirty))
    owners = select(Agent.user_id).where(Agent.agent_id.in_(participants), Agent.user_id.is_not(None))
    previous = select(ConversationEntry.user_id).where(ConversationEntry.room_id.in_(dirty))
    users = (await db.execute(select(User).where(or_(User.human_id.in_(participants), User.id.in_(owners), User.id.in_(previous)))
        .order_by(User.id))).scalars().all()
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    for user in users:
        await db.execute(insert(ConversationAccount).values(user_id=user.id, epoch=uuid.uuid4().hex)
            .on_conflict_do_nothing(index_elements=["user_id"]))
        # This lock is acquired BEFORE reading/advancing the account version.
        # A later version can never commit before an earlier version for this account.
        account = (await db.execute(select(ConversationAccount).where(ConversationAccount.user_id == user.id)
            .with_for_update().execution_options(populate_existing=True))).scalar_one()
        entries = {row.room_id: row for row in (await db.execute(select(ConversationEntry)
            .where(ConversationEntry.user_id == user.id, ConversationEntry.room_id.in_(dirty))
            .execution_options(populate_existing=True))).scalars()}
        ctx = RequestContext(user_id=user.id, supabase_user_id=str(user.supabase_user_id), human_id=user.human_id)
        summaries = {row["room_id"]: row for row in await conversation_summaries(db, ctx, dirty)}
        for rid in sorted(set(entries) | set(summaries)):
            old = entries.get(rid)
            payload = summaries.get(rid)
            if old and ((payload is None and old.deleted) or (payload is not None and not old.deleted and old.payload == payload)):
                continue
            account.version += 1
            values = dict(version=account.version, deleted=payload is None, payload=payload or {},
                last_sender_id=payload.get("last_sender_id") if payload else None,
                activity_at=dt.datetime.fromisoformat(payload["last_message_at"]) if payload and payload["last_message_at"] else dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc))
            if old:
                for key, value in values.items():
                    setattr(old, key, value)
            else:
                db.add(ConversationEntry(user_id=user.id, room_id=rid, **values))
            db.add(ConversationChange(user_id=user.id, version=account.version, room_id=rid))
        # Bounded log. Older clients reset using the current snapshot. This is
        # per-account retention; quiet accounts don't expire due to other users.
        account.floor = max(0, account.version - 10000)
        await db.flush()
        if account.floor:
            await db.execute(delete(ConversationChange).where(ConversationChange.user_id == user.id,
                ConversationChange.version <= account.floor))
            await db.execute(delete(ConversationEntry).where(ConversationEntry.user_id == user.id,
                ConversationEntry.deleted.is_(True), ConversationEntry.version <= account.floor))
    await db.flush()
    return len(dirty)


async def conversation_projection_loop():
    """Recover committed outbox rows from SQL/scripts and interrupted workers."""
    import asyncio
    import logging
    from hub.database import async_session
    while True:
        try:
            async with async_session() as db:
                db.sync_session.info["conversation_projecting"] = True
                count = await project_pending(db)
                await db.commit()
            await asyncio.sleep(0 if count == 500 else 0.5)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).exception("Conversation projection failed; outbox retained for retry")
            await asyncio.sleep(1)

"""Account-scoped conversation summaries and revision-based delta synchronization.

The client manifest is only a change detector, never an authorization source.
Membership is rechecked on every request, including deletion/revocation syncs.
No process-local cursor or event retention window is required.
"""

import datetime as dt
import hashlib
import json
from dataclasses import replace

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import JSON, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.auth_room import strongest_room_role, room_member_can_invite
from app.routers.dashboard import (
    _build_member_previews,
    _preview_for_record,
    load_agent_display_names,
    load_user_display_names,
)
from hub.database import get_db
from hub.models import Agent, MessageRecord, Room, RoomMember, User

router = APIRouter(prefix="/api/conversations", tags=["app-conversations"])


class ConversationSyncRequest(BaseModel):
    # Revisions survive reloads and identify deletions without trusting clocks.
    known: dict[str, str] = Field(default_factory=dict, max_length=20000)
    limit: int = Field(default=100, ge=1, le=200)


def iso(value):
    if value is None:
        return None
    return value.replace(tzinfo=value.tzinfo or dt.timezone.utc).astimezone(dt.timezone.utc).isoformat()


def enum_value(value):
    return value.value if hasattr(value, "value") else value


async def conversation_summaries(db: AsyncSession, ctx: RequestContext) -> list[dict]:
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
    canonical = (
        select(func.min(MessageRecord.id).label("id"))
        .where(MessageRecord.room_id.in_(room_ids),
               func.coalesce(message_type, "message").in_(["message", "system"]))
        .group_by(MessageRecord.room_id, MessageRecord.msg_id).subquery()
    )
    ranked = select(
        MessageRecord.id,
        func.row_number().over(partition_by=MessageRecord.room_id,
                               order_by=(MessageRecord.created_at.desc(), MessageRecord.id.desc())).label("rank"),
    ).where(MessageRecord.id.in_(select(canonical.c.id))).subquery()
    latest = {record.room_id: record for record in (await db.execute(
        select(MessageRecord).join(ranked, ranked.c.id == MessageRecord.id).where(ranked.c.rank == 1)
    )).scalars().all()}
    unread = dict((await db.execute(
        select(MessageRecord.room_id, func.count())
        .join(RoomMember, (RoomMember.room_id == MessageRecord.room_id) & (RoomMember.agent_id == ctx.human_id))
        .where(MessageRecord.id.in_(select(canonical.c.id)), MessageRecord.recalled_at.is_(None),
               MessageRecord.sender_id != ctx.human_id,
               (RoomMember.last_viewed_at.is_(None)) | (MessageRecord.created_at > RoomMember.last_viewed_at))
        .group_by(MessageRecord.room_id)
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


@router.post("/sync")
async def sync_conversations(body: ConversationSyncRequest, ctx: RequestContext = Depends(require_user),
                             db: AsyncSession = Depends(get_db)):
    user = await db.get(User, ctx.user_id)
    ctx = replace(ctx, human_id=user.human_id)
    summaries = await conversation_summaries(db, ctx)
    visible = {row["room_id"] for row in summaries}
    changes = [row for row in summaries if body.known.get(row["room_id"]) != row["revision"]]
    # Each subsequent batch submits the updated manifest. Unlike an offset
    # cursor, new activity between batches cannot cause a row to be skipped.
    return {
        "account_id": ctx.supabase_user_id,
        "human_id": ctx.human_id,
        "upserts": changes[:body.limit],
        "removed_ids": sorted(set(body.known) - visible),
        "has_more": len(changes) > body.limit,
    }

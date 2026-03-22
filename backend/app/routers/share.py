"""Share snapshot API route under /api/share."""

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import json

from app.helpers import extract_text_from_envelope
from hub.database import get_db
from hub.models import (
    Agent,
    MessageRecord,
    Room,
    RoomMember,
    Share,
    ShareMessage,
)
from sqlalchemy import func

router = APIRouter(prefix="/api/share", tags=["app-share"])


@router.get("/{share_id}")
async def get_share(
    share_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a share snapshot by share_id."""
    result = await db.execute(
        select(Share).where(Share.share_id == share_id)
    )
    share = result.scalar_one_or_none()
    if share is None:
        raise HTTPException(status_code=404, detail="Share not found")

    # Check expiry
    if share.expires_at is not None:
        now = datetime.datetime.now(datetime.timezone.utc)
        expires = share.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        if now > expires:
            raise HTTPException(status_code=410, detail="Share has expired")

    # Room info
    room_result = await db.execute(
        select(Room).where(Room.room_id == share.room_id)
    )
    room = room_result.scalar_one_or_none()

    # Share messages
    msg_result = await db.execute(
        select(ShareMessage)
        .where(ShareMessage.share_id == share_id)
        .order_by(ShareMessage.created_at)
    )
    share_messages = msg_result.scalars().all()

    # Member count for room
    member_count = 0
    if room:
        mc_result = await db.execute(
            select(func.count()).select_from(RoomMember).where(RoomMember.room_id == room.room_id)
        )
        member_count = mc_result.scalar() or 0

    messages = []
    for sm in share_messages:
        payload = {}
        if sm.payload_json:
            try:
                payload = json.loads(sm.payload_json)
            except (json.JSONDecodeError, TypeError):
                pass

        messages.append({
            "hub_msg_id": sm.hub_msg_id,
            "msg_id": sm.msg_id,
            "sender_id": sm.sender_id,
            "sender_name": sm.sender_name,
            "type": sm.type,
            "text": sm.text or "",
            "payload": payload,
            "created_at": sm.created_at.isoformat() if sm.created_at else None,
        })

    return {
        "share_id": share.share_id,
        "room": {
            "room_id": room.room_id if room else share.room_id,
            "name": room.name if room else "Unknown",
            "description": room.description if room else "",
            "member_count": member_count,
        },
        "messages": messages,
        "shared_by": share.shared_by_name or share.shared_by_agent_id,
        "shared_at": share.created_at.isoformat() if share.created_at else None,
    }

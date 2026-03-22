"""Share snapshot API route under /api/share."""

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.helpers import extract_text_from_envelope
from hub.database import get_db
from hub.models import (
    Agent,
    MessageRecord,
    Room,
    Share,
    ShareMessage,
)

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

    messages = []
    for sm in share_messages:
        messages.append({
            "msg_id": sm.msg_id,
            "sender_id": sm.sender_id,
            "sender_display_name": sm.sender_name,
            "text": sm.text or None,
            "type": sm.type,
            "created_at": sm.created_at.isoformat() if sm.created_at else None,
        })

    return {
        "share": {
            "share_id": share.share_id,
            "room_id": share.room_id,
            "shared_by_agent_id": share.shared_by_agent_id,
            "created_at": share.created_at.isoformat() if share.created_at else None,
            "expires_at": share.expires_at.isoformat() if share.expires_at else None,
        },
        "room": {
            "room_id": room.room_id if room else share.room_id,
            "name": room.name if room else "Unknown",
            "description": room.description if room else "",
        } if room else None,
        "messages": messages,
    }

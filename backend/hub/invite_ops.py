"""
[INPUT]: SQLAlchemy 会话与邀请/联系人/房间模型
[OUTPUT]: 邀请预览与兑换核心逻辑，供 Hub 层和 BFF 层共享
[POS]: 邀请领域服务层，收敛 invite 校验、兑换、计数等操作
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import RoomRole, SubscriptionStatus
from hub.models import Agent, AgentSubscription, Contact, Invite, InviteRedemption, Room, RoomMember
from hub.share_payloads import frontend_url, room_continue_url, room_entry_type


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _continue_url_for_invite(invite: Invite, room: Room | None = None) -> str:
    if invite.kind == "friend":
        return frontend_url("/chats/contacts/agents")
    if room is None or invite.room_id is None:
        return frontend_url("/chats/messages")
    return room_continue_url(invite.room_id)


def _invite_url(code: str) -> str:
    return frontend_url(f"/i/{code}")


def _serialize_invite_preview(invite: Invite, creator: Agent, room: Room | None, member_count: int = 0) -> dict:
    return {
        "code": invite.code,
        "kind": invite.kind,
        "entry_type": "friend_invite" if invite.kind == "friend" else room_entry_type(room).replace("private_room", "private_invite") if room else "private_invite",
        "target_type": "friend" if invite.kind == "friend" else "room",
        "target_id": creator.agent_id if invite.kind == "friend" else invite.room_id,
        "invite_url": _invite_url(invite.code),
        "continue_url": _continue_url_for_invite(invite, room),
        "expires_at": invite.expires_at.isoformat() if invite.expires_at else None,
        "max_uses": invite.max_uses,
        "use_count": invite.use_count,
        "creator": {
            "agent_id": creator.agent_id,
            "display_name": creator.display_name,
        },
        "room": None if room is None else {
            "room_id": room.room_id,
            "name": room.name,
            "description": room.description,
            "visibility": room.visibility.value,
            "join_mode": room.join_policy.value,
            "requires_payment": bool(room.required_subscription_product_id),
            "required_subscription_product_id": room.required_subscription_product_id,
            "member_count": member_count,
        },
    }


async def _load_invite_or_404(code: str, db: AsyncSession) -> Invite:
    result = await db.execute(select(Invite).where(Invite.code == code))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    return invite


def _ensure_invite_active(invite: Invite) -> None:
    if invite.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Invite has been revoked")
    expires_at = invite.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at is not None and _utc_now() > expires_at:
        raise HTTPException(status_code=410, detail="Invite has expired")
    if invite.use_count >= invite.max_uses:
        raise HTTPException(status_code=410, detail="Invite is no longer available")


async def _load_room_or_404(room_id: str, db: AsyncSession) -> Room:
    result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


async def _ensure_subscription_access(room: Room, agent_id: str, db: AsyncSession) -> None:
    if not room.required_subscription_product_id or room.owner_id == agent_id:
        return
    result = await db.execute(
        select(AgentSubscription).where(
            AgentSubscription.product_id == room.required_subscription_product_id,
            AgentSubscription.subscriber_agent_id == agent_id,
            AgentSubscription.status == SubscriptionStatus.active,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="Active subscription required to join this room")


async def _record_redemption(invite: Invite, redeemer_agent_id: str, db: AsyncSession) -> bool:
    db.add(InviteRedemption(code=invite.code, redeemer_agent_id=redeemer_agent_id))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        refreshed = await _load_invite_or_404(invite.code, db)
        invite.use_count = refreshed.use_count
        return False
    invite.use_count += 1
    await db.flush()
    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def preview_invite(code: str, db: AsyncSession) -> dict:
    """Load and serialize an invite preview (no auth required)."""
    invite = await _load_invite_or_404(code, db)
    _ensure_invite_active(invite)

    creator = await db.scalar(select(Agent).where(Agent.agent_id == invite.creator_agent_id))
    if creator is None:
        raise HTTPException(status_code=404, detail="Invite creator not found")

    room = None
    member_count = 0
    if invite.room_id:
        room = await _load_room_or_404(invite.room_id, db)
        member_count = await db.scalar(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == invite.room_id)
        ) or 0

    return _serialize_invite_preview(invite, creator=creator, room=room, member_count=member_count)


async def redeem_invite_for_agent(code: str, agent_id: str, db: AsyncSession) -> dict:
    """Core invite redemption logic shared by Hub and BFF layers."""
    invite = await _load_invite_or_404(code, db)

    if invite.kind == "friend":
        existing = await db.execute(
            select(Contact).where(
                Contact.owner_id == agent_id,
                Contact.contact_agent_id == invite.creator_agent_id,
            )
        )
        if existing.scalar_one_or_none() is not None:
            return {
                "status": "already_connected",
                "kind": "friend",
                "target_type": "friend",
                "target_id": invite.creator_agent_id,
                "continue_url": _continue_url_for_invite(invite),
            }
        if invite.creator_agent_id == agent_id:
            raise HTTPException(status_code=400, detail="You cannot use your own friend invite")
        _ensure_invite_active(invite)
        db.add(Contact(owner_id=agent_id, contact_agent_id=invite.creator_agent_id))
        db.add(Contact(owner_id=invite.creator_agent_id, contact_agent_id=agent_id))
        await _record_redemption(invite, agent_id, db)
        await db.commit()
        return {
            "status": "redeemed",
            "kind": "friend",
            "target_type": "friend",
            "target_id": invite.creator_agent_id,
            "continue_url": _continue_url_for_invite(invite),
        }

    # Room invite
    room = await _load_room_or_404(invite.room_id or "", db)
    existing_member = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room.room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    if existing_member.scalar_one_or_none() is not None:
        return {
            "status": "already_joined",
            "kind": "room",
            "target_type": "room",
            "target_id": room.room_id,
            "continue_url": _continue_url_for_invite(invite, room),
        }

    _ensure_invite_active(invite)
    await _ensure_subscription_access(room, agent_id, db)

    if room.max_members is not None:
        member_count = await db.scalar(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == room.room_id)
        ) or 0
        if member_count >= room.max_members:
            raise HTTPException(status_code=409, detail="Room is full")

    db.add(
        RoomMember(
            room_id=room.room_id,
            agent_id=agent_id,
            role=RoomRole.member,
        )
    )
    await _record_redemption(invite, agent_id, db)
    await db.commit()
    return {
        "status": "redeemed",
        "kind": "room",
        "target_type": "room",
        "target_id": room.room_id,
        "continue_url": _continue_url_for_invite(invite, room),
    }

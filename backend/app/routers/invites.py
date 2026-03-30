"""
[INPUT]: 依赖 app.auth 的 active agent 上下文、SQLAlchemy 会话与邀请/联系人/房间模型完成邀请闭环
[OUTPUT]: 对外提供 /api/invites 路由，支持好友邀请、群邀请、公开预览、兑换与撤销
[POS]: app BFF 邀请入口，把内部关系与 room membership 操作收敛成 URL 驱动流程
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import datetime
import uuid as _uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub.config import FRONTEND_BASE_URL
from hub.database import get_db
from hub.enums import RoomRole, RoomVisibility, SubscriptionStatus
from hub.invite_ops import preview_invite, redeem_invite_for_agent
from hub.models import Agent, AgentSubscription, Contact, Invite, InviteRedemption, Room, RoomMember
from hub.share_payloads import frontend_url, room_continue_url, room_entry_type

router = APIRouter(prefix="/api/invites", tags=["app-invites"])


class CreateInviteBody(BaseModel):
    expires_in_hours: int | None = 168
    max_uses: int = 1

def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


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
            "member_count": member_count,
        },
    }


def _continue_url_for_invite(invite: Invite, room: Room | None = None) -> str:
    if invite.kind == "friend":
        return frontend_url("/chats/contacts/agents")
    if room is None or invite.room_id is None:
        return frontend_url("/chats/messages")
    return room_continue_url(invite.room_id)


def _can_invite(room: Room, member: RoomMember) -> bool:
    if member.role == RoomRole.owner:
        return True
    if member.can_invite is not None:
        return member.can_invite
    if member.role == RoomRole.admin:
        return True
    return room.default_invite


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


async def _load_membership(room_id: str, agent_id: str, db: AsyncSession) -> RoomMember:
    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=403, detail="Not a member of this room")
    return member


@router.post("/friends", status_code=201)
async def create_friend_invite(
    body: CreateInviteBody | None = None,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    payload = body or CreateInviteBody()
    invite = Invite(
        code=f"iv_{_uuid.uuid4().hex[:20]}",
        kind="friend",
        creator_agent_id=ctx.active_agent_id,
        expires_at=_utc_now() + datetime.timedelta(hours=payload.expires_in_hours) if payload.expires_in_hours else None,
        max_uses=max(1, payload.max_uses),
    )
    db.add(invite)
    await db.commit()
    creator = await db.scalar(select(Agent).where(Agent.agent_id == ctx.active_agent_id))
    return _serialize_invite_preview(invite, creator=creator, room=None)


@router.post("/rooms/{room_id}", status_code=201)
async def create_room_invite(
    room_id: str,
    body: CreateInviteBody | None = None,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    payload = body or CreateInviteBody()
    room = await _load_room_or_404(room_id, db)
    inviter = await _load_membership(room_id, ctx.active_agent_id, db)
    if not _can_invite(room, inviter):
        raise HTTPException(status_code=403, detail="You do not have invite permission")

    invite = Invite(
        code=f"iv_{_uuid.uuid4().hex[:20]}",
        kind="room",
        creator_agent_id=ctx.active_agent_id,
        room_id=room_id,
        expires_at=_utc_now() + datetime.timedelta(hours=payload.expires_in_hours) if payload.expires_in_hours else None,
        max_uses=max(1, payload.max_uses),
    )
    db.add(invite)
    await db.commit()

    creator = await db.scalar(select(Agent).where(Agent.agent_id == ctx.active_agent_id))
    member_count = await db.scalar(select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)) or 0
    return _serialize_invite_preview(invite, creator=creator, room=room, member_count=member_count)


@router.get("/{code}")
async def get_invite(
    code: str,
    db: AsyncSession = Depends(get_db),
):
    return await preview_invite(code, db)


@router.post("/{code}/redeem")
async def redeem_invite(
    code: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    return await redeem_invite_for_agent(code, ctx.active_agent_id, db)


@router.delete("/{code}")
async def revoke_invite(
    code: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    invite = await _load_invite_or_404(code, db)
    if invite.creator_agent_id != ctx.active_agent_id:
        raise HTTPException(status_code=403, detail="You cannot revoke this invite")
    _ensure_invite_active(invite)
    invite.revoked_at = _utc_now()
    await db.commit()
    return {"code": invite.code, "revoked": True}

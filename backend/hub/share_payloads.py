"""
[INPUT]: 依赖 hub.config 的前端基址与 Room/Share 领域模型，统一计算分享与邀请的外部 URL/entry_type
[OUTPUT]: 对外提供 share/invite 公共 payload helper，收敛 link_url、continue_url、entry_type 等字段拼装
[POS]: hub 层分享语义中枢，被 app BFF 与 legacy hub 路由共同依赖，避免双份响应结构漂移
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

from hub.config import FRONTEND_BASE_URL
from hub.enums import RoomVisibility
from hub.models import Room


def frontend_url(path: str) -> str:
    return f"{FRONTEND_BASE_URL.rstrip('/')}{path}"


def room_entry_type(room: Room | None) -> str:
    if room is None:
        return "public_room"
    if room.required_subscription_product_id:
        return "paid_room"
    return "public_room" if room.visibility == RoomVisibility.public else "private_room"


def share_link_url(share_id: str) -> str:
    return frontend_url(f"/share/{share_id}")


def room_continue_url(room_id: str) -> str:
    return frontend_url(f"/chats/messages/{room_id}")


def share_create_payload(share_id: str, room: Room, created_at: str, expires_at: str | None) -> dict:
    return {
        "share_id": share_id,
        "share_url": f"/share/{share_id}",
        "link_url": share_link_url(share_id),
        "entry_type": room_entry_type(room),
        "required_subscription_product_id": room.required_subscription_product_id,
        "target_type": "room",
        "target_id": room.room_id,
        "continue_url": room_continue_url(room.room_id),
        "created_at": created_at,
        "expires_at": expires_at,
    }


def share_public_payload(
    *,
    share_id: str,
    room_id: str,
    room_name: str,
    room_description: str,
    member_count: int,
    shared_by: str,
    shared_at: str | None,
    messages: list[dict],
    room: Room | None,
) -> dict:
    return {
        "share_id": share_id,
        "room": {
            "room_id": room.room_id if room else room_id,
            "name": room.name if room else room_name,
            "description": room.description if room else room_description,
            "member_count": member_count,
            "visibility": room.visibility.value if room else None,
            "join_mode": room.join_policy.value if room else None,
            "requires_payment": bool(room.required_subscription_product_id) if room else False,
            "required_subscription_product_id": room.required_subscription_product_id if room else None,
        },
        "messages": messages,
        "shared_by": shared_by,
        "shared_at": shared_at,
        "entry_type": room_entry_type(room),
        "continue_url": room_continue_url(room_id),
        "link_url": share_link_url(share_id),
    }

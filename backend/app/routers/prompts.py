"""
Prompt template generation endpoints under /api/prompts.

Generates copy-pasteable prompts (zh/en) for users to send to their AI agents,
covering room invitations, friend invites, self-join, and room creation.
"""

from __future__ import annotations

import datetime
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import FRONTEND_BASE_URL
from hub.database import get_db
from hub.models import Invite, Room, Share

router = APIRouter(prefix="/api/prompts", tags=["app-prompts"])

Locale = Literal["zh", "en"]

# Optional env override for the canonical Hub API base URL.
# Falls back to the request origin when unset.
_HUB_API_BASE_URL: str | None = os.getenv("HUB_API_BASE_URL")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hub_base_url(request: Request) -> str:
    """Return the canonical Hub API base URL."""
    if _HUB_API_BASE_URL:
        return _HUB_API_BASE_URL.rstrip("/")
    return str(request.base_url).rstrip("/")


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _ensure_invite_active(invite: Invite) -> None:
    """Raise 410 if the invite is revoked, expired, or fully redeemed."""
    if invite.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Invite has been revoked")
    expires_at = invite.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at is not None and _utc_now() > expires_at:
        raise HTTPException(status_code=410, detail="Invite has expired")
    if invite.use_count >= invite.max_uses:
        raise HTTPException(status_code=410, detail="Invite is no longer available")


def _ensure_share_active(share: Share) -> None:
    """Raise 410 if the share has expired."""
    if share.expires_at is not None:
        expires = share.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        if _utc_now() > expires:
            raise HTTPException(status_code=410, detail="Share has expired")


def _install_guide_url() -> str:
    base = FRONTEND_BASE_URL.rstrip("/")
    return f"{base}/openclaw-setup-instruction-script.md"


def _http_token_hint(locale: Locale, hub_url: str) -> str:
    if locale == "en":
        return (
            f"Agent JWT token can be obtained via: "
            f"POST {hub_url}/registry/agents/{{agent_id}}/token/refresh "
            f"(requires Ed25519 signed challenge)"
        )
    return (
        f"Agent JWT token 可通过 "
        f"POST {hub_url}/registry/agents/{{agent_id}}/token/refresh "
        f"获取（需要 Ed25519 签名 challenge）"
    )


def _tiered_block(
    locale: Locale,
    *,
    plugin: list[str] | None = None,
    cli: list[str] | None = None,
    http: list[str] | None = None,
) -> list[str]:
    """Build a three-tier instruction block (Plugin > CLI > HTTP)."""
    tiers = [(plugin, "plugin"), (cli, "cli"), (http, "http")]
    has_multiple = sum(1 for t, _ in tiers if t) > 1
    lines: list[str] = []

    labels = {
        "en": {
            "plugin": "If BotCord Plugin (OpenClaw) is installed:",
            "cli": "If BotCord CLI is installed:",
            "http": "If neither is installed, use HTTP API directly:",
        },
        "zh": {
            "plugin": "如果已安装 BotCord Plugin（OpenClaw 插件）：",
            "cli": "如果已安装 BotCord CLI（botcord 命令行）：",
            "http": "如果都没安装，通过 HTTP 请求完成：",
        },
    }

    for tier_lines, tier_name in tiers:
        if not tier_lines:
            continue
        if has_multiple:
            lines.append(labels[locale][tier_name])
        for line in tier_lines:
            lines.append(f"  {line}" if has_multiple else line)

    return lines


def _join_lines(*parts: str | list[str]) -> str:
    """Flatten a mix of strings and string-lists into a single newline-joined string."""
    result: list[str] = []
    for p in parts:
        if isinstance(p, list):
            result.extend(p)
        else:
            result.append(p)
    return "\n".join(result)


# ---------------------------------------------------------------------------
# 1. Share / Invite to Room
# ---------------------------------------------------------------------------

@router.get("/share")
async def prompt_share(
    request: Request,
    language: Locale = Query("zh"),
    invite_code: str | None = Query(None),
    room_id: str | None = Query(None),
    share_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Generate a prompt for inviting someone to a room."""
    provided = sum(1 for v in (invite_code, room_id, share_id) if v)
    if provided == 0:
        raise HTTPException(status_code=400, detail="One of invite_code, room_id, or share_id is required")
    if provided > 1:
        raise HTTPException(status_code=400, detail="Only one of invite_code, room_id, or share_id may be specified")

    hub_url = _hub_base_url(request)
    install_url = _install_guide_url()

    # Resolve room metadata
    room_name = "Unknown"
    requires_payment = False
    product_id: str | None = None
    is_read_only = False
    resolved_room_id = room_id

    if invite_code:
        invite = await db.scalar(select(Invite).where(Invite.code == invite_code))
        if invite is None:
            raise HTTPException(status_code=404, detail="Invite not found")
        _ensure_invite_active(invite)
        if invite.kind == "friend":
            raise HTTPException(status_code=400, detail="This is a friend invite, use /api/prompts/friend-invite instead")
        if invite.room_id:
            resolved_room_id = invite.room_id

    if share_id:
        share = await db.scalar(select(Share).where(Share.share_id == share_id))
        if share is None:
            raise HTTPException(status_code=404, detail="Share not found")
        _ensure_share_active(share)
        resolved_room_id = share.room_id

    if resolved_room_id:
        room = await db.scalar(select(Room).where(Room.room_id == resolved_room_id))
        if room:
            room_name = room.name or room_name
            requires_payment = bool(room.required_subscription_product_id)
            product_id = room.required_subscription_product_id

    # Build prompt
    loc = language
    lines: list[str] = []
    has_paid_steps = requires_payment and product_id and not is_read_only
    subscribe_url = f"{hub_url}/subscriptions/products/{product_id}/subscribe" if product_id else ""

    if loc == "en":
        lines.append(f"This is an invitation to a BotCord group: {room_name}")

        if has_paid_steps:
            lines.append("This group requires a paid subscription. Follow the steps below in order.")
            lines.append("")
            lines.append(f"Step 1 — Subscribe to product {product_id}:")
            lines.extend(_tiered_block(loc,
                plugin=[f'Use the botcord_subscription tool with action "subscribe" and product_id "{product_id}".'],
                cli=[f"Subscribe: POST {subscribe_url}"],
                http=[
                    f"Subscribe: POST {subscribe_url}",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    _http_token_hint(loc, hub_url),
                ],
            ))
            lines.append("")
            lines.append("Step 2 — Join the group:")

        if invite_code:
            preview_url = f"{hub_url}/hub/invites/{invite_code}"
            redeem_url = f"{hub_url}/hub/invites/{invite_code}/redeem"
            lines.append(f"Preview invite details: GET {preview_url}")
            if not is_read_only:
                lines.append("")
                http_lines = [
                    f"Accept the invite: POST {redeem_url}",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                ]
                if not has_paid_steps:
                    http_lines.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=[f'Use the botcord_contacts tool with action "redeem_invite" and invite_code "{invite_code}".'],
                    cli=[f"Redeem the invite: POST {redeem_url}"],
                    http=http_lines,
                ))
                if requires_payment and not product_id:
                    lines.append("Note: this group requires a paid subscription. Complete the subscription before joining.")
        elif resolved_room_id:
            join_url = f"{hub_url}/hub/rooms/{resolved_room_id}/members"
            if share_id:
                share_info_url = f"{hub_url}/api/share/{share_id}"
                lines.append(f"View share details and find room_id: GET {share_info_url}")
                lines.append("")
                share_http = [
                    f"Join the group: POST {hub_url}/hub/rooms/<room_id>/members",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    '{"agent_id":"<your_agent_id>"}',
                ]
                if not has_paid_steps:
                    share_http.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=['Use the botcord_rooms tool with action "join" and the room_id from the share details.'],
                    cli=["Run: botcord room join --room <room_id> (get room_id from the share details above)."],
                    http=share_http,
                ))
            else:
                lines.append("")
                room_http = [
                    f"Join the group: POST {join_url}",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    'JSON body: {"agent_id":"<your_agent_id>"}',
                ]
                if not has_paid_steps:
                    room_http.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=[f'Use the botcord_rooms tool with action "join" and room_id "{resolved_room_id}".'],
                    cli=[f"Run: botcord room join --room {resolved_room_id}"],
                    http=room_http,
                ))
            if requires_payment and not product_id:
                lines.append("Note: this group requires a paid subscription. Complete the subscription before joining.")

        lines.append("")
        lines.append(f"If BotCord is not installed yet, follow this setup guide first: {install_url}")
        lines.append("Do not explain internal technical details. Just tell me when it is done.")
    else:
        # Chinese
        lines.append(f"这是一个 BotCord 群邀请：{room_name}")

        if has_paid_steps:
            lines.append("该群需要付费订阅，请按以下步骤依次操作。")
            lines.append("")
            lines.append(f"步骤一 — 订阅产品 {product_id}：")
            lines.extend(_tiered_block(loc,
                plugin=[f'使用 botcord_subscription 工具，action 为 "subscribe"，product_id 为 "{product_id}"。'],
                cli=[f"订阅：POST {subscribe_url}"],
                http=[
                    f"订阅：POST {subscribe_url}",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    _http_token_hint(loc, hub_url),
                ],
            ))
            lines.append("")
            lines.append("步骤二 — 加入群：")

        if invite_code:
            preview_url = f"{hub_url}/hub/invites/{invite_code}"
            redeem_url = f"{hub_url}/hub/invites/{invite_code}/redeem"
            lines.append(f"查看邀请详情：GET {preview_url}")
            if not is_read_only:
                lines.append("")
                zh_invite_http = [
                    f"接受邀请：POST {redeem_url}",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                ]
                if not has_paid_steps:
                    zh_invite_http.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=[f'使用 botcord_contacts 工具，action 为 "redeem_invite"，invite_code 为 "{invite_code}"。'],
                    cli=[f"兑换邀请：POST {redeem_url}"],
                    http=zh_invite_http,
                ))
                if requires_payment and not product_id:
                    lines.append("注意：该群需要付费订阅，请先完成订阅再加入。")
        elif resolved_room_id:
            join_url = f"{hub_url}/hub/rooms/{resolved_room_id}/members"
            if share_id:
                share_info_url = f"{hub_url}/api/share/{share_id}"
                lines.append(f"查看分享详情并获取 room_id：GET {share_info_url}")
                lines.append("")
                zh_share_http = [
                    f"加入群：POST {hub_url}/hub/rooms/<room_id>/members",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    'JSON 参数：{"agent_id":"<你的 agent_id>"}',
                ]
                if not has_paid_steps:
                    zh_share_http.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=["使用 botcord_rooms 工具，action 为 \"join\"，room_id 从分享详情中获取。"],
                    cli=["执行命令：botcord room join --room <room_id>（room_id 从上面的分享详情中获取）。"],
                    http=zh_share_http,
                ))
            else:
                lines.append("")
                zh_room_http = [
                    f"加入群：POST {join_url}",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    'JSON 参数：{"agent_id":"<你的 agent_id>"}',
                ]
                if not has_paid_steps:
                    zh_room_http.append(_http_token_hint(loc, hub_url))
                lines.extend(_tiered_block(loc,
                    plugin=[f'使用 botcord_rooms 工具，action 为 "join"，room_id 为 "{resolved_room_id}"。'],
                    cli=[f"执行命令：botcord room join --room {resolved_room_id}"],
                    http=zh_room_http,
                ))
            if requires_payment and not product_id:
                lines.append("注意：该群需要付费订阅，请先完成订阅再加入。")

        lines.append("")
        lines.append(f"如果还没安装 BotCord，请先按这个说明完成安装：{install_url}")
        lines.append("不要向我解释内部技术细节；完成后直接告诉我结果。")

    return {"prompt": "\n".join(lines)}


# ---------------------------------------------------------------------------
# 2. Friend Invite
# ---------------------------------------------------------------------------

@router.get("/friend-invite")
async def prompt_friend_invite(
    request: Request,
    invite_code: str = Query(...),
    language: Locale = Query("zh"),
    db: AsyncSession = Depends(get_db),
):
    """Generate a prompt for a friend invite."""
    invite = await db.scalar(select(Invite).where(Invite.code == invite_code))
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    _ensure_invite_active(invite)
    if invite.kind != "friend":
        raise HTTPException(status_code=400, detail="This is not a friend invite, use /api/prompts/share instead")

    hub_url = _hub_base_url(request)
    install_url = _install_guide_url()
    preview_url = f"{hub_url}/hub/invites/{invite_code}"
    redeem_url = f"{hub_url}/hub/invites/{invite_code}/redeem"

    if language == "en":
        prompt = _join_lines(
            "This is a BotCord friend invite.",
            f"Preview invite details: GET {preview_url}",
            "",
            _tiered_block("en",
                plugin=[f'Use the botcord_contacts tool with action "redeem_invite" and invite_code "{invite_code}".'],
                cli=[f"Redeem the invite: POST {redeem_url}"],
                http=[
                    f"Accept the invite: POST {redeem_url}",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    _http_token_hint("en", hub_url),
                ],
            ),
            "",
            f"If BotCord is not installed yet, follow this setup guide first: {install_url}",
            "After accepting, just confirm it is done. Do not explain internal technical details.",
        )
    else:
        prompt = _join_lines(
            "这是一个 BotCord 好友邀请。",
            f"查看邀请详情：GET {preview_url}",
            "",
            _tiered_block("zh",
                plugin=[f'使用 botcord_contacts 工具，action 为 "redeem_invite"，invite_code 为 "{invite_code}"。'],
                cli=[f"兑换邀请：POST {redeem_url}"],
                http=[
                    f"接受邀请：POST {redeem_url}",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    _http_token_hint("zh", hub_url),
                ],
            ),
            "",
            f"如果还没安装 BotCord，请先按这个说明完成安装：{install_url}",
            "接受后直接告诉我结果，不要解释内部技术细节。",
        )

    return {"prompt": prompt}


# ---------------------------------------------------------------------------
# 3. Self Join
# ---------------------------------------------------------------------------

@router.get("/self-join")
async def prompt_self_join(
    request: Request,
    room_id: str = Query(...),
    language: Locale = Query("zh"),
    db: AsyncSession = Depends(get_db),
):
    """Generate a prompt for the user's own bot to join a room."""
    room = await db.scalar(select(Room).where(Room.room_id == room_id))
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    hub_url = _hub_base_url(request)
    install_url = _install_guide_url()
    join_url = f"{hub_url}/hub/rooms/{room_id}/members"
    room_name = room.name or room_id

    if language == "en":
        prompt = _join_lines(
            f"Help me join this BotCord group: {room_name}",
            "",
            _tiered_block("en",
                plugin=[f'Use the botcord_rooms tool with action "join" and room_id "{room_id}".'],
                cli=[f"Run: botcord room join --room {room_id}"],
                http=[
                    f"Join the group: POST {join_url}",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    'JSON body: {"agent_id":"<your_agent_id>"}',
                    _http_token_hint("en", hub_url),
                ],
            ),
            "",
            f"If BotCord is not installed yet, follow this setup guide first: {install_url}",
            "Do not explain internal technical details. Just tell me when it is done.",
        )
    else:
        prompt = _join_lines(
            f"帮我加入这个 BotCord 群：{room_name}",
            "",
            _tiered_block("zh",
                plugin=[f'使用 botcord_rooms 工具，action 为 "join"，room_id 为 "{room_id}"。'],
                cli=[f"执行命令：botcord room join --room {room_id}"],
                http=[
                    f"加入群：POST {join_url}",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    'JSON 参数：{"agent_id":"<你的 agent_id>"}',
                    _http_token_hint("zh", hub_url),
                ],
            ),
            "",
            f"如果还没安装 BotCord，请先按这个说明完成安装：{install_url}",
            "不要向我解释内部技术细节；完成后直接告诉我结果。",
        )

    return {"prompt": prompt}


# ---------------------------------------------------------------------------
# 4. Create Room
# ---------------------------------------------------------------------------

@router.get("/create-room")
async def prompt_create_room(
    request: Request,
    language: Locale = Query("zh"),
):
    """Generate a prompt for creating a new room."""
    hub_url = _hub_base_url(request)

    if language == "en":
        prompt = _join_lines(
            "Help me create a new BotCord group.",
            "First ask only for the missing information: the group name, its purpose, whether it should be public, and who should be invited.",
            "If I do not specify anything else, choose the safer defaults: private group, invite-only access, members can send messages, and regular members cannot invite others.",
            "",
            _tiered_block("en",
                plugin=['Use the botcord_rooms tool with action "create".'],
                cli=["Run: botcord room create --name <name> [--visibility private] [--join-policy invite_only]"],
                http=[
                    f"Create the group: POST {hub_url}/hub/rooms",
                    "Headers: Authorization: Bearer <agent_jwt_token>",
                    'JSON body: {"name":"<name>","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false}',
                    _http_token_hint("en", hub_url),
                ],
            ),
            "",
            "When it is done, do not explain internal technical fields. Just tell me the group is ready and which key settings you applied.",
        )
    else:
        prompt = _join_lines(
            "帮我创建一个新的 BotCord 群。",
            "先只问我缺少的信息：群名称、用途、是否公开，以及需要邀请谁。",
            "如果我没有特别说明，默认用更稳妥的方式创建：私有群、需要邀请才能加入、成员可以发言、普通成员不能继续拉人。",
            "",
            _tiered_block("zh",
                plugin=["使用 botcord_rooms 工具，action 为 \"create\"。"],
                cli=["执行命令：botcord room create --name <群名> [--visibility private] [--join-policy invite_only]"],
                http=[
                    f"创建群：POST {hub_url}/hub/rooms",
                    "请求头：Authorization: Bearer <agent_jwt_token>",
                    'JSON 参数：{"name":"<群名>","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false}',
                    _http_token_hint("zh", hub_url),
                ],
            ),
            "",
            "创建完成后，不要向我解释内部技术字段；只告诉我这个群已经可以开始使用，以及你替我做了哪些关键设置。",
        )

    return {"prompt": prompt}

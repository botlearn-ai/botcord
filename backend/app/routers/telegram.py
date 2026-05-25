"""Telegram helper endpoints for dashboard gateway setup."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.auth import RequestContext, require_user

router = APIRouter(prefix="/api/telegram", tags=["app-telegram"])


class TelegramChatIdsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    bot_token: str = Field(default="", alias="botToken")
    timeout_seconds: int = Field(default=0, alias="timeoutSeconds")


def _chat_label(chat: dict[str, Any]) -> str:
    name = " ".join(str(chat.get(k) or "") for k in ("first_name", "last_name")).strip()
    username = f"@{chat['username']}" if chat.get("username") else ""
    if chat.get("title") and username:
        return f"{chat['title']} {username}"
    return str(chat.get("title") or username or name or chat.get("id") or "")


def _sender_label(sender: dict[str, Any]) -> str:
    name = " ".join(str(sender.get(k) or "") for k in ("first_name", "last_name")).strip()
    username = f"@{sender['username']}" if sender.get("username") else ""
    return str(username or name or sender.get("id") or "")


@router.post("/chat-ids")
async def discover_telegram_chat_ids(
    body: TelegramChatIdsRequest,
    _ctx: RequestContext = Depends(require_user),
) -> JSONResponse:
    bot_token = body.bot_token.strip()
    if not bot_token:
        return JSONResponse({"error": "missing_bot_token"}, status_code=400)

    timeout_seconds = min(max(int(body.timeout_seconds or 0), 0), 10)
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds + 10) as client:
            response = await client.post(
                f"https://api.telegram.org/bot{bot_token}/getUpdates",
                params={"timeout": timeout_seconds} if timeout_seconds > 0 else None,
            )
    except Exception as exc:
        return JSONResponse(
            {"error": "telegram_unreachable", "message": str(exc)},
            status_code=502,
        )

    try:
        parsed = response.json() if response.content else {}
    except Exception:
        parsed = {}
    data = parsed if isinstance(parsed, dict) else {}
    if response.status_code >= 400 or data.get("ok") is False:
        return JSONResponse(
            {
                "error": "telegram_get_updates_failed",
                "message": data.get("description") or f"Telegram HTTP {response.status_code}",
            },
            status_code=400,
        )

    chats_by_id: dict[str, dict[str, str | None]] = {}
    senders_by_id: dict[str, dict[str, str | None]] = {}
    for update in data.get("result") or []:
        if not isinstance(update, dict):
            continue
        message = (
            update.get("message")
            or update.get("edited_message")
            or update.get("channel_post")
            or update.get("edited_channel_post")
        )
        if not isinstance(message, dict):
            continue
        chat = message.get("chat")
        if isinstance(chat, dict) and chat.get("id") is not None:
            chat_id = str(chat["id"])
            chats_by_id[chat_id] = {
                "id": chat_id,
                "type": str(chat["type"]) if chat.get("type") is not None else None,
                "label": _chat_label(chat) or None,
            }
        sender = message.get("from")
        if isinstance(sender, dict) and sender.get("id") is not None:
            sender_id = str(sender["id"])
            senders_by_id[sender_id] = {
                "id": sender_id,
                "label": _sender_label(sender) or None,
            }

    return JSONResponse({
        "chats": list(chats_by_id.values()),
        "senders": list(senders_by_id.values()),
    })

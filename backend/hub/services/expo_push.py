"""Expo push notifications for Human recipients (mobile client).

Hooked next to the Supabase realtime publish for new-message events: when a
``message`` event targets a ``hu_*`` participant, every Expo push token of the
owning User receives a notification. Delivery is fire-and-forget — failures
are logged and never affect message routing.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from sqlalchemy import delete, select

from hub import config as hub_config
from hub.database import async_session
from hub.models import PushToken, Room, User

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_PUSH_BATCH_SIZE = 100
EXPO_PUSH_TIMEOUT_SECONDS = 5.0
PUSH_BODY_MAX_CHARS = 140

# Strong refs so fire-and-forget tasks are not garbage-collected mid-flight.
_background_tasks: set[asyncio.Task] = set()


def schedule_message_push(event: dict[str, Any]) -> None:
    """Schedule an Expo push for a realtime new-message event, if applicable.

    Only ``type == "message"`` events addressed to a Human (``hu_*``) whose
    sender is not that same Human are pushed. Never raises.
    """
    if not hub_config.EXPO_PUSH_ENABLED:
        return
    if event.get("type") != "message":
        return
    recipient = event.get("agent_id")
    if not isinstance(recipient, str) or not recipient.startswith("hu_"):
        return
    ext = event.get("ext") or {}
    if ext.get("sender_id") == recipient:
        return
    try:
        task = asyncio.get_running_loop().create_task(_push_for_event(event))
    except RuntimeError:
        return
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _truncate(text: str, limit: int = PUSH_BODY_MAX_CHARS) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def _push_for_event(event: dict[str, Any]) -> None:
    try:
        recipient = event["agent_id"]
        ext = event.get("ext") or {}
        room_id = event.get("room_id")
        async with async_session() as db:
            user = await db.scalar(select(User).where(User.human_id == recipient))
            if user is None:
                return
            # The Human acting through one of their agents on the dashboard
            # is still a self-send.
            if ext.get("source_user_id") and ext["source_user_id"] == str(user.id):
                return
            tokens = list(
                (
                    await db.execute(
                        select(PushToken.token).where(PushToken.user_id == user.id)
                    )
                ).scalars().all()
            )
            if not tokens:
                return
            title = ext.get("sender_name")
            if not title and room_id:
                title = await db.scalar(select(Room.name).where(Room.room_id == room_id))

        body = _truncate(ext.get("preview") or "") or "New message"
        messages = [
            {
                "to": token,
                "title": title or "BotCord",
                "body": body,
                "data": {"room_id": room_id, "hub_msg_id": event.get("hub_msg_id")},
                "sound": "default",
            }
            for token in tokens
        ]
        dead = await send_expo_push(messages)
        if dead:
            async with async_session() as db:
                await db.execute(delete(PushToken).where(PushToken.token.in_(dead)))
                await db.commit()
    except Exception:
        logger.exception(
            "Expo push failed: recipient=%s hub_msg_id=%s",
            event.get("agent_id"),
            event.get("hub_msg_id"),
        )


async def send_expo_push(
    messages: list[dict[str, Any]],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[str]:
    """POST messages to Expo in batches; return tokens Expo reports as
    ``DeviceNotRegistered``."""
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if hub_config.EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {hub_config.EXPO_ACCESS_TOKEN}"

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=EXPO_PUSH_TIMEOUT_SECONDS)
    dead: list[str] = []
    try:
        for i in range(0, len(messages), EXPO_PUSH_BATCH_SIZE):
            batch = messages[i : i + EXPO_PUSH_BATCH_SIZE]
            try:
                resp = await client.post(EXPO_PUSH_URL, json=batch, headers=headers)
                resp.raise_for_status()
                tickets = resp.json().get("data") or []
            except Exception as exc:
                logger.warning("Expo push batch failed: size=%d err=%s", len(batch), exc)
                continue
            for msg, ticket in zip(batch, tickets):
                if not isinstance(ticket, dict) or ticket.get("status") != "error":
                    continue
                details = ticket.get("details") or {}
                if details.get("error") == "DeviceNotRegistered":
                    dead.append(msg["to"])
                else:
                    logger.warning("Expo push ticket error: %s", ticket.get("message"))
    finally:
        if owns_client:
            await client.aclose()
    return dead

"""Ephemeral message-level status reactions backed by Redis.

Used for short-lived BotCord internal room states such as "agent is
replying". These are not durable user reactions; losing them on Redis restart
is acceptable and preferable to a stuck UI.
"""

from __future__ import annotations

import datetime
import json
import logging
from typing import Any

from hub.owner_chat_cache import get_redis

logger = logging.getLogger(__name__)

DEFAULT_STATUS_TTL_SECONDS = 180
MIN_STATUS_TTL_SECONDS = 5
MAX_STATUS_TTL_SECONDS = 600
DEFAULT_REPLYING_EMOJI = "⏳"
REPLYING_KIND = "replying"


def clamp_ttl(ttl_sec: int | None) -> int:
    raw = ttl_sec if isinstance(ttl_sec, int) else DEFAULT_STATUS_TTL_SECONDS
    return max(MIN_STATUS_TTL_SECONDS, min(MAX_STATUS_TTL_SECONDS, raw))


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _reaction_key(room_id: str, msg_id: str, actor_id: str, kind: str) -> str:
    return f"message_status_reaction:{room_id}:{msg_id}:{actor_id}:{kind}"


def _room_index_key(room_id: str) -> str:
    return f"message_status_reactions:room:{room_id}"


def _json_loads(raw: str | bytes | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (TypeError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


async def set_status_reaction(
    *,
    room_id: str,
    msg_id: str,
    actor_id: str,
    actor_name: str | None,
    kind: str,
    emoji: str,
    turn_id: str,
    ttl_sec: int | None = None,
) -> dict[str, Any]:
    ttl = clamp_ttl(ttl_sec)
    expires_at = _now() + datetime.timedelta(seconds=ttl)
    payload: dict[str, Any] = {
        "room_id": room_id,
        "msg_id": msg_id,
        "actor_id": actor_id,
        "actor_name": actor_name,
        "kind": kind,
        "emoji": emoji,
        "state": "active",
        "turn_id": turn_id,
        "expires_at": expires_at.isoformat(),
    }

    client = get_redis()
    if client is None:
        return payload

    key = _reaction_key(room_id, msg_id, actor_id, kind)
    index_key = _room_index_key(room_id)
    try:
        await client.set(key, json.dumps(payload, ensure_ascii=False), ex=ttl)
        await client.sadd(index_key, key)
        await client.expire(index_key, ttl + 60)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "message_status_reactions.set failed room=%s msg=%s actor=%s kind=%s: %s",
            room_id,
            msg_id,
            actor_id,
            kind,
            exc,
        )
    return payload


async def clear_status_reaction(
    *,
    room_id: str,
    msg_id: str,
    actor_id: str,
    kind: str,
    turn_id: str,
) -> dict[str, Any] | None:
    payload: dict[str, Any] = {
        "room_id": room_id,
        "msg_id": msg_id,
        "actor_id": actor_id,
        "kind": kind,
        "state": "cleared",
        "turn_id": turn_id,
    }

    client = get_redis()
    if client is None:
        return payload

    key = _reaction_key(room_id, msg_id, actor_id, kind)
    index_key = _room_index_key(room_id)
    try:
        existing = _json_loads(await client.get(key))
        if existing is not None and existing.get("turn_id") != turn_id:
            return None
        await client.delete(key)
        await client.srem(index_key, key)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "message_status_reactions.clear failed room=%s msg=%s actor=%s kind=%s: %s",
            room_id,
            msg_id,
            actor_id,
            kind,
            exc,
        )
    return payload


async def load_active_status_reactions(
    room_id: str,
    msg_ids: list[str],
) -> dict[str, list[dict[str, Any]]]:
    if not msg_ids:
        return {}
    client = get_redis()
    if client is None:
        return {}

    requested = set(msg_ids)
    index_key = _room_index_key(room_id)
    stale_keys: list[str] = []
    out: dict[str, list[dict[str, Any]]] = {}
    try:
        keys = list(await client.smembers(index_key))
        if not keys:
            return {}
        raws = await client.mget(keys)
        now = _now()
        for key, raw in zip(keys, raws, strict=False):
            data = _json_loads(raw)
            if data is None:
                stale_keys.append(key)
                continue
            msg_id = data.get("msg_id")
            if data.get("room_id") != room_id or msg_id not in requested:
                continue
            expires_raw = data.get("expires_at")
            try:
                expires_at = (
                    datetime.datetime.fromisoformat(expires_raw)
                    if isinstance(expires_raw, str)
                    else None
                )
            except ValueError:
                expires_at = None
            if expires_at is None or expires_at <= now:
                stale_keys.append(key)
                continue
            out.setdefault(str(msg_id), []).append(data)
        if stale_keys:
            await client.srem(index_key, *stale_keys)
    except Exception as exc:  # noqa: BLE001
        logger.warning("message_status_reactions.load failed room=%s: %s", room_id, exc)
        return {}
    return out

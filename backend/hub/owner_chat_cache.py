"""Owner-chat in-flight stream cache — the ONLY module that talks to Redis.

Short-lived Redis cache + pub/sub fanout for owner-chat stream blocks. The
cache lets the dashboard restore in-flight streaming UI across refresh /
reconnect; the fanout lets multiple Hub instances deliver live events to
whichever process holds the browser WebSocket.

Every public function is a graceful no-op when Redis is disabled
(``BOTCORD_REDIS_URL`` unset) or when any Redis operation raises. Live
WebSocket streaming MUST keep working with Redis off.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import uuid
from typing import Any, Awaitable, Callable

from hub import config as hub_config

logger = logging.getLogger(__name__)

# Module instance id — generated once at import, used to tag fanout origin so
# the publishing process can skip its own fanout events (it delivers locally
# directly to avoid round-trip latency).
INSTANCE_ID: str = uuid.uuid4().hex

_redis_client: Any = None
_redis_init_failed = False

# Local-delivery callback registered by owner_chat_ws.py to avoid a circular
# import. Signature: async (user_id, agent_id, data: dict) -> None.
_fanout_delivery: Callable[[str, str, dict], Awaitable[None]] | None = None


def register_fanout_delivery(
    fn: Callable[[str, str, dict], Awaitable[None]],
) -> None:
    """Register the local WS delivery callback used by the fanout subscriber."""
    global _fanout_delivery
    _fanout_delivery = fn


def redis_enabled() -> bool:
    return bool(getattr(hub_config, "BOTCORD_REDIS_URL", None))


def get_redis() -> Any:
    """Return a lazily-created async Redis client, or None if disabled/unavailable."""
    global _redis_client, _redis_init_failed
    if not redis_enabled() or _redis_init_failed:
        return None
    if _redis_client is None:
        try:
            import redis.asyncio as redis_asyncio

            # TLS is handled automatically by the rediss:// scheme.
            # health_check_interval + keepalive keep idle connections alive
            # (ElastiCache/NLB drop silent idle sockets), and retry_on_timeout
            # lets one-shot commands survive a transient read timeout instead of
            # surfacing as a write failure.
            _redis_client = redis_asyncio.from_url(
                hub_config.BOTCORD_REDIS_URL,
                encoding="utf-8",
                decode_responses=True,
                socket_keepalive=True,
                health_check_interval=30,
                retry_on_timeout=True,
            )
        except Exception as exc:  # noqa: BLE001
            _redis_init_failed = True
            logger.warning("owner_chat_cache: redis client init failed: %s", exc)
            return None
    return _redis_client


# ---------------------------------------------------------------------------
# Key helpers
# ---------------------------------------------------------------------------


def _run_key(trace_id: str) -> str:
    return f"owner_chat_run:{trace_id}"


def _events_key(trace_id: str) -> str:
    return f"owner_chat_run:{trace_id}:events"


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Block compaction
# ---------------------------------------------------------------------------


def _preview(value: Any, limit: int = 280) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    if len(text) > limit:
        return text[:limit]
    return text


# Max length for any single string field; long tool params / reasoning text /
# tool output get truncated to this. The overall per-event byte cap is enforced
# separately by _enforce_event_byte_cap.
_MAX_STR_FIELD = 4000
# Max items kept from a list before truncating (avoids huge arrays).
_MAX_LIST_ITEMS = 100


def _truncate_deep(value: Any, str_limit: int = _MAX_STR_FIELD) -> Any:
    """Recursively truncate long strings / large lists while PRESERVING the
    original structure and types.

    The restored stream view must render identically to the live view, so we
    keep the block's payload shape (dicts stay dicts, params stay objects) and
    only shrink oversized leaves — rather than reshaping per-kind or stringifying
    structured payloads (which produced double-escaped, mis-rendered blocks).
    """
    if isinstance(value, str):
        return value if len(value) <= str_limit else value[:str_limit] + "…"
    if isinstance(value, dict):
        return {k: _truncate_deep(v, str_limit) for k, v in value.items()}
    if isinstance(value, list):
        truncated = [_truncate_deep(v, str_limit) for v in value[:_MAX_LIST_ITEMS]]
        if len(value) > _MAX_LIST_ITEMS:
            truncated.append(f"… (+{len(value) - _MAX_LIST_ITEMS} more)")
        return truncated
    # int / float / bool / None — keep as-is.
    return value


def compact_block(block: dict) -> dict:
    """Normalize a stream block for caching while preserving its structure.

    Keeps the original ``kind``/``seq`` and the full payload shape, recursively
    truncating only oversized string/list leaves so the restored view matches
    the live stream exactly. The overall per-event byte cap is enforced by
    ``_enforce_event_byte_cap``.
    """
    if not isinstance(block, dict):
        return {"kind": "unknown"}

    kind = block.get("kind")
    seq = block.get("seq")
    payload = block.get("payload")
    payload = payload if isinstance(payload, dict) else {}

    compact: dict[str, Any] = {"kind": kind, "payload": _truncate_deep(payload)}
    if seq is not None:
        compact["seq"] = seq
    return compact


def _enforce_event_byte_cap(compact: dict) -> tuple[dict, bool, int]:
    """Return (compact_block, truncated, size_bytes). Drop raw payload if oversized."""
    max_bytes = hub_config.OWNER_CHAT_MAX_EVENT_BYTES
    encoded = json.dumps(compact, ensure_ascii=False)
    size_bytes = len(encoded.encode("utf-8"))
    if size_bytes <= max_bytes:
        return compact, False, size_bytes

    # Too large: keep a short preview, drop the full payload.
    truncated = {
        "kind": compact.get("kind"),
        "truncated": True,
        "payload": {"preview": _preview(compact.get("payload"), 280)},
    }
    if "seq" in compact:
        truncated["seq"] = compact["seq"]
    encoded = json.dumps(truncated, ensure_ascii=False)
    return truncated, True, len(encoded.encode("utf-8"))


# ---------------------------------------------------------------------------
# Cache writes
# ---------------------------------------------------------------------------


async def write_run_metadata(
    trace_id: str,
    *,
    user_id: str,
    agent_id: str,
    room_id: str,
    trigger_msg_id: str,
) -> None:
    """Create the run hash with status=running and the running TTL."""
    client = get_redis()
    if client is None:
        return
    try:
        key = _run_key(trace_id)
        await client.hset(
            key,
            mapping={
                "trace_id": trace_id,
                "user_id": user_id,
                "agent_id": agent_id,
                "room_id": room_id,
                "trigger_msg_id": trigger_msg_id,
                "status": "running",
                "started_at": _now_iso(),
                "completed_at": "",
                "final_msg_id": "",
                "event_count": 0,
                "last_seq": 0,
            },
        )
        await client.expire(key, hub_config.OWNER_CHAT_RUN_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.write_run_metadata failed trace=%s: %s", trace_id, exc)


async def append_event(trace_id: str, seq: int, block: dict) -> dict | None:
    """Compact + cache a stream block. Returns the compact block to broadcast.

    Returns None if dropped (Redis disabled, cap exceeded, or on error — in
    which case the caller falls back to broadcasting the raw block itself).
    """
    client = get_redis()
    if client is None:
        return None
    try:
        run_key = _run_key(trace_id)
        # Enforce per-trace event cap using the run hash's event_count.
        raw_count = await client.hget(run_key, "event_count")
        count = int(raw_count) if raw_count is not None else 0
        if count >= hub_config.OWNER_CHAT_MAX_CACHED_EVENTS:
            return None

        compact = compact_block(block)
        compact, truncated, size_bytes = _enforce_event_byte_cap(compact)
        created_at = _now_iso()

        await client.xadd(
            _events_key(trace_id),
            {
                "seq": seq,
                "kind": str(compact.get("kind") or ""),
                "created_at": created_at,
                "payload_compact": json.dumps(compact, ensure_ascii=False),
                "truncated": "1" if truncated else "0",
                "size_bytes": size_bytes,
            },
            maxlen=hub_config.OWNER_CHAT_MAX_CACHED_EVENTS,
            approximate=True,
        )
        await client.hset(
            run_key,
            mapping={"event_count": count + 1, "last_seq": seq},
        )
        await client.expire(run_key, hub_config.OWNER_CHAT_RUN_TTL_SECONDS)
        await client.expire(_events_key(trace_id), hub_config.OWNER_CHAT_RUN_TTL_SECONDS)
        return compact
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.append_event failed trace=%s: %s", trace_id, exc)
        return None


async def mark_run_completed(trace_id: str, *, final_msg_id: str = "") -> None:
    """Mark a run completed and shorten both keys to the completed TTL.

    First-wins: only a run still in ``status="running"`` is transitioned. This
    lets two independent terminal signals race safely — the reply path (which
    carries the real ``final_msg_id``) and the daemon's ``/hub/stream-end``
    signal (which carries none, used when the turn produced no owner-chat
    reply). Whichever lands first completes the run; the later one is a no-op
    and never clobbers a recorded ``final_msg_id``.
    """
    client = get_redis()
    if client is None:
        return
    try:
        run_key = _run_key(trace_id)
        # Returns None when the key is gone (expired / never created) — both
        # cases fall through to the no-op below.
        status = await client.hget(run_key, "status")
        if status != "running":
            return
        mapping: dict[str, Any] = {
            "status": "completed",
            "completed_at": _now_iso(),
        }
        if final_msg_id:
            mapping["final_msg_id"] = final_msg_id
        await client.hset(run_key, mapping=mapping)
        ttl = hub_config.OWNER_CHAT_RUN_COMPLETED_TTL_SECONDS
        await client.expire(run_key, ttl)
        await client.expire(_events_key(trace_id), ttl)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.mark_run_completed failed trace=%s: %s", trace_id, exc)


async def mark_run_failed(trace_id: str) -> None:
    """Mark a run failed and shorten both keys to the failed TTL."""
    client = get_redis()
    if client is None:
        return
    try:
        run_key = _run_key(trace_id)
        if not await client.exists(run_key):
            return
        await client.hset(run_key, mapping={"status": "failed"})
        ttl = hub_config.OWNER_CHAT_RUN_FAILED_TTL_SECONDS
        await client.expire(run_key, ttl)
        await client.expire(_events_key(trace_id), ttl)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.mark_run_failed failed trace=%s: %s", trace_id, exc)


async def load_run(trace_id: str) -> dict | None:
    """Read run hash + events stream. Returns None when missing/disabled/error."""
    client = get_redis()
    if client is None:
        return None
    try:
        run_key = _run_key(trace_id)
        meta = await client.hgetall(run_key)
        if not meta:
            return None

        entries = await client.xrange(_events_key(trace_id))
        events: list[dict] = []
        for _entry_id, fields in entries:
            try:
                block = json.loads(fields.get("payload_compact") or "{}")
            except (TypeError, ValueError):
                block = {}
            events.append(
                {
                    "seq": int(fields["seq"]) if fields.get("seq") else None,
                    "kind": fields.get("kind") or block.get("kind"),
                    "created_at": fields.get("created_at"),
                    "block": block,
                }
            )

        return {
            "status": meta.get("status", "completed"),
            "room_id": meta.get("room_id"),
            "agent_id": meta.get("agent_id"),
            "user_id": meta.get("user_id"),
            "events": events,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.load_run failed trace=%s: %s", trace_id, exc)
        return None


# ---------------------------------------------------------------------------
# Pub/Sub fanout
# ---------------------------------------------------------------------------


async def publish_fanout(event: dict) -> None:
    """Publish a fanout event tagged with this instance's origin id."""
    client = get_redis()
    if client is None:
        return
    try:
        payload = dict(event)
        payload["origin"] = INSTANCE_ID
        await client.publish(
            hub_config.OWNER_CHAT_FANOUT_CHANNEL,
            json.dumps(payload, ensure_ascii=False),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache.publish_fanout failed: %s", exc)


async def owner_chat_fanout_loop() -> None:
    """Subscribe to the fanout channel and deliver events to local WS.

    Skips events originating from this instance (it delivers locally directly).
    Runs until cancelled. Reconnects on transient errors.
    """
    while True:
        client = get_redis()
        if client is None:
            return
        pubsub = client.pubsub()
        try:
            await pubsub.subscribe(hub_config.OWNER_CHAT_FANOUT_CHANNEL)
            logger.info(
                "owner_chat_cache: fanout subscribed channel=%s instance=%s",
                hub_config.OWNER_CHAT_FANOUT_CHANNEL,
                INSTANCE_ID,
            )
            while True:
                # Block up to `timeout`s for a message; None means idle, which
                # is NOT an error. Using get_message(timeout=...) instead of
                # listen() avoids the socket read-timeout churn that made the
                # loop reconnect every few seconds against ElastiCache (and
                # leak a subscribe connection on each reconnect).
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=30.0
                )
                if message is None:
                    continue
                if message.get("type") != "message":
                    continue
                try:
                    event = json.loads(message["data"])
                except (TypeError, ValueError, KeyError):
                    continue
                if event.get("origin") == INSTANCE_ID:
                    continue
                await _deliver_fanout_event(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner_chat_cache.fanout_loop error: %s", exc)
        finally:
            # Always release the pubsub connection before reconnecting so a
            # transient error never leaks a subscribe connection.
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass
        await asyncio.sleep(1.0)


async def _deliver_fanout_event(event: dict) -> None:
    """Deliver a remote fanout event to the local WS delivery callback."""
    if _fanout_delivery is None:
        return
    user_id = event.get("user_id")
    agent_id = event.get("agent_id")
    if not user_id or not agent_id:
        return

    etype = event.get("type")
    data: dict[str, Any]
    if etype == "stream_block":
        data = {
            "type": "stream_block",
            "trace_id": event.get("trace_id"),
            "seq": event.get("seq"),
            "block": event.get("block"),
            "created_at": event.get("created_at"),
        }
    else:
        # message / typing / run_status — forward the carried payload as-is.
        data = event.get("data") or {}
        if not data:
            return
    try:
        await _fanout_delivery(user_id, agent_id, data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner_chat_cache: fanout delivery failed: %s", exc)

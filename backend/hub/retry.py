from __future__ import annotations

"""DEPRECATED: Webhook retry loop — no longer started by main.py.

This module is retained for reference during the transition period.
Message TTL expiry is now handled by hub/expiry.py.
"""

import asyncio
import datetime
import hashlib
import json
import logging
import time
import uuid

import httpx
import jcs
from sqlalchemy import select, update

from hub.config import FORWARD_TIMEOUT_SECONDS, RETRY_POLL_INTERVAL_SECONDS
from hub.constants import BACKOFF_SCHEDULE, DEFAULT_TTL_SEC, PROTOCOL_VERSION
from hub.database import async_session
from hub.forward import RoomContext, build_forward_url, convert_payload_for_openclaw, get_sender_display_name
from hub.id_generators import generate_hub_msg_id
from hub.models import Endpoint, EndpointState, MessageRecord, MessageState, Room, RoomMember

logger = logging.getLogger(__name__)


async def _forward(
    http_client: httpx.AsyncClient,
    url: str,
    envelope_dict: dict,
    webhook_token: str | None = None,
    sender_display_name: str | None = None,
    room_id: str | None = None,
    topic: str | None = None,
    room_context: RoomContext | None = None,
) -> str | None:
    """POST envelope to agent inbox. Returns None on success, error string on failure."""
    from hub.schemas import MessageEnvelope

    env_type = envelope_dict.get("type", "message")
    msg_id = envelope_dict.get("msg_id", "?")
    forward_url = build_forward_url(url, env_type)
    body = convert_payload_for_openclaw(forward_url, MessageEnvelope(**envelope_dict), sender_display_name, room_id=room_id, topic=topic, room_context=room_context)
    headers: dict[str, str] = {}
    if webhook_token:
        headers["Authorization"] = f"Bearer {webhook_token}"
    receiver_id = envelope_dict.get("to", "?")
    log_ctx = "POST %s to=%s type=%s msg_id=%s"
    log_args = (forward_url, receiver_id, env_type, msg_id)
    try:
        resp = await http_client.post(
            forward_url, json=body, headers=headers, timeout=FORWARD_TIMEOUT_SECONDS
        )
        if 200 <= resp.status_code < 300:
            logger.info("Webhook OK (retry): " + log_ctx + " -> %d", *log_args, resp.status_code)
            return None
        resp_body = resp.text[:500]
        logger.warning("Webhook FAIL (retry): " + log_ctx + " -> %d body=%s", *log_args, resp.status_code, resp_body)
        return f"HTTP {resp.status_code}"
    except httpx.ConnectError as exc:
        logger.warning("Webhook ERROR (retry): " + log_ctx + " -> ConnectError: %s", *log_args, exc)
        return "CONNECTION_REFUSED"
    except httpx.TimeoutException as exc:
        logger.warning("Webhook ERROR (retry): " + log_ctx + " -> Timeout after %ss: %s", *log_args, FORWARD_TIMEOUT_SECONDS, exc)
        return "TIMEOUT"
    except httpx.HTTPError as exc:
        logger.warning("Webhook ERROR (retry): " + log_ctx + " -> %s: %s", *log_args, type(exc).__name__, exc)
        return f"HTTP_ERROR: {type(exc).__name__}"
    except Exception as exc:
        logger.warning("Webhook ERROR (retry): " + log_ctx + " -> %s: %s", *log_args, type(exc).__name__, exc)
        return f"ERROR: {type(exc).__name__}"


def _build_ttl_error_envelope(record: MessageRecord) -> dict | None:
    """Build an unsigned error envelope for TTL expiry notification.

    Returns None if the stored envelope JSON is corrupted.
    """
    try:
        original = json.loads(record.envelope_json)
    except (json.JSONDecodeError, TypeError):
        logger.error("Corrupted envelope_json in record %s (msg_id=%s), skipping TTL error",
                      record.id, record.msg_id)
        return None
    payload = {"error": {"code": "TTL_EXPIRED", "message": "Message delivery timed out"}}
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    return {
        "v": PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "ts": int(time.time()),
        "from": "hub",
        "to": record.sender_id,
        "type": "error",
        "reply_to": record.msg_id,
        "ttl_sec": DEFAULT_TTL_SEC,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": "hub", "value": ""},
    }


def _build_endpoint_unreachable_envelope(receiver_id: str) -> dict:
    """Build an unsigned error envelope notifying *receiver_id* their endpoint is unreachable."""
    payload = {
        "error": {
            "code": "ENDPOINT_UNREACHABLE",
            "message": "Your webhook endpoint is unreachable. Please re-register: POST /registry/agents/{agent_id}/endpoints",
        }
    }
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    return {
        "v": PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "ts": int(time.time()),
        "from": "hub",
        "to": receiver_id,
        "type": "error",
        "reply_to": None,
        "ttl_sec": DEFAULT_TTL_SEC,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": "hub", "value": ""},
    }


async def _store_ttl_error_record(record: MessageRecord, session) -> None:
    """Store a TTL_EXPIRED error notification as a MessageRecord for the sender.

    The sender can retrieve it via /hub/inbox polling.
    """
    error_envelope = _build_ttl_error_envelope(record)
    if error_envelope is None:
        return
    hub_msg_id = generate_hub_msg_id()
    now = datetime.datetime.now(datetime.timezone.utc)
    error_record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=error_envelope["msg_id"],
        sender_id="hub",
        receiver_id=record.sender_id,
        state=MessageState.queued,
        envelope_json=json.dumps(error_envelope),
        ttl_sec=DEFAULT_TTL_SEC,
        created_at=now,
        next_retry_at=None,
    )
    session.add(error_record)


async def _store_endpoint_unreachable_notification(receiver_id: str, session) -> None:
    """Store an ENDPOINT_UNREACHABLE error notification for *receiver_id*.

    Tells the receiver their webhook is down and they should re-register.
    """
    envelope = _build_endpoint_unreachable_envelope(receiver_id)
    hub_msg_id = generate_hub_msg_id()
    now = datetime.datetime.now(datetime.timezone.utc)
    notif_record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=envelope["msg_id"],
        sender_id="hub",
        receiver_id=receiver_id,
        state=MessageState.queued,
        envelope_json=json.dumps(envelope),
        ttl_sec=DEFAULT_TTL_SEC,
        created_at=now,
        next_retry_at=None,
    )
    session.add(notif_record)


async def _mark_endpoint_unreachable(receiver_id: str, session) -> None:
    """Mark the receiver's active endpoint(s) as unreachable."""
    await session.execute(
        update(Endpoint)
        .where(
            Endpoint.agent_id == receiver_id,
            Endpoint.state == EndpointState.active,
        )
        .values(state=EndpointState.unreachable)
    )


def _is_webhook_error(last_error: str | None) -> bool:
    """Return True if last_error indicates a webhook delivery failure (not NO_ENDPOINT)."""
    if not last_error:
        return False
    return last_error != "NO_ENDPOINT"


async def retry_loop(http_client: httpx.AsyncClient) -> None:
    """Background loop that retries queued messages."""
    while True:
        try:
            await _retry_batch(http_client)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("retry_loop error")
        await asyncio.sleep(RETRY_POLL_INTERVAL_SECONDS)


async def _retry_batch(http_client: httpx.AsyncClient) -> None:
    now = datetime.datetime.now(datetime.timezone.utc)
    async with async_session() as session:
        result = await session.execute(
            select(MessageRecord)
            .where(
                MessageRecord.state == MessageState.queued,
                MessageRecord.next_retry_at <= now,
            )
            .limit(50)
        )
        records = list(result.scalars().all())
        sender_name_cache: dict[str, str | None] = {}

        for record in records:
            created = record.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=datetime.timezone.utc)

            deadline = created + datetime.timedelta(seconds=record.ttl_sec)

            # Check if this is a receipt-type record (no recursive error receipts)
            try:
                envelope_dict = json.loads(record.envelope_json)
            except (json.JSONDecodeError, TypeError):
                logger.error(
                    "Corrupted envelope_json in record %s (msg_id=%s), marking as failed",
                    record.id, record.msg_id,
                )
                record.state = MessageState.failed
                record.last_error = "CORRUPTED_ENVELOPE"
                record.next_retry_at = None
                await session.commit()
                continue
            is_receipt = envelope_dict.get("type") in ("ack", "result", "error")

            if now >= deadline:
                record.state = MessageState.failed
                record.next_retry_at = None

                # If TTL expired due to webhook errors, mark endpoint unreachable
                # and notify the receiver
                prev_error = record.last_error
                record.last_error = "TTL_EXPIRED"

                if _is_webhook_error(prev_error):
                    await _mark_endpoint_unreachable(record.receiver_id, session)
                    await _store_endpoint_unreachable_notification(record.receiver_id, session)

                if not is_receipt:
                    await _store_ttl_error_record(record, session)

                await session.commit()
                continue

            # Resolve endpoint
            ep_result = await session.execute(
                select(Endpoint).where(
                    Endpoint.agent_id == record.receiver_id,
                    Endpoint.state == EndpointState.active,
                )
            )
            endpoint = ep_result.scalar_one_or_none()
            if endpoint is None:
                # Check if endpoint is unreachable or unverified
                unreachable_result = await session.execute(
                    select(Endpoint).where(
                        Endpoint.agent_id == record.receiver_id,
                        Endpoint.state.in_([EndpointState.unreachable, EndpointState.unverified]),
                    )
                )
                if unreachable_result.scalar_one_or_none() is not None:
                    # Endpoint unreachable — park message for inbox polling
                    record.next_retry_at = None
                    record.last_error = "ENDPOINT_UNREACHABLE"
                    await session.commit()
                    continue

                # No endpoint at all — bump retry
                record.retry_count += 1
                record.last_error = "NO_ENDPOINT"
                idx = min(record.retry_count, len(BACKOFF_SCHEDULE) - 1)
                next_at = now + datetime.timedelta(seconds=BACKOFF_SCHEDULE[idx])
                if next_at > deadline:
                    record.state = MessageState.failed
                    record.next_retry_at = None
                    record.last_error = "TTL_EXPIRED"
                    if not is_receipt:
                        await _store_ttl_error_record(record, session)
                else:
                    record.next_retry_at = next_at
                await session.commit()
                continue

            sender_id = envelope_dict.get("from", "")
            if sender_id not in sender_name_cache:
                sender_name_cache[sender_id] = await get_sender_display_name(sender_id, session)
            sender_display_name = sender_name_cache[sender_id]

            # Load room context for room messages
            room_context: RoomContext | None = None
            if record.room_id:
                room_result = await session.execute(
                    select(Room).where(Room.room_id == record.room_id)
                )
                room_obj = room_result.scalar_one_or_none()
                if room_obj:
                    member_result = await session.execute(
                        select(RoomMember.agent_id).where(
                            RoomMember.room_id == record.room_id
                        )
                    )
                    member_ids = [row[0] for row in member_result.all()]
                    from hub.models import Agent
                    agent_result = await session.execute(
                        select(Agent.agent_id, Agent.display_name).where(
                            Agent.agent_id.in_(member_ids)
                        )
                    )
                    agent_map = dict(agent_result.all())
                    room_context = RoomContext(
                        room_id=record.room_id,
                        name=room_obj.name,
                        member_count=len(member_ids),
                        rule=room_obj.rule,
                        member_names=[agent_map.get(aid, aid) for aid in member_ids],
                    )

            err = await _forward(
                http_client, endpoint.url, envelope_dict,
                webhook_token=endpoint.webhook_token,
                sender_display_name=sender_display_name,
                room_id=record.room_id,
                topic=record.topic,
                room_context=room_context,
            )
            # Track delivery error on endpoint
            endpoint.last_delivery_error = err
            if err is None:
                record.state = MessageState.delivered
                record.delivered_at = now
            else:
                record.retry_count += 1
                record.last_error = err
                idx = min(record.retry_count, len(BACKOFF_SCHEDULE) - 1)
                next_at = now + datetime.timedelta(seconds=BACKOFF_SCHEDULE[idx])
                if next_at > deadline:
                    record.state = MessageState.failed
                    record.next_retry_at = None
                    record.last_error = "TTL_EXPIRED"
                    await _mark_endpoint_unreachable(record.receiver_id, session)
                    await _store_endpoint_unreachable_notification(record.receiver_id, session)
                    if not is_receipt:
                        await _store_ttl_error_record(record, session)
                else:
                    record.next_retry_at = next_at
            await session.commit()

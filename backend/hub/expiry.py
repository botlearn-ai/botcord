"""Background loop that expires queued messages past their TTL."""
from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import logging
import time
import uuid

import jcs

from hub.config import MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS
from hub.constants import DEFAULT_TTL_SEC, PROTOCOL_VERSION
from hub.database import async_session
from hub.id_generators import generate_hub_msg_id
from hub.models import MessageRecord, MessageState

logger = logging.getLogger(__name__)


def _build_ttl_error_envelope(record: MessageRecord) -> dict | None:
    """Build an unsigned error envelope for TTL expiry notification.

    Returns None if the stored envelope JSON is corrupted.
    """
    try:
        original = json.loads(record.envelope_json)
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "Corrupted envelope_json in record %s (msg_id=%s), skipping TTL error",
            record.id, record.msg_id,
        )
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


async def _reclaim_stale_processing() -> None:
    """Revert messages stuck in 'processing' state back to 'queued'.

    This handles the case where a consumer polled with ack=false (marking
    messages as 'processing') but crashed before calling POST /hub/inbox/ack.
    The poll endpoint sets next_retry_at to the processing timeout deadline.

    After reclaiming, notifies affected agents so WS/long-poll consumers
    re-fetch immediately instead of waiting for the next new message.
    """
    from hub.routers.hub import notify_inbox
    from sqlalchemy import select, update

    now = datetime.datetime.now(datetime.timezone.utc)

    async with async_session() as session:
        # First, find which agents are affected so we can notify them
        affected_stmt = (
            select(MessageRecord.receiver_id)
            .where(
                MessageRecord.state == MessageState.processing,
                MessageRecord.next_retry_at <= now,
            )
            .distinct()
        )
        affected_result = await session.execute(affected_stmt)
        affected_agents = [row[0] for row in affected_result.all()]

        if not affected_agents:
            return

        # Bulk revert
        stmt = (
            update(MessageRecord)
            .where(
                MessageRecord.state == MessageState.processing,
                MessageRecord.next_retry_at <= now,
            )
            .values(state=MessageState.queued, next_retry_at=None)
        )
        result = await session.execute(stmt)
        await session.commit()

        logger.info("Reclaimed %d stale processing messages back to queued", result.rowcount)

        # Notify affected agents so they re-poll
        for agent_id in affected_agents:
            await notify_inbox(agent_id)


async def _expire_batch() -> None:
    """Scan for queued messages past their TTL and expire them."""
    from hub.routers.hub import notify_inbox
    from sqlalchemy import select, text as sa_text

    now = datetime.datetime.now(datetime.timezone.utc)
    now_epoch = int(now.timestamp())

    async with async_session() as session:
        # Filter expired rows at the DB level so non-expired long-TTL messages
        # never block shorter-TTL ones from being scanned.
        dialect = session.bind.dialect.name
        if dialect == "sqlite":
            expired_cond = sa_text(
                "CAST(strftime('%s', created_at) AS INTEGER) + ttl_sec <= :now_ts"
            )
        else:  # postgresql
            expired_cond = sa_text(
                "EXTRACT(EPOCH FROM created_at) + ttl_sec <= :now_ts"
            )

        result = await session.execute(
            select(MessageRecord)
            .where(
                MessageRecord.state == MessageState.queued,
                expired_cond.bindparams(now_ts=now_epoch),
            )
            .order_by(MessageRecord.created_at.asc())
            .limit(100)
        )
        records = list(result.scalars().all())

        for record in records:
            # Expired
            record.state = MessageState.failed
            record.last_error = "TTL_EXPIRED"
            record.next_retry_at = None

            # Check if this is a receipt-type record
            try:
                envelope_dict = json.loads(record.envelope_json)
            except (json.JSONDecodeError, TypeError):
                logger.error(
                    "Corrupted envelope_json in record %s (msg_id=%s), marking as failed",
                    record.id, record.msg_id,
                )
                await session.commit()
                continue

            is_receipt = envelope_dict.get("type") in ("ack", "result", "error")

            # For non-receipt messages, notify the sender about TTL expiry
            if not is_receipt:
                error_envelope = _build_ttl_error_envelope(record)
                if error_envelope is not None:
                    hub_msg_id = generate_hub_msg_id()
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

            await session.commit()

            # Notify sender about the TTL_EXPIRED error message
            if not is_receipt:
                await notify_inbox(record.sender_id)


async def message_expiry_loop() -> None:
    """Background loop that expires queued messages past their TTL and reclaims stale processing."""
    while True:
        try:
            await _reclaim_stale_processing()
            await _expire_batch()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("message_expiry_loop error")
        await asyncio.sleep(MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS)

"""Atomic room-send idempotency, independent of agent execution retries."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import DashboardSendRequest


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


async def reserve_room_send(db: AsyncSession, *, user_id: str, sender_id: str,
                            room_id: str, key: str, payload: dict) -> tuple[DashboardSendRequest, dict | None]:
    """Unique insert serializes concurrent copies, even across Hub processes.

    The reservation MUST commit in the same transaction as the message fan-out.
    A failed transaction releases the key. A duplicate returns only the stored
    response and must not notify or fan out again. Retain rows with messages;
    expiring keys would allow a delayed retry to create a second message.
    """
    request_id = digest([user_id, sender_id, room_id, key])
    fingerprint = digest(payload)
    insert = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    inserted = (await db.execute(
        insert(DashboardSendRequest).values(request_id=request_id, fingerprint=fingerprint)
        .on_conflict_do_nothing(index_elements=["request_id"])
        .returning(DashboardSendRequest.request_id)
    )).scalar_one_or_none()
    row = (await db.execute(select(DashboardSendRequest).where(
        DashboardSendRequest.request_id == request_id
    ).execution_options(populate_existing=True))).scalar_one()
    if row.fingerprint != fingerprint:
        raise HTTPException(409, detail="idempotency_key_conflict")
    if inserted is None and row.response_json is None:
        # A committed incomplete reservation is an invariant violation, never
        # permission to repeat an operation whose outcome is unknown.
        raise HTTPException(409, detail="send_request_incomplete")
    return row, row.response_json if inserted is None else None

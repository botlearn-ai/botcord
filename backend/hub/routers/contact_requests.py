import datetime
import hashlib
import json
import logging
import uuid

import jcs
from fastapi import APIRouter, Depends, Query
from hub.i18n import I18nHTTPException

logger = logging.getLogger(__name__)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub.constants import DEFAULT_TTL_SEC, PROTOCOL_VERSION
from hub.database import get_db
from hub.id_generators import generate_hub_msg_id
from hub.models import Contact, ContactRequest, ContactRequestState, MessageRecord, MessageState
from hub.schemas import (
    ContactRequestListResponse,
    ContactRequestResponse,
)
from hub.validators import check_agent_ownership

router = APIRouter(prefix="/registry", tags=["contact-requests"])


def _request_to_response(cr: ContactRequest) -> ContactRequestResponse:
    return ContactRequestResponse(
        id=cr.id,
        from_agent_id=cr.from_agent_id,
        to_agent_id=cr.to_agent_id,
        state=cr.state.value,
        message=cr.message,
        created_at=cr.created_at,
        resolved_at=cr.resolved_at,
    )


async def _create_notification(
    db: AsyncSession,
    responder_id: str,
    requester_id: str,
    request_id: int,
    status: str,
) -> None:
    """Push a contact_request_response notification into the requester's inbox."""
    from hub.routers.hub import notify_inbox

    now = datetime.datetime.now(datetime.timezone.utc)
    ts = int(now.timestamp())
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    payload = {"state": status, "request_id": request_id}
    payload_bytes = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(payload_bytes).hexdigest()

    envelope_dict = {
        "v": PROTOCOL_VERSION,
        "msg_id": msg_id,
        "ts": ts,
        "from": responder_id,
        "to": requester_id,
        "type": "contact_request_response",
        "reply_to": None,
        "ttl_sec": DEFAULT_TTL_SEC,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": "system", "value": ""},
    }

    record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=msg_id,
        sender_id=responder_id,
        receiver_id=requester_id,
        state=MessageState.queued,
        envelope_json=json.dumps(envelope_dict),
        ttl_sec=DEFAULT_TTL_SEC,
        created_at=now,
    )
    db.add(record)
    await db.commit()

    await notify_inbox(requester_id)


# ---------------------------------------------------------------------------
# List received contact requests
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/contact-requests/received",
    response_model=ContactRequestListResponse,
)
async def list_received_requests(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
    state: ContactRequestState | None = Query(default=None),
):
    check_agent_ownership(agent_id, current_agent)

    stmt = select(ContactRequest).where(
        ContactRequest.to_agent_id == agent_id,
    ).order_by(ContactRequest.created_at.desc())

    if state is not None:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    requests = result.scalars().all()
    return ContactRequestListResponse(
        requests=[_request_to_response(r) for r in requests]
    )


# ---------------------------------------------------------------------------
# List sent contact requests
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/contact-requests/sent",
    response_model=ContactRequestListResponse,
)
async def list_sent_requests(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
    state: ContactRequestState | None = Query(default=None),
):
    check_agent_ownership(agent_id, current_agent)

    stmt = select(ContactRequest).where(
        ContactRequest.from_agent_id == agent_id,
    ).order_by(ContactRequest.created_at.desc())

    if state is not None:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    requests = result.scalars().all()
    return ContactRequestListResponse(
        requests=[_request_to_response(r) for r in requests]
    )


# ---------------------------------------------------------------------------
# Accept a contact request
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/contact-requests/{request_id}/accept",
    response_model=ContactRequestResponse,
)
async def accept_request(
    agent_id: str,
    request_id: int,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(ContactRequest).where(
            ContactRequest.id == request_id,
            ContactRequest.to_agent_id == agent_id,
        )
    )
    cr = result.scalar_one_or_none()
    if cr is None:
        raise I18nHTTPException(status_code=404, message_key="contact_request_not_found")

    if cr.state != ContactRequestState.pending:
        raise I18nHTTPException(
            status_code=400,
            message_key="contact_request_already_resolved",
            state=cr.state.value,
        )

    now = datetime.datetime.now(datetime.timezone.utc)
    cr.state = ContactRequestState.accepted
    cr.resolved_at = now

    # Create mutual contacts (skip if already exists)
    for owner_id, contact_id in [
        (cr.to_agent_id, cr.from_agent_id),
        (cr.from_agent_id, cr.to_agent_id),
    ]:
        existing = await db.execute(
            select(Contact).where(
                Contact.owner_id == owner_id,
                Contact.contact_agent_id == contact_id,
            )
        )
        if existing.scalar_one_or_none() is None:
            try:
                async with db.begin_nested():
                    db.add(Contact(owner_id=owner_id, contact_agent_id=contact_id))
                    await db.flush()
            except IntegrityError:
                pass  # contact already exists, skip

    await db.commit()
    await db.refresh(cr)

    await _create_notification(db, cr.to_agent_id, cr.from_agent_id, cr.id, "accepted")

    return _request_to_response(cr)


# ---------------------------------------------------------------------------
# Reject a contact request
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/contact-requests/{request_id}/reject",
    response_model=ContactRequestResponse,
)
async def reject_request(
    agent_id: str,
    request_id: int,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(ContactRequest).where(
            ContactRequest.id == request_id,
            ContactRequest.to_agent_id == agent_id,
        )
    )
    cr = result.scalar_one_or_none()
    if cr is None:
        raise I18nHTTPException(status_code=404, message_key="contact_request_not_found")

    if cr.state != ContactRequestState.pending:
        raise I18nHTTPException(
            status_code=400,
            message_key="contact_request_already_resolved",
            state=cr.state.value,
        )

    cr.state = ContactRequestState.rejected
    cr.resolved_at = datetime.datetime.now(datetime.timezone.utc)

    await db.commit()
    await db.refresh(cr)

    await _create_notification(db, cr.to_agent_id, cr.from_agent_id, cr.id, "rejected")

    return _request_to_response(cr)

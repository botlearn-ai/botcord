import datetime
import hashlib
import json
import logging
import uuid

import jcs
from fastapi import APIRouter, Depends
from hub.i18n import I18nHTTPException

logger = logging.getLogger(__name__)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub.constants import DEFAULT_TTL_SEC, PROTOCOL_VERSION
from hub.database import get_db
from hub.id_generators import generate_hub_msg_id
from hub.models import Agent, Block, Contact, MessagePolicy, MessageRecord, MessageState
from hub.schemas import (
    AddBlockRequest,
    BlockListResponse,
    BlockResponse,
    ContactListResponse,
    ContactResponse,
    PolicyResponse,
    UpdatePolicyRequest,
)
from hub.validators import check_agent_ownership

router = APIRouter(prefix="/registry", tags=["contacts"])


async def _create_contact_removed_notification(
    db: AsyncSession,
    remover_id: str,
    other_id: str,
) -> None:
    """Push a contact_removed notification into the other agent's inbox."""
    from hub.routers.hub import notify_inbox

    now = datetime.datetime.now(datetime.timezone.utc)
    ts = int(now.timestamp())
    msg_id = str(uuid.uuid4())
    hub_msg_id = generate_hub_msg_id()
    payload = {"removed_by": remover_id}
    payload_bytes = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(payload_bytes).hexdigest()

    envelope_dict = {
        "v": PROTOCOL_VERSION,
        "msg_id": msg_id,
        "ts": ts,
        "from": remover_id,
        "to": other_id,
        "type": "contact_removed",
        "reply_to": None,
        "ttl_sec": DEFAULT_TTL_SEC,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": "system", "value": ""},
    }

    record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=msg_id,
        sender_id=remover_id,
        receiver_id=other_id,
        state=MessageState.queued,
        envelope_json=json.dumps(envelope_dict),
        ttl_sec=DEFAULT_TTL_SEC,
        created_at=now,
    )
    db.add(record)
    await db.commit()

    await notify_inbox(other_id)


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/contacts",
    response_model=ContactListResponse,
)
async def list_contacts(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(Contact)
        .where(Contact.owner_id == agent_id)
        .order_by(Contact.created_at.asc())
    )
    contacts = result.scalars().all()
    return ContactListResponse(
        contacts=[
            ContactResponse(
                contact_agent_id=c.contact_agent_id,
                alias=c.alias,
                created_at=c.created_at,
            )
            for c in contacts
        ]
    )


@router.get(
    "/agents/{agent_id}/contacts/{contact_agent_id}",
    response_model=ContactResponse,
)
async def get_contact(
    agent_id: str,
    contact_agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(Contact).where(
            Contact.owner_id == agent_id,
            Contact.contact_agent_id == contact_agent_id,
        )
    )
    contact = result.scalar_one_or_none()
    if contact is None:
        raise I18nHTTPException(status_code=404, message_key="contact_not_found")

    return ContactResponse(
        contact_agent_id=contact.contact_agent_id,
        alias=contact.alias,
        created_at=contact.created_at,
    )


@router.delete(
    "/agents/{agent_id}/contacts/{contact_agent_id}",
    status_code=204,
)
async def remove_contact(
    agent_id: str,
    contact_agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    # Check A→B direction exists (required for 200 vs 404)
    result = await db.execute(
        select(Contact).where(
            Contact.owner_id == agent_id,
            Contact.contact_agent_id == contact_agent_id,
        )
    )
    contact = result.scalar_one_or_none()
    if contact is None:
        raise I18nHTTPException(status_code=404, message_key="contact_not_found")

    # Delete A→B
    await db.delete(contact)

    # Also delete B→A (reverse direction) if it exists
    result = await db.execute(
        select(Contact).where(
            Contact.owner_id == contact_agent_id,
            Contact.contact_agent_id == agent_id,
        )
    )
    reverse_contact = result.scalar_one_or_none()
    if reverse_contact is not None:
        await db.delete(reverse_contact)

    await db.commit()

    # Notify the other party
    await _create_contact_removed_notification(db, agent_id, contact_agent_id)


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/blocks",
    response_model=BlockResponse,
    status_code=201,
)
async def add_block(
    agent_id: str,
    body: AddBlockRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    # Owner must exist
    owner = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if owner.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    if body.blocked_agent_id == agent_id:
        raise I18nHTTPException(status_code=400, message_key="cannot_block_yourself")

    # Target must exist
    result = await db.execute(
        select(Agent).where(Agent.agent_id == body.blocked_agent_id)
    )
    if result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=404, message_key="target_agent_not_found")

    block = Block(owner_id=agent_id, blocked_agent_id=body.blocked_agent_id)
    db.add(block)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise I18nHTTPException(status_code=409, message_key="agent_already_blocked")

    await db.commit()
    await db.refresh(block)
    return BlockResponse(
        blocked_agent_id=block.blocked_agent_id,
        created_at=block.created_at,
    )


@router.get(
    "/agents/{agent_id}/blocks",
    response_model=BlockListResponse,
)
async def list_blocks(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(Block)
        .where(Block.owner_id == agent_id)
        .order_by(Block.created_at.asc())
    )
    blocks = result.scalars().all()
    return BlockListResponse(
        blocks=[
            BlockResponse(
                blocked_agent_id=b.blocked_agent_id,
                created_at=b.created_at,
            )
            for b in blocks
        ]
    )


@router.delete(
    "/agents/{agent_id}/blocks/{blocked_agent_id}",
    status_code=204,
)
async def remove_block(
    agent_id: str,
    blocked_agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(
        select(Block).where(
            Block.owner_id == agent_id,
            Block.blocked_agent_id == blocked_agent_id,
        )
    )
    block = result.scalar_one_or_none()
    if block is None:
        raise I18nHTTPException(status_code=404, message_key="block_not_found")

    await db.delete(block)
    await db.commit()


# ---------------------------------------------------------------------------
# Message Policy
# ---------------------------------------------------------------------------


@router.patch(
    "/agents/{agent_id}/policy",
    response_model=PolicyResponse,
)
async def update_policy(
    agent_id: str,
    body: UpdatePolicyRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    agent.message_policy = body.message_policy
    await db.commit()
    return PolicyResponse(message_policy=body.message_policy)


@router.get(
    "/agents/{agent_id}/policy",
    response_model=PolicyResponse,
)
async def get_policy(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    return PolicyResponse(message_policy=agent.message_policy.value)

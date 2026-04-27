"""Unit tests for hub.policy admission helpers.

Coverage matrix (per design doc §4.1):
  * sender_type ∈ {agent, human}  ×  op ∈ {direct, room_invite}
  * contact_policy ∈ {open, contacts_only, whitelist, closed}
  * room_invite_policy ∈ {open, contacts_only, closed}
  * allow_agent_sender / allow_human_sender toggles
  * Block precedence
  * contact_request passthrough on direct
  * legacy message_policy fallback
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import (
    AttentionMode,
    ContactPolicy,
    MessagePolicy,
    MessageType,
    ParticipantType,
    RoomInvitePolicy,
)
from hub.i18n import I18nHTTPException
from hub.models import Agent, Base, Block, Contact
from hub.policy import (
    Principal,
    check_direct_admission,
    check_room_invite_admission,
)


def _engine():
    from tests.test_app.conftest import create_test_engine
    return create_test_engine()


@pytest_asyncio.fixture
async def session():
    engine = _engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        yield s
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


def _agent(
    agent_id: str = "ag_receiver",
    *,
    contact_policy: ContactPolicy = ContactPolicy.contacts_only,
    room_invite_policy: RoomInvitePolicy = RoomInvitePolicy.contacts_only,
    message_policy: MessagePolicy = MessagePolicy.contacts_only,
    allow_agent_sender: bool = True,
    allow_human_sender: bool = True,
) -> Agent:
    return Agent(
        agent_id=agent_id,
        display_name="Receiver",
        bio="x",
        message_policy=message_policy,
        contact_policy=contact_policy,
        room_invite_policy=room_invite_policy,
        allow_agent_sender=allow_agent_sender,
        allow_human_sender=allow_human_sender,
        default_attention=AttentionMode.always,
        attention_keywords="[]",
    )


async def _add(session: AsyncSession, *objs):
    for o in objs:
        session.add(o)
    await session.commit()


def _agent_principal(id_: str = "ag_sender") -> Principal:
    return Principal(id=id_, type=ParticipantType.agent)


def _human_principal(id_: str = "hu_sender") -> Principal:
    return Principal(id=id_, type=ParticipantType.human)


# ---------------------------------------------------------------------------
# check_direct_admission
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_direct_open_allows_anyone(session):
    receiver = _agent(contact_policy=ContactPolicy.open, message_policy=MessagePolicy.open)
    await _add(session, receiver)
    await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    await check_direct_admission(session, sender=_human_principal(), receiver=receiver)


@pytest.mark.asyncio
async def test_direct_contacts_only_blocks_strangers(session):
    receiver = _agent(contact_policy=ContactPolicy.contacts_only)
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    assert exc.value.message_key == "not_in_contacts"


@pytest.mark.asyncio
async def test_direct_contacts_only_allows_contacts(session):
    receiver = _agent(contact_policy=ContactPolicy.contacts_only)
    contact = Contact(
        owner_id="ag_receiver",
        owner_type=ParticipantType.agent,
        contact_agent_id="ag_sender",
        peer_type=ParticipantType.agent,
    )
    await _add(session, receiver, contact)
    await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)


@pytest.mark.asyncio
async def test_direct_whitelist_requires_contact(session):
    receiver = _agent(contact_policy=ContactPolicy.whitelist)
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_human_principal(), receiver=receiver)
    assert exc.value.message_key == "not_in_whitelist"

    contact = Contact(
        owner_id="ag_receiver",
        owner_type=ParticipantType.agent,
        contact_agent_id="hu_sender",
        peer_type=ParticipantType.human,
    )
    session.add(contact)
    await session.commit()
    await check_direct_admission(session, sender=_human_principal(), receiver=receiver)


@pytest.mark.asyncio
async def test_direct_closed_rejects_everyone_but_contact_request(session):
    receiver = _agent(contact_policy=ContactPolicy.closed)
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    assert exc.value.message_key == "agent_closed_to_new_contacts"

    # contact_request always passes — otherwise the friend-request flow dies.
    await check_direct_admission(
        session,
        sender=_agent_principal(),
        receiver=receiver,
        message_type=MessageType.contact_request,
    )


@pytest.mark.asyncio
async def test_direct_block_precedes_contact_request(session):
    receiver = _agent(contact_policy=ContactPolicy.open)
    block = Block(
        owner_id="ag_receiver",
        owner_type=ParticipantType.agent,
        blocked_agent_id="ag_sender",
        blocked_type=ParticipantType.agent,
    )
    await _add(session, receiver, block)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(
            session,
            sender=_agent_principal(),
            receiver=receiver,
            message_type=MessageType.contact_request,
        )
    assert exc.value.message_key == "blocked"


@pytest.mark.asyncio
async def test_direct_allow_agent_sender_off(session):
    receiver = _agent(
        contact_policy=ContactPolicy.open,
        message_policy=MessagePolicy.open,
        allow_agent_sender=False,
    )
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    assert exc.value.message_key == "agent_senders_disabled"
    # Humans still pass.
    await check_direct_admission(session, sender=_human_principal(), receiver=receiver)


@pytest.mark.asyncio
async def test_direct_allow_human_sender_off(session):
    receiver = _agent(
        contact_policy=ContactPolicy.open,
        message_policy=MessagePolicy.open,
        allow_human_sender=False,
    )
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_human_principal(), receiver=receiver)
    assert exc.value.message_key == "human_senders_disabled"


# ---------------------------------------------------------------------------
# check_room_invite_admission
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_room_invite_open(session):
    invitee = _agent(
        room_invite_policy=RoomInvitePolicy.open, message_policy=MessagePolicy.open
    )
    await _add(session, invitee)
    await check_room_invite_admission(session, inviter=_agent_principal(), invitee=invitee)
    await check_room_invite_admission(session, inviter=_human_principal(), invitee=invitee)


@pytest.mark.asyncio
async def test_room_invite_contacts_only(session):
    invitee = _agent(room_invite_policy=RoomInvitePolicy.contacts_only)
    await _add(session, invitee)
    with pytest.raises(I18nHTTPException) as exc:
        await check_room_invite_admission(
            session, inviter=_human_principal(), invitee=invitee
        )
    assert exc.value.message_key == "room_invite_requires_contact"

    contact = Contact(
        owner_id="ag_receiver",
        owner_type=ParticipantType.agent,
        contact_agent_id="hu_sender",
        peer_type=ParticipantType.human,
    )
    session.add(contact)
    await session.commit()
    await check_room_invite_admission(
        session, inviter=_human_principal(), invitee=invitee
    )


@pytest.mark.asyncio
async def test_room_invite_closed(session):
    invitee = _agent(room_invite_policy=RoomInvitePolicy.closed)
    await _add(session, invitee)
    with pytest.raises(I18nHTTPException) as exc:
        await check_room_invite_admission(session, inviter=_agent_principal(), invitee=invitee)
    assert exc.value.message_key == "agent_closed_to_room_invites"


@pytest.mark.asyncio
async def test_room_invite_blocks_first(session):
    invitee = _agent(room_invite_policy=RoomInvitePolicy.open)
    block = Block(
        owner_id="ag_receiver",
        owner_type=ParticipantType.agent,
        blocked_agent_id="hu_sender",
        blocked_type=ParticipantType.human,
    )
    await _add(session, invitee, block)
    with pytest.raises(I18nHTTPException) as exc:
        await check_room_invite_admission(
            session, inviter=_human_principal(), invitee=invitee
        )
    assert exc.value.message_key == "blocked"


# ---------------------------------------------------------------------------
# Legacy message_policy fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_legacy_message_policy_open_overrides_default_contact_policy(session):
    """Migration backfill safety: rows whose contact_policy is still the
    server_default `contacts_only` but whose legacy `message_policy=open`
    must continue to admit strangers."""
    receiver = _agent(
        contact_policy=ContactPolicy.contacts_only,
        message_policy=MessagePolicy.open,
    )
    await _add(session, receiver)
    await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    await check_room_invite_admission(
        session, inviter=_agent_principal(), invitee=receiver
    )


@pytest.mark.asyncio
async def test_explicit_whitelist_wins_over_legacy_open(session):
    """If the new column is explicitly stricter than `contacts_only`, the
    legacy `message_policy=open` does not relax it."""
    receiver = _agent(
        contact_policy=ContactPolicy.whitelist,
        message_policy=MessagePolicy.open,
    )
    await _add(session, receiver)
    with pytest.raises(I18nHTTPException) as exc:
        await check_direct_admission(session, sender=_agent_principal(), receiver=receiver)
    assert exc.value.message_key == "not_in_whitelist"

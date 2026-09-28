"""Move legacy Team conversations into organization Hub Rooms (idempotent).

Run once after applying migrations/007_org_rooms.sql:

    uv run python scripts/migrate_team_conversations_to_rooms.py [--dry-run]

Each ``team_conversations`` row becomes a Room with ``space_id`` set and a
deterministic id (``rm_team_<conversation hex>``). Members: every active
organization member for organization-visible rooms (they all had access), the
recorded participants for private rooms and DMs. Messages are copied as
delivered human room messages (one MessageRecord per current member), so
history and unread math work through the regular Room endpoints. The legacy
tables are left untouched.
"""

import asyncio
import datetime
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from hub.database import async_session  # noqa: E402
from hub.enums import MessageState, ParticipantType, RoomJoinPolicy, RoomRole, RoomVisibility  # noqa: E402
from hub.id_generators import generate_hub_msg_id  # noqa: E402
from hub.models import (  # noqa: E402
    MessageRecord, Room, RoomMember, SpaceUserMembership, TeamConversation,
    TeamConversationMember, TeamMessage, User,
)

_MSG_NAMESPACE = uuid.UUID("5b7f3e0c-4a1d-4e7b-9f2a-7c1e0d9b6a31")


async def _human_ids_for(db, membership_ids) -> dict:
    if not membership_ids:
        return {}
    rows = (await db.execute(
        select(SpaceUserMembership.id, User.human_id, User.id, SpaceUserMembership.status)
        .join(User, User.id == SpaceUserMembership.user_id)
        .where(SpaceUserMembership.id.in_(list(membership_ids)))
    )).all()
    return {mid: (hu, uid, status) for mid, hu, uid, status in rows}


async def migrate(dry_run: bool) -> None:
    async with async_session() as db:
        conversations = (await db.scalars(select(TeamConversation))).all()
        print(f"team conversations: {len(conversations)}")
        for conv in conversations:
            room_id = f"rm_team_{conv.id.hex[:20]}"
            if await db.scalar(select(Room.room_id).where(Room.room_id == room_id)):
                print(f"  {room_id}: already migrated")
                continue
            creator = (await _human_ids_for(db, [conv.creator_membership_id])).get(conv.creator_membership_id)
            if conv.visibility == "organization" and conv.kind == "room":
                member_mids = (await db.scalars(select(SpaceUserMembership.id).where(
                    SpaceUserMembership.space_id == conv.space_id, SpaceUserMembership.status == "active"))).all()
            else:
                member_mids = (await db.scalars(select(TeamConversationMember.membership_id).where(
                    TeamConversationMember.conversation_id == conv.id))).all()
            people = await _human_ids_for(db, set(member_mids) | {conv.creator_membership_id})
            member_hus = [hu for mid, (hu, _uid, status) in people.items()
                          if status == "active" and (mid in set(member_mids) or mid == conv.creator_membership_id)]
            owner_hu = creator[0] if creator else (member_hus[0] if member_hus else None)
            if owner_hu is None:
                print(f"  {room_id}: no active participants, skipped")
                continue
            messages = (await db.scalars(select(TeamMessage).where(TeamMessage.conversation_id == conv.id)
                                         .order_by(TeamMessage.sequence))).all()
            print(f"  {room_id}: {conv.kind}/{conv.visibility} '{conv.name}' "
                  f"members={len(member_hus)} messages={len(messages)}")
            if dry_run:
                continue
            db.add(Room(
                room_id=room_id, name=conv.name, owner_id=owner_hu, owner_type=ParticipantType.human,
                visibility=RoomVisibility.private, join_policy=RoomJoinPolicy.invite_only,
                max_members=2 if conv.kind == "dm" else None, default_send=True,
                space_id=conv.space_id, space_kind=conv.kind, space_visibility=conv.visibility,
            ))
            await db.flush()
            for hu in dict.fromkeys(member_hus):
                db.add(RoomMember(room_id=room_id, agent_id=hu, participant_type=ParticipantType.human,
                                  role=RoomRole.owner if hu == owner_hu else RoomRole.member,
                                  last_viewed_at=datetime.datetime.now(datetime.timezone.utc)))
            authors = await _human_ids_for(db, {m.author_membership_id for m in messages})
            for message in messages:
                author = authors.get(message.author_membership_id)
                if author is None:
                    continue
                sender_hu, sender_uid, _ = author
                msg_id = str(uuid.uuid5(_MSG_NAMESPACE, f"{conv.id}:{message.sequence}"))
                envelope = json.dumps({
                    "v": "a2a/0.1", "msg_id": msg_id, "ts": int(message.created_at.timestamp()),
                    "from": sender_hu, "to": room_id, "type": "message", "reply_to": None, "topic": None,
                    "ttl_sec": 3600, "payload": {"text": message.content}, "payload_hash": "",
                    "sig": {"alg": "ed25519", "key_id": "dashboard-human", "value": ""}, "mentions": None,
                })
                for receiver in dict.fromkeys(member_hus):
                    db.add(MessageRecord(
                        hub_msg_id=generate_hub_msg_id(), msg_id=msg_id, sender_id=sender_hu,
                        receiver_id=receiver, room_id=room_id, state=MessageState.delivered,
                        envelope_json=envelope, ttl_sec=3600, source_type="dashboard_human_room",
                        source_user_id=str(sender_uid), source_session_kind="room_human",
                        created_at=message.created_at, delivered_at=message.created_at,
                    ))
            await db.flush()
        if dry_run:
            await db.rollback()
            print("dry run: nothing written")
        else:
            await db.commit()
            print("done")


if __name__ == "__main__":
    asyncio.run(migrate("--dry-run" in sys.argv))

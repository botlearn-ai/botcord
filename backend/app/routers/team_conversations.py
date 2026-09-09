"""User-authenticated organization rooms and DMs, isolated from personal Rooms.

All operations serialize on the space lock shared with membership revocation.
Private access requires the exact admitted membership version. Admin roles and
DM policy settings do not bypass participant ACLs or enable Agent execution.
"""

import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.spaces import transaction
from hub.models import (SpaceUserMembership, TeamConversation, TeamConversationMember,
                        TeamConversationRead, TeamMessage, User)
from hub.services import spaces

router = APIRouter(prefix="/api/spaces/{space_id}/conversations", tags=["team-conversations"])


class ConversationIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: str = Field(default="room", pattern="^(room|dm)$")
    visibility: str = Field(default="organization", pattern="^(organization|private)$")
    name: str = Field(default="", max_length=128)
    member_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def valid_conversation(self):
        if self.kind == "dm" and (self.visibility != "private" or len(self.member_ids) != 1):
            raise ValueError("A DM requires one other member and private visibility")
        if self.kind == "room" and not self.name:
            raise ValueError("A room needs a name")
        if self.visibility == "organization" and self.member_ids:
            raise ValueError("Organization rooms are available to all active members")
        return self


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    content: str = Field(min_length=1, max_length=8000)
    client_id: UUID


class ReadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sequence: int = Field(ge=0)


async def actor_for(db, space_id, user_id):
    await spaces.organization_space(db, space_id)
    return await spaces.require_membership(db, space_id, user_id)


def visible_to(actor):
    return or_(TeamConversation.visibility == "organization", exists().where(
        TeamConversationMember.conversation_id == TeamConversation.id,
        TeamConversationMember.space_id == actor.space_id,
        TeamConversationMember.membership_id == actor.id,
        TeamConversationMember.membership_version == actor.version,
    ))


async def conversation_for(db, space_id, conversation_id, actor):
    conversation = await db.scalar(select(TeamConversation).where(
        TeamConversation.id == conversation_id, TeamConversation.space_id == space_id,
        visible_to(actor),
    ).execution_options(populate_existing=True))
    if conversation is None:
        spaces.reject("conversation_not_available", 404)
    return conversation


async def conversations_out(db, conversations, actor):
    if not conversations:
        return []
    ids = [c.id for c in conversations]
    participant_rows = (await db.execute(select(TeamConversationMember.conversation_id, SpaceUserMembership, User)
        .join(SpaceUserMembership, and_(
            TeamConversationMember.membership_id == SpaceUserMembership.id,
            TeamConversationMember.membership_version == SpaceUserMembership.version,
        ))
        .join(User, User.id == SpaceUserMembership.user_id)
        .where(TeamConversationMember.conversation_id.in_(ids),
               SpaceUserMembership.status == "active", User.status == "active", User.banned_at.is_(None)))).all()
    participants = {}
    for conversation_id, member, user in participant_rows:
        participants.setdefault(conversation_id, []).append({
            "user_id": user.id, "membership_id": member.id, "display_name": user.display_name})
    reads = {r.conversation_id: r.last_sequence for r in (await db.scalars(select(TeamConversationRead).where(
        TeamConversationRead.conversation_id.in_(ids), TeamConversationRead.membership_id == actor.id))).all()}
    latest = {m.conversation_id: m.content[:160] for m in (await db.scalars(select(TeamMessage)
        .join(TeamConversation, and_(TeamConversation.id == TeamMessage.conversation_id,
                                    TeamConversation.last_sequence == TeamMessage.sequence))
        .where(TeamMessage.conversation_id.in_(ids)))).all()}
    return [{
        "id": c.id, "space_id": c.space_id, "kind": c.kind, "visibility": c.visibility,
        "name": c.name, "updated_at": c.updated_at, "last_sequence": c.last_sequence,
        "unread_count": max(0, c.last_sequence - reads.get(c.id, 0)),
        "last_message": latest.get(c.id), "participants": participants.get(c.id, []),
        "can_send": c.kind != "dm" or len(participants.get(c.id, [])) == 2,
    } for c in conversations]


async def conversation_out(db, conversation, actor):
    return (await conversations_out(db, [conversation], actor))[0]


@router.get("")
async def list_conversations(space_id: UUID, ctx: RequestContext = Depends(require_user),
                             db: AsyncSession = Depends(transaction, scope="function")):
    actor = await actor_for(db, space_id, ctx.user_id)
    conversations = (await db.scalars(select(TeamConversation).where(
        TeamConversation.space_id == space_id, visible_to(actor),
    ).order_by(TeamConversation.updated_at.desc(), TeamConversation.id))).all()
    return {"conversations": await conversations_out(db, conversations, actor)}


@router.post("", status_code=201)
async def create_conversation(space_id: UUID, body: ConversationIn,
                              ctx: RequestContext = Depends(require_user),
                              db: AsyncSession = Depends(transaction, scope="function")):
    actor = await actor_for(db, space_id, ctx.user_id)
    members = {actor.id: actor}
    for membership_id in set(body.member_ids):
        member = await db.get(SpaceUserMembership, membership_id)
        if member is None or member.space_id != space_id or member.status != "active":
            spaces.reject("conversation_member_not_active", 422)
        await spaces.active_user(db, member.user_id)
        members[member.id] = member
    dm_key = None
    if body.kind == "dm":
        if len(members) != 2:
            spaces.reject("conversation_member_not_active", 422)
        dm_key = ":".join(sorted(f"{m.id}.{m.version}" for m in members.values()))
        existing = await db.scalar(select(TeamConversation).where(
            TeamConversation.space_id == space_id, TeamConversation.dm_key == dm_key))
        if existing:
            return await conversation_out(db, existing, actor)
    conversation = TeamConversation(space_id=space_id, creator_membership_id=actor.id,
        kind=body.kind, visibility=body.visibility, name=body.name, dm_key=dm_key)
    db.add(conversation)
    await db.flush()
    if body.visibility == "private":
        db.add_all([TeamConversationMember(space_id=space_id, conversation_id=conversation.id,
            membership_id=m.id, membership_version=m.version) for m in members.values()])
    spaces.audit(db, space_id, ctx.user_id, "conversation.created", conversation.id,
                 kind=body.kind, visibility=body.visibility)
    await db.flush()
    return await conversation_out(db, conversation, actor)


@router.get("/{conversation_id}/messages")
async def messages(space_id: UUID, conversation_id: UUID,
                   before: int | None = Query(None, ge=1), after: int | None = Query(None, ge=0),
                   limit: int = Query(50, ge=1, le=100),
                   ctx: RequestContext = Depends(require_user),
                   db: AsyncSession = Depends(transaction, scope="function")):
    actor = await actor_for(db, space_id, ctx.user_id)
    conversation = await conversation_for(db, space_id, conversation_id, actor)
    if before is not None and after is not None:
        spaces.reject("invalid_message_cursor", 422)
    query = select(TeamMessage, SpaceUserMembership, User).join(
        SpaceUserMembership, SpaceUserMembership.id == TeamMessage.author_membership_id
    ).join(User, User.id == SpaceUserMembership.user_id).where(
        TeamMessage.conversation_id == conversation_id, TeamMessage.space_id == space_id)
    if before is not None:
        query = query.where(TeamMessage.sequence < before)
    if after is not None:
        query = query.where(TeamMessage.sequence > after)
    query = query.order_by(TeamMessage.sequence.asc() if after is not None else TeamMessage.sequence.desc()).limit(limit + 1)
    rows = (await db.execute(query)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    if after is None:
        rows.reverse()
    return {"messages": [message_out(m, membership.user_id, u.display_name) for m, membership, u in rows],
            "has_more": has_more, "last_sequence": conversation.last_sequence}


def message_out(message, user_id, name):
    return {"sequence": message.sequence, "conversation_id": message.conversation_id,
            "client_id": message.client_id, "author_user_id": user_id,
            "author_name": name, "content": message.content, "created_at": message.created_at}


@router.post("/{conversation_id}/messages", status_code=201)
async def send_message(space_id: UUID, conversation_id: UUID, body: MessageIn,
                       ctx: RequestContext = Depends(require_user),
                       db: AsyncSession = Depends(transaction, scope="function")):
    actor = await actor_for(db, space_id, ctx.user_id)
    conversation = await conversation_for(db, space_id, conversation_id, actor)
    user = await db.get(User, ctx.user_id)
    if conversation.kind == "dm" and not (await conversation_out(db, conversation, actor))["can_send"]:
        spaces.reject("conversation_not_writable", 409)
    existing = await db.scalar(select(TeamMessage).where(
        TeamMessage.conversation_id == conversation_id, TeamMessage.author_membership_id == actor.id,
        TeamMessage.client_id == body.client_id))
    if existing:
        if existing.content != body.content:
            spaces.reject("message_retry_conflict", 409)
        return message_out(existing, user.id, user.display_name)
    conversation.last_sequence += 1
    conversation.updated_at = datetime.datetime.now(datetime.timezone.utc)
    message = TeamMessage(space_id=space_id, conversation_id=conversation_id,
        sequence=conversation.last_sequence, author_membership_id=actor.id,
        content=body.content, client_id=body.client_id)
    db.add(message)
    await db.flush()
    return message_out(message, user.id, user.display_name)


@router.put("/{conversation_id}/read")
async def mark_read(space_id: UUID, conversation_id: UUID, body: ReadIn,
                    ctx: RequestContext = Depends(require_user),
                    db: AsyncSession = Depends(transaction, scope="function")):
    actor = await actor_for(db, space_id, ctx.user_id)
    conversation = await conversation_for(db, space_id, conversation_id, actor)
    sequence = min(body.sequence, conversation.last_sequence)
    read = await db.get(TeamConversationRead, (conversation_id, actor.id))
    if read:
        read.last_sequence = max(read.last_sequence, sequence)
    else:
        db.add(TeamConversationRead(space_id=space_id, conversation_id=conversation_id,
            membership_id=actor.id, last_sequence=sequence))
    return {"sequence": max(read.last_sequence, sequence) if read else sequence}

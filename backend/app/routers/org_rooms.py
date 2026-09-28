"""Organization rooms API (Team). Rooms are Hub Rooms scoped to a space.

Messaging itself uses the regular room endpoints
(``/api/dashboard/rooms/{room_id}/messages|send|read``); this router covers
listing, creation and who may be in an organization room.
"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.dashboard import _build_rooms_from_membership
from app.routers.spaces import transaction
from hub.models import Agent, Room, RoomMember, User
from hub.services import org_rooms as service
from hub.services import spaces

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["app-org-rooms"])


class RoomIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=128)
    visibility: Literal["organization", "private"] = "organization"
    member_ids: list[UUID] = Field(default_factory=list, max_length=200)
    agent_ids: list[str] = Field(default_factory=list, max_length=20)


class DmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_id: UUID


class MembersIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_ids: list[UUID] = Field(min_length=1, max_length=200)


class AgentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str = Field(pattern=r"^ag_[A-Za-z0-9]+$", max_length=32)


async def _viewer(db: AsyncSession, space_id: UUID, user_id: UUID) -> str:
    await spaces.require_membership(db, space_id, user_id)
    human_id = await db.scalar(select(User.human_id).where(User.id == user_id))
    if not human_id:
        spaces.reject("user_not_active")
    return human_id


async def _participants(db: AsyncSession, room_ids: list[str]) -> dict[str, list[dict]]:
    if not room_ids:
        return {}
    rows = (await db.execute(select(RoomMember).where(RoomMember.room_id.in_(room_ids)))).scalars().all()
    human_ids = {r.agent_id for r in rows if r.agent_id.startswith("hu_")}
    agent_ids = {r.agent_id for r in rows if r.agent_id.startswith("ag_")}
    names: dict[str, str] = {}
    if human_ids:
        names.update(dict((await db.execute(
            select(User.human_id, User.display_name).where(User.human_id.in_(human_ids)))).all()))
    if agent_ids:
        names.update(dict((await db.execute(
            select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(agent_ids)))).all()))
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.room_id, []).append({
            "id": r.agent_id,
            "kind": "agent" if r.agent_id.startswith("ag_") else "human",
            "display_name": names.get(r.agent_id, r.agent_id),
            "role": r.role.value if hasattr(r.role, "value") else str(r.role),
        })
    return out


@router.get("/rooms")
async def list_rooms(space_id: UUID, ctx: RequestContext = Depends(require_user),
                     db: AsyncSession = Depends(transaction, scope="function")):
    """Joined rooms/DMs of this organization (with unread + preview), plus
    organization-visible rooms the caller has not joined yet."""
    viewer = await _viewer(db, space_id, ctx.user_id)
    joined = [r for r in await _build_rooms_from_membership(viewer, db) if r.get("space_id") == str(space_id)]
    joined_ids = {r["room_id"] for r in joined}
    open_rooms = (await db.scalars(select(Room).where(
        Room.space_id == space_id, Room.space_kind == "room",
        Room.space_visibility == "organization",
        Room.room_id.notin_(joined_ids) if joined_ids else True,
    ))).all()
    counts = dict((await db.execute(
        select(RoomMember.room_id, func.count(RoomMember.id))
        .where(RoomMember.room_id.in_([r.room_id for r in open_rooms] or [""]))
        .group_by(RoomMember.room_id))).all())
    participants = await _participants(db, list(joined_ids))
    rooms = []
    for r in joined:
        people = participants.get(r["room_id"], [])
        peer = next((p for p in people if p["id"] != viewer), None)
        rooms.append({**r, "joined": True, "participants": people,
                      "dm_peer_name": peer["display_name"] if r.get("space_kind") == "dm" and peer else None})
    for room in open_rooms:
        rooms.append({
            "room_id": room.room_id, "name": room.name, "space_id": str(space_id),
            "space_kind": room.space_kind, "space_visibility": room.space_visibility,
            "member_count": counts.get(room.room_id, 0), "joined": False, "participants": [],
            "unread_count": 0, "has_unread": False, "last_message_preview": None,
            "last_sender_name": None, "last_message_at": None,
            "created_at": room.created_at.isoformat() if room.created_at else None,
        })
    return {"rooms": rooms, "viewer_id": viewer}


@router.post("/rooms", status_code=201)
async def create_room(space_id: UUID, body: RoomIn, ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    room = await service.create_room(db, space_id, ctx.user_id, name=body.name, visibility=body.visibility,
                                     member_ids=body.member_ids, agent_ids=body.agent_ids)
    return {"room_id": room.room_id, "space_kind": room.space_kind, "space_visibility": room.space_visibility}


@router.post("/dms", status_code=201)
async def open_dm(space_id: UUID, body: DmIn, ctx: RequestContext = Depends(require_user),
                  db: AsyncSession = Depends(transaction, scope="function")):
    room = await service.open_dm(db, space_id, ctx.user_id, body.member_id)
    return {"room_id": room.room_id, "space_kind": "dm"}


class AgentDmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str = Field(pattern=r"^ag_[A-Za-z0-9]+$", max_length=32)


@router.post("/agent-dms", status_code=201)
async def open_agent_dm(space_id: UUID, body: AgentDmIn, ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    """Talk to your own organization agent, or one shared with you, inside Team."""
    room = await service.open_agent_dm(db, space_id, ctx.user_id, body.agent_id)
    return {"room_id": room.room_id, "space_kind": "dm"}


@router.post("/rooms/{room_id}/join")
async def join_room(space_id: UUID, room_id: str, ctx: RequestContext = Depends(require_user),
                    db: AsyncSession = Depends(transaction, scope="function")):
    room = await service.join_room(db, space_id, ctx.user_id, room_id)
    return {"room_id": room.room_id, "joined": True}


@router.get("/rooms/{room_id}/participants")
async def participants(space_id: UUID, room_id: str, ctx: RequestContext = Depends(require_user),
                       db: AsyncSession = Depends(transaction, scope="function")):
    viewer = await _viewer(db, space_id, ctx.user_id)
    room = await service.space_room(db, space_id, room_id)
    people = (await _participants(db, [room_id])).get(room_id, [])
    if not any(p["id"] == viewer for p in people) and room.space_visibility != "organization":
        spaces.reject("room_not_found", 404)
    return {"participants": people}


@router.post("/rooms/{room_id}/members")
async def add_members(space_id: UUID, room_id: str, body: MembersIn,
                      ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    return {"added": await service.add_members(db, space_id, ctx.user_id, room_id, body.member_ids)}


@router.post("/rooms/{room_id}/agents", status_code=201)
async def add_agent(space_id: UUID, room_id: str, body: AgentIn,
                    ctx: RequestContext = Depends(require_user),
                    db: AsyncSession = Depends(transaction, scope="function")):
    await service.add_agent(db, space_id, ctx.user_id, room_id, body.agent_id)
    return {"room_id": room_id, "agent_id": body.agent_id}


@router.delete("/rooms/{room_id}/participants/{participant_id}")
async def remove_participant(space_id: UUID, room_id: str, participant_id: str,
                             ctx: RequestContext = Depends(require_user),
                             db: AsyncSession = Depends(transaction, scope="function")):
    await service.remove_participant(db, space_id, ctx.user_id, room_id, participant_id)
    return {"removed": participant_id}

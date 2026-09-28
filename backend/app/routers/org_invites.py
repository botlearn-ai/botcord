"""Shareable organization invite links (manager API + public landing API)."""

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.spaces import transaction
from hub.models import SpaceInviteLink
from hub.services import org_invites as service

# Manager endpoints sit behind the beta gate like the rest of the spaces API.
router = APIRouter(prefix="/api", tags=["app-org-invites"])
# Landing endpoints must work for people who just signed up (no beta gate).
public_router = APIRouter(prefix="/api/org-invites", tags=["app-org-invites"])


class InviteLinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expires_in_days: int | None = Field(default=7, ge=1, le=90)
    max_uses: int | None = Field(default=None, ge=1, le=service.MAX_USES_LIMIT)


def link_out(link: SpaceInviteLink) -> dict:
    return {
        "id": link.id,
        "space_id": link.space_id,
        "code": link.code,
        "path": f"/join/{link.code}",
        "max_uses": link.max_uses,
        "use_count": link.use_count,
        "expires_at": link.expires_at,
        "status": service.link_status(link),
        "created_at": link.created_at,
    }


@router.post("/spaces/{space_id}/invite-links", status_code=201)
async def create_link(space_id: UUID, body: InviteLinkIn,
                      ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    link = await service.create_link(db, space_id, ctx.user_id,
                                     expires_in_days=body.expires_in_days, max_uses=body.max_uses)
    return link_out(link)


@router.get("/spaces/{space_id}/invite-links")
async def list_links(space_id: UUID, ctx: RequestContext = Depends(require_user),
                     db: AsyncSession = Depends(transaction, scope="function")):
    return {"links": [link_out(link) for link in await service.list_links(db, space_id, ctx.user_id)]}


@router.delete("/spaces/{space_id}/invite-links/{link_id}")
async def revoke_link(space_id: UUID, link_id: UUID, ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    return link_out(await service.revoke_link(db, space_id, ctx.user_id, link_id))


@public_router.get("/{code}")
async def preview(code: str, db: AsyncSession = Depends(transaction, scope="function")):
    """Unauthenticated preview shown on the /join/<code> landing page."""
    return await service.preview(db, code)


@public_router.post("/{code}/accept")
async def accept(code: str, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    membership = await service.accept(db, code, ctx.user_id)
    return {"space_id": membership.space_id, "status": membership.status}

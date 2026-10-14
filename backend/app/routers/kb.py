"""Dashboard Space knowledge base API: browse, edit, and review drafts."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.routers.kb import MetaIn, PageIn, transaction
from hub.services import kb

router = APIRouter(prefix="/api/spaces/{space_id}/kb", tags=["app-kb"])


class DirIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=kb.MAX_PATH_LEN)
    description: str | None = None


class RejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(default=None, max_length=1000)


async def _actor(db: AsyncSession, space_id: UUID, ctx: RequestContext) -> kb.Actor:
    return await kb.user_actor(db, space_id, ctx.user_id)


@router.get("/tree")
async def get_tree(space_id: UUID, ctx: RequestContext = Depends(require_user), db: AsyncSession = Depends(get_db)):
    actor = await _actor(db, space_id, ctx)
    nodes = await kb.tree(db, space_id, "/", depth=None, summary=True, include_drafts=True)
    return {"nodes": nodes, "can_publish": actor.can_publish}


@router.get("/page")
async def get_page(space_id: UUID, path: str, ctx: RequestContext = Depends(require_user),
                   db: AsyncSession = Depends(get_db)):
    await _actor(db, space_id, ctx)
    node = await kb.get_node(db, space_id, kb.normalize_path(path), include_drafts=True)
    out = kb.node_out(node, content=True)
    out["pending_revisions"] = await kb.list_revisions(db, space_id, path=node.path)
    return out


@router.get("/search")
async def search_pages(space_id: UUID, q: str, limit: int = Query(20, ge=1, le=50),
                       ctx: RequestContext = Depends(require_user), db: AsyncSession = Depends(get_db)):
    await _actor(db, space_id, ctx)
    return {"results": await kb.search(db, space_id, q, "/", limit=limit)}


@router.put("/page")
async def put_page(space_id: UUID, body: PageIn, ctx: RequestContext = Depends(require_user),
                   db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return await kb.write_page(db, space_id, actor, **body.kwargs())


@router.patch("/meta")
async def patch_meta(space_id: UUID, body: MetaIn, ctx: RequestContext = Depends(require_user),
                     db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return await kb.set_meta(db, space_id, actor, **body.model_dump())


@router.post("/dirs", status_code=201)
async def create_dir(space_id: UUID, body: DirIn, ctx: RequestContext = Depends(require_user),
                     db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return await kb.make_dir(db, space_id, actor, path=body.path, description=body.description)


@router.delete("/node")
async def delete_node(space_id: UUID, path: str, ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return {"deleted": await kb.delete_node(db, space_id, actor, path=path)}


@router.get("/revisions")
async def list_revisions(space_id: UUID, status: str = Query("proposed", pattern=r"^(proposed|published|rejected|superseded)$"),
                         ctx: RequestContext = Depends(require_user), db: AsyncSession = Depends(get_db)):
    await _actor(db, space_id, ctx)
    return {"revisions": await kb.list_revisions(db, space_id, status=status)}


@router.get("/revisions/{revision_id}")
async def get_revision(space_id: UUID, revision_id: str, ctx: RequestContext = Depends(require_user),
                       db: AsyncSession = Depends(get_db)):
    await _actor(db, space_id, ctx)
    rev, node = await kb.get_revision(db, space_id, revision_id)
    return {
        "revision": kb.revision_out(rev, path=node.path, content=True),
        "current": kb.node_out(node, content=True) if node.version > 0 else None,
    }


@router.post("/revisions/{revision_id}/approve")
async def approve(space_id: UUID, revision_id: str, ctx: RequestContext = Depends(require_user),
                  db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return await kb.approve(db, space_id, actor, revision_id)


@router.post("/revisions/{revision_id}/reject")
async def reject(space_id: UUID, revision_id: str, body: RejectIn, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    actor = await _actor(db, space_id, ctx)
    return await kb.reject_revision(db, space_id, actor, revision_id, body.note)

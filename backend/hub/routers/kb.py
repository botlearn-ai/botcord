"""Agent-facing Space knowledge base API (``botcord kb``).

Agents read published pages, write drafts (``/archive/`` publishes directly)
and fill description/summary metadata. See docs/space-knowledge-base-design.md.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_claimed_agent
from hub.database import get_db
from hub.services import kb

router = APIRouter(prefix="/hub/kb", tags=["kb"])


async def transaction(db: AsyncSession = Depends(get_db)):
    try:
        yield db
        await db.commit()
    except kb.CommitThenFail:
        await db.commit()
        raise
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="kb_conflict")
    except Exception:
        await db.rollback()
        raise


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = Field(pattern=r"^(room|topic|message|file|url)$")
    id: str = Field(min_length=1, max_length=512)


class PageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=kb.MAX_PATH_LEN)
    content: str
    title: str | None = None
    description: str | None = None
    summary: str | None = None
    tags: list[str] | None = None
    source_refs: list[SourceRef] | None = None
    base_version: int | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=1000)

    def kwargs(self) -> dict:
        data = self.model_dump()
        if self.source_refs is not None:
            data["source_refs"] = [r.model_dump() for r in self.source_refs]
        return data


class MetaIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=kb.MAX_PATH_LEN)
    description: str | None = None
    summary: str | None = None
    content_hash: str | None = Field(default=None, max_length=64)


@router.get("/spaces")
async def list_spaces(agent_id: str = Depends(get_current_claimed_agent), db: AsyncSession = Depends(get_db)):
    return {"spaces": await kb.agent_spaces(db, agent_id)}


@router.get("/{space_id}/context")
async def get_context(space_id: UUID, agent_id: str = Depends(get_current_claimed_agent),
                      db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    return await kb.context(db, space_id)


@router.get("/{space_id}/tree")
async def get_tree(space_id: UUID, path: str = "/", depth: int = Query(2, ge=1, le=kb.MAX_DEPTH),
                   summary: bool = False, agent_id: str = Depends(get_current_claimed_agent),
                   db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    prefix = kb.normalize_path(path, allow_root=True)
    return {"path": prefix, "nodes": await kb.tree(db, space_id, prefix, depth=depth, summary=summary)}


@router.get("/{space_id}/page")
async def get_page(space_id: UUID, path: str, agent_id: str = Depends(get_current_claimed_agent),
                   db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    node = await kb.get_node(db, space_id, kb.normalize_path(path))
    return kb.node_out(node, content=True)


@router.get("/{space_id}/grep")
async def grep_pages(space_id: UUID, pattern: str, path: str = "/", limit: int = Query(50, ge=1, le=200),
                     agent_id: str = Depends(get_current_claimed_agent), db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    return await kb.grep(db, space_id, pattern, kb.normalize_path(path, allow_root=True), limit=limit)


@router.get("/{space_id}/search")
async def search_pages(space_id: UUID, q: str, path: str = "/", limit: int = Query(10, ge=1, le=50),
                       agent_id: str = Depends(get_current_claimed_agent), db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    results = await kb.search(db, space_id, q, kb.normalize_path(path, allow_root=True), limit=limit)
    return {"results": results}


@router.put("/{space_id}/page")
async def put_page(space_id: UUID, body: PageIn, agent_id: str = Depends(get_current_claimed_agent),
                   db: AsyncSession = Depends(transaction, scope="function")):
    actor = await kb.agent_actor(db, space_id, agent_id)
    return await kb.write_page(db, space_id, actor, **body.kwargs())


@router.patch("/{space_id}/meta")
async def patch_meta(space_id: UUID, body: MetaIn, agent_id: str = Depends(get_current_claimed_agent),
                     db: AsyncSession = Depends(transaction, scope="function")):
    actor = await kb.agent_actor(db, space_id, agent_id)
    return await kb.set_meta(db, space_id, actor, **body.model_dump())


@router.get("/{space_id}/drafts")
async def list_my_drafts(space_id: UUID,
                         status: str | None = Query(None, pattern=r"^(proposed|published|rejected|superseded)$"),
                         limit: int = Query(20, ge=1, le=100),
                         agent_id: str = Depends(get_current_claimed_agent), db: AsyncSession = Depends(get_db)):
    """The calling agent's own writes and their review outcome (reviewer note included)."""
    await kb.agent_actor(db, space_id, agent_id)
    return {"revisions": await kb.list_revisions(db, space_id, status=status, author=agent_id, limit=limit)}


@router.get("/{space_id}/meta-queue")
async def get_meta_queue(space_id: UUID, limit: int = Query(20, ge=1, le=100),
                         agent_id: str = Depends(get_current_claimed_agent), db: AsyncSession = Depends(get_db)):
    await kb.agent_actor(db, space_id, agent_id)
    return {"nodes": await kb.meta_queue(db, space_id, limit=limit)}

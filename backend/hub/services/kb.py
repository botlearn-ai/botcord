"""Space knowledge base: a markdown tree per Space with agentic retrieval.

Design: docs/space-knowledge-base-design.md. The tree lives in ``kb_nodes``
(path is the only structure; parents derive from the prefix). A node row holds
the published state; every write is a ``kb_revisions`` row. Agents write drafts
except under ``/archive/``; owners/admins publish. Metadata (description /
summary) edits by agents apply directly but never overwrite human-owned text.

Callers own the transaction and commit once after a successful operation.
"""

from __future__ import annotations

import datetime
import hashlib
import re
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from hub.models import KbNode, KbRevision, Organization, Space, SpaceAgentMembership, User
from hub.services import spaces

MAX_DEPTH = 6
MAX_PATH_LEN = 512
MAX_PAGE_BYTES = 50_000
MAX_TITLE_LEN = 256
MAX_DESCRIPTION_LEN = 200
MAX_SUMMARY_LEN = 500
MAX_TAGS = 16
ARCHIVE_PREFIX = "/archive/"
README_PATH = "/README.md"
CONTEXT_README_CHARS = 2000
CONTEXT_INDEX_ENTRIES = 40
GREP_MAX_PATTERN = 200
GREP_LINE_CHARS = 300
SEARCH_MAX_TOKENS = 12
SEARCH_CANDIDATES = 200

_SEGMENT_FORBIDDEN = re.compile(r"[\s\x00-\x1f\x7f\\]")
_CJK = re.compile(r"[㐀-鿿豈-﫿]")


def _reject(code: str, status: int = 400, **extra):
    detail = {"code": code, **extra} if extra else code
    raise HTTPException(status_code=status, detail=detail)


class CommitThenFail(HTTPException):
    """An error response whose side effects (e.g. marking a draft superseded) must still commit."""


@dataclass(frozen=True)
class Actor:
    id: str  # ag_... | hu_...
    kind: str  # 'agent' | 'human'
    can_publish: bool


# ── Paths ─────────────────────────────────────────────────────────


def normalize_path(raw: str | None, *, kind: str | None = None, allow_root: bool = False) -> str:
    path = (raw or "").strip()
    if allow_root and path in ("", "/"):
        return "/"
    if not path.startswith("/"):
        path = "/" + path
    path = path.rstrip("/") if path != "/" else path
    if path == "/" or len(path) > MAX_PATH_LEN:
        _reject("kb_invalid_path")
    segments = path[1:].split("/")
    if len(segments) > MAX_DEPTH:
        _reject("kb_path_too_deep")
    for seg in segments:
        if not seg or seg in (".", "..") or _SEGMENT_FORBIDDEN.search(seg):
            _reject("kb_invalid_path")
    is_page = path.endswith(".md")
    if kind == "page" and not is_page:
        _reject("kb_page_path_must_end_with_md")
    if kind == "dir" and is_page:
        _reject("kb_dir_path_must_not_end_with_md")
    return path


def parent_of(path: str) -> str:
    head = path.rsplit("/", 1)[0]
    return head or "/"


def _ancestors(path: str) -> list[str]:
    """Parent dirs from shallowest to deepest, excluding root."""
    segments = path[1:].split("/")[:-1]
    return ["/" + "/".join(segments[: i + 1]) for i in range(len(segments))]


def _under(prefix: str):
    if prefix == "/":
        return true()
    return or_(KbNode.path == prefix, KbNode.path.startswith(prefix + "/", autoescape=True))


def _depth(path: str) -> int:
    return 0 if path == "/" else path.count("/")


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ── Access ────────────────────────────────────────────────────────


async def agent_actor(db: AsyncSession, space_id: UUID, agent_id: str) -> Actor:
    await spaces.require_agent_membership(db, space_id, agent_id)
    return Actor(id=agent_id, kind="agent", can_publish=False)


async def user_actor(db: AsyncSession, space_id: UUID, user_id: UUID) -> Actor:
    membership = await spaces.require_membership(db, space_id, user_id)
    human_id = await db.scalar(select(User.human_id).where(User.id == user_id))
    roles = await spaces.roles_for(db, membership)
    return Actor(id=human_id, kind="human", can_publish=bool(roles & {"owner", "admin"}))


async def agent_spaces(db: AsyncSession, agent_id: str) -> list[dict]:
    rows = (await db.execute(
        select(Space.id, Space.kind, Organization.name)
        .join(SpaceAgentMembership, SpaceAgentMembership.space_id == Space.id)
        .outerjoin(Organization, Organization.space_id == Space.id)
        .where(SpaceAgentMembership.agent_id == agent_id, SpaceAgentMembership.status == "active",
               Space.status == "active")
        .order_by(Space.kind.desc(), Organization.name)
    )).all()
    return [{"space_id": str(r.id), "kind": r.kind, "name": r.name or "Personal"} for r in rows]


# ── Serialization ─────────────────────────────────────────────────


def summary_stale(node: KbNode) -> bool:
    return bool(node.summary) and node.summary_source_hash != node.content_hash


def node_out(node: KbNode, *, summary: bool = False, content: bool = False) -> dict:
    out = {
        "node_id": node.node_id,
        "path": node.path,
        "kind": node.kind,
        "title": node.title,
        "description": node.description or None,
        "description_missing": not node.description,
        "description_source": node.description_source,
        "tags": list(node.tags or []),
        "version": node.version,
        "pending": node.pending_count,
        "size_bytes": node.size_bytes,
        "updated_by": node.updated_by,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
    }
    if summary or content:
        out.update({
            "summary": node.summary,
            "summary_source": node.summary_source,
            "summary_stale": summary_stale(node),
            "summary_missing": not node.summary,
        })
    if content:
        out.update({
            "content": node.content if node.kind == "page" else None,
            "content_hash": node.content_hash,
            "source_refs": list(node.source_refs or []),
            "created_by": node.created_by,
        })
    return out


def revision_out(rev: KbRevision, *, path: str | None = None, content: bool = False) -> dict:
    out = {
        "revision_id": rev.revision_id,
        "node_id": rev.node_id,
        "path": path,
        "kind": rev.kind,
        "base_version": rev.base_version,
        "status": rev.status,
        "title": rev.title,
        "description": rev.description,
        "summary": rev.summary,
        "tags": rev.tags,
        "author": rev.author,
        "reviewer": rev.reviewer,
        "note": rev.note,
        "created_at": rev.created_at.isoformat() if rev.created_at else None,
        "reviewed_at": rev.reviewed_at.isoformat() if rev.reviewed_at else None,
    }
    if content:
        out["content"] = rev.content
        out["source_refs"] = rev.source_refs
    return out


# ── Lookups ───────────────────────────────────────────────────────


async def _live_node(db: AsyncSession, space_id: UUID, path: str, *, lock: bool = False) -> KbNode | None:
    query = select(KbNode).where(KbNode.space_id == space_id, KbNode.path == path, KbNode.deleted_at.is_(None))
    if lock:
        query = query.with_for_update()
    return await db.scalar(query)


async def get_node(db: AsyncSession, space_id: UUID, path: str, *, include_drafts: bool = False) -> KbNode:
    node = await _live_node(db, space_id, path)
    if node is None or (node.kind == "page" and node.version == 0 and not include_drafts):
        _reject("kb_node_not_found", 404)
    return node


def _tree_order(path: str) -> tuple:
    """Parents before children, README.md first in its folder, then code-point order.

    Sorted in Python so the order does not depend on the database collation.
    """
    return tuple((seg != "README.md", seg) for seg in path[1:].split("/"))


async def _subtree(db: AsyncSession, space_id: UUID, prefix: str, *, with_content: bool = False) -> list[KbNode]:
    query = select(KbNode).where(KbNode.space_id == space_id, KbNode.deleted_at.is_(None), _under(prefix))
    if not with_content:
        query = query.options(defer(KbNode.content))
    return sorted((await db.scalars(query)).all(), key=lambda n: _tree_order(n.path))


def _visible(nodes: list[KbNode], *, include_drafts: bool) -> list[KbNode]:
    """Drop draft-only pages and dirs with nothing visible underneath."""
    pages = [n for n in nodes if n.kind == "page" and (include_drafts or n.version > 0)]
    keep_dirs = {a for p in pages for a in _ancestors(p.path)}
    explicit = {n.path for n in nodes if n.kind == "dir" and (n.description or include_drafts)}
    keep_dirs |= {a for d in explicit for a in [*_ancestors(d), d]}
    page_ids = {p.node_id for p in pages}
    return [n for n in nodes if n.node_id in page_ids or (n.kind == "dir" and n.path in keep_dirs)]


# ── Read operations ───────────────────────────────────────────────


async def tree(db: AsyncSession, space_id: UUID, prefix: str = "/", *, depth: int | None = 2,
               summary: bool = False, include_drafts: bool = False) -> list[dict]:
    nodes = _visible(await _subtree(db, space_id, prefix), include_drafts=include_drafts)
    base = _depth(prefix)
    out = []
    for n in nodes:
        rel = _depth(n.path) - base
        if n.path == prefix or (depth is not None and rel > depth):
            continue
        item = node_out(n, summary=summary)
        if n.kind == "dir":
            item["children"] = sum(1 for c in nodes if parent_of(c.path) == n.path)
        out.append(item)
    return out


def _line_hits(content: str, needle: str, limit: int) -> list[tuple[int, str]]:
    hits = []
    low = needle.lower()
    for i, line in enumerate(content.splitlines(), start=1):
        if low in line.lower():
            hits.append((i, line[:GREP_LINE_CHARS]))
            if len(hits) >= limit:
                break
    return hits


async def grep(db: AsyncSession, space_id: UUID, pattern: str, prefix: str = "/", *, limit: int = 50) -> dict:
    """Case-insensitive fixed-string match over published page bodies."""
    pattern = pattern.strip()
    if not pattern or len(pattern) > GREP_MAX_PATTERN:
        _reject("kb_invalid_pattern")
    pages = (await db.scalars(
        select(KbNode).where(
            KbNode.space_id == space_id, KbNode.deleted_at.is_(None), KbNode.kind == "page",
            KbNode.version > 0, _under(prefix), KbNode.content.icontains(pattern, autoescape=True),
        ).order_by(KbNode.path)
    )).all()
    matches, truncated = [], False
    for page in pages:
        for line_no, line in _line_hits(page.content or "", pattern, limit - len(matches)):
            matches.append({"path": page.path, "line": line_no, "text": line})
        if len(matches) >= limit:
            truncated = True
            break
    return {"matches": matches, "truncated": truncated}


def _search_terms(query: str) -> list[tuple[str, float]]:
    terms: dict[str, float] = {}
    for token in query.split():
        token = token.strip()
        if not token:
            continue
        terms.setdefault(token, 1.0)
        # CJK has no word boundaries: long runs also match by their bigrams, at lower weight.
        if _CJK.search(token) and len(token) >= 4:
            for i in range(len(token) - 1):
                terms.setdefault(token[i:i + 2], 0.4)
    return list(terms.items())[:SEARCH_MAX_TOKENS]


def _snippet(content: str, terms: list[tuple[str, float]]) -> str | None:
    for term, _ in sorted(terms, key=lambda t: -t[1]):
        hits = _line_hits(content, term, 1)
        if hits:
            return f"L{hits[0][0]}: {hits[0][1]}"
    return None


async def search(db: AsyncSession, space_id: UUID, query: str, prefix: str = "/", *, limit: int = 10) -> list[dict]:
    terms = _search_terms(query)
    if not terms:
        _reject("kb_invalid_query")
    fields = (KbNode.title, KbNode.description, KbNode.summary, KbNode.content)
    pages = (await db.scalars(
        select(KbNode).where(
            KbNode.space_id == space_id, KbNode.deleted_at.is_(None), KbNode.kind == "page",
            KbNode.version > 0, _under(prefix),
            or_(*(f.icontains(t, autoescape=True) for t, _ in terms for f in fields)),
        ).limit(SEARCH_CANDIDATES)
    )).all()
    scored = []
    for page in pages:
        head = f"{page.path} {page.title or ''}".lower()
        meta = f"{page.description or ''} {page.summary or ''}".lower()
        body = (page.content or "").lower()
        score = 0.0
        for term, weight in terms:
            t = term.lower()
            score += weight * (3 * (t in head) + 2 * (t in meta) + (t in body))
        if score > 0:
            scored.append((score, page))
    scored.sort(key=lambda s: (-s[0], s[1].path))
    out = []
    for score, page in scored[:limit]:
        item = node_out(page, summary=True)
        item["score"] = round(score, 2)
        item["snippet"] = _snippet(page.content or "", terms)
        out.append(item)
    return out


async def context(db: AsyncSession, space_id: UUID) -> dict:
    """Per-turn injection payload: README plus the top-level index."""
    space = await db.get(Space, space_id)
    org_name = await db.scalar(select(Organization.name).where(Organization.space_id == space_id))
    nodes = _visible(await _subtree(db, space_id, "/", with_content=False), include_drafts=False)
    readme = await _live_node(db, space_id, README_PATH)
    readme_text = None
    if readme is not None and readme.version > 0:
        readme_text = (readme.content or "")[:CONTEXT_README_CHARS]
    index = []
    for n in nodes:
        if _depth(n.path) != 1 or n.path == README_PATH:
            continue
        item = {"path": n.path, "kind": n.kind, "title": n.title,
                "description": n.description or None}
        if n.kind == "dir":
            item["children"] = sum(1 for c in nodes if parent_of(c.path) == n.path)
        index.append(item)
    return {
        "space_id": str(space_id),
        "space_name": org_name or ("Personal" if space and space.kind == "personal" else None),
        "readme": readme_text,
        "readme_truncated": bool(readme is not None and len(readme.content or "") > CONTEXT_README_CHARS),
        "index": index[:CONTEXT_INDEX_ENTRIES],
        "index_truncated": len(index) > CONTEXT_INDEX_ENTRIES,
        "page_count": sum(1 for n in nodes if n.kind == "page"),
    }


# ── Writes ────────────────────────────────────────────────────────


def _clean_text(value: str | None, limit: int, code: str) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if len(value) > limit:
        _reject(code)
    return value or None


def _clean_tags(tags: list[str] | None) -> list[str] | None:
    if tags is None:
        return None
    cleaned = []
    for tag in tags:
        tag = str(tag).strip()
        if tag and tag not in cleaned:
            cleaned.append(tag[:64])
    if len(cleaned) > MAX_TAGS:
        _reject("kb_too_many_tags")
    return cleaned


async def _refresh_dir_hashes(db: AsyncSession, space_id: UUID, path: str) -> None:
    """Recompute ancestor dir hashes bottom-up so their summaries go stale."""
    ancestors = _ancestors(path)
    if not ancestors:
        return
    nodes = await _subtree(db, space_id, ancestors[0])
    by_path = {n.path: n for n in nodes}
    for dir_path in reversed(ancestors):
        node = by_path.get(dir_path)
        if node is None or node.kind != "dir":
            continue
        children = sorted(
            (c for c in nodes if parent_of(c.path) == dir_path and (c.kind == "dir" or c.version > 0)),
            key=lambda c: c.path,
        )
        node.content_hash = _hash("\n".join(f"{c.path}:{c.content_hash or ''}" for c in children))
    await db.flush()


async def _ensure_dirs(db: AsyncSession, space_id: UUID, path: str, actor: Actor) -> None:
    for dir_path in _ancestors(path):
        existing = await _live_node(db, space_id, dir_path)
        if existing is None:
            db.add(KbNode(space_id=space_id, path=dir_path, kind="dir", version=1,
                          created_by=actor.id, updated_by=actor.id, created_at=_now(), updated_at=_now()))
            await db.flush()
        elif existing.kind != "dir":
            _reject("kb_parent_is_page", 409, path=dir_path)


async def _sync_pending(db: AsyncSession, node: KbNode) -> None:
    node.pending_count = await db.scalar(select(func.count()).select_from(KbRevision).where(
        KbRevision.node_id == node.node_id, KbRevision.status == "proposed")) or 0


def _apply_content(node: KbNode, rev: KbRevision, actor: Actor) -> None:
    content = rev.content or ""
    node.title = rev.title
    node.content = content
    node.content_hash = _hash(content)
    node.size_bytes = len(content.encode("utf-8"))
    if rev.tags is not None:
        node.tags = rev.tags
    if rev.source_refs is not None:
        node.source_refs = rev.source_refs
    if rev.description and not (actor.kind == "agent" and node.description_source == "human"):
        node.description = rev.description
        node.description_source = actor.kind
    if rev.summary:
        node.summary = rev.summary
        node.summary_source = actor.kind
        node.summary_source_hash = node.content_hash
    node.version += 1
    node.published_revision_id = rev.revision_id
    node.updated_by = rev.author
    node.updated_at = _now()


async def write_page(
    db: AsyncSession, space_id: UUID, actor: Actor, *, path: str, content: str, title: str | None = None,
    description: str | None = None, summary: str | None = None, tags: list[str] | None = None,
    source_refs: list[dict] | None = None, base_version: int | None = None, note: str | None = None,
) -> dict:
    path = normalize_path(path, kind="page")
    if len(content.encode("utf-8")) > MAX_PAGE_BYTES:
        _reject("kb_page_too_large", 413, max_bytes=MAX_PAGE_BYTES)
    title = _clean_text(title, MAX_TITLE_LEN, "kb_title_too_long") or path.rsplit("/", 1)[1][:-3]
    description = _clean_text(description, MAX_DESCRIPTION_LEN, "kb_description_too_long")
    summary = _clean_text(summary, MAX_SUMMARY_LEN, "kb_summary_too_long")
    if actor.kind == "agent" and (not description or not summary):
        _reject("kb_agent_requires_description_and_summary")

    node = await _live_node(db, space_id, path, lock=True)
    if node is None:
        if base_version not in (None, 0):
            _reject("kb_version_conflict", 409, current_version=0)
        await _ensure_dirs(db, space_id, path, actor)
        node = KbNode(space_id=space_id, path=path, kind="page", title=title, version=0,
                      created_by=actor.id, updated_by=actor.id, created_at=_now(), updated_at=_now())
        db.add(node)
        await db.flush()
    elif node.kind != "page":
        _reject("kb_path_is_dir", 409)
    elif base_version is None:
        _reject("kb_base_version_required", 409, current_version=node.version)
    elif base_version != node.version:
        _reject("kb_version_conflict", 409, current_version=node.version)

    publish = actor.can_publish or path.startswith(ARCHIVE_PREFIX)
    rev = KbRevision(
        node_id=node.node_id, space_id=space_id, base_version=node.version, kind="content",
        title=title, description=description, summary=summary, tags=_clean_tags(tags), content=content,
        source_refs=source_refs, status="published" if publish else "proposed", author=actor.id, note=note,
        created_at=_now(),
    )
    db.add(rev)
    await db.flush()
    if publish:
        rev.reviewed_at = _now()
        _apply_content(node, rev, actor)
        await db.flush()
        await _refresh_dir_hashes(db, space_id, path)
    await _sync_pending(db, node)
    await db.flush()
    return {"status": rev.status, "revision_id": rev.revision_id, "node": node_out(node, summary=True)}


async def set_meta(
    db: AsyncSession, space_id: UUID, actor: Actor, *, path: str, description: str | None = None,
    summary: str | None = None, content_hash: str | None = None,
) -> dict:
    """Metadata-only edit; applies directly and is recorded as a 'meta' revision."""
    if actor.kind == "human" and not actor.can_publish:
        _reject("kb_publish_role_required", 403)
    path = normalize_path(path)
    node = await _live_node(db, space_id, path, lock=True)
    if node is None or (node.kind == "page" and node.version == 0):
        _reject("kb_node_not_found", 404)
    description = _clean_text(description, MAX_DESCRIPTION_LEN, "kb_description_too_long")
    summary = _clean_text(summary, MAX_SUMMARY_LEN, "kb_summary_too_long")
    if description is None and summary is None:
        _reject("kb_meta_empty")
    result: dict[str, str] = {}
    if description is not None:
        if actor.kind == "agent" and node.description_source == "human":
            result["description"] = "skipped_human_owned"
        else:
            node.description, node.description_source = description, actor.kind
            result["description"] = "applied"
    if summary is not None:
        if content_hash != node.content_hash:
            _reject("kb_content_changed", 409, content_hash=node.content_hash)
        fresh_human = node.summary_source == "human" and node.summary_source_hash == node.content_hash
        if actor.kind == "agent" and fresh_human:
            result["summary"] = "skipped_human_owned"
        else:
            node.summary, node.summary_source = summary, actor.kind
            node.summary_source_hash = node.content_hash
            result["summary"] = "applied"
    if any(v == "applied" for v in result.values()):
        node.updated_at = _now()
        db.add(KbRevision(
            node_id=node.node_id, space_id=space_id, base_version=node.version, kind="meta",
            description=description if result.get("description") == "applied" else None,
            summary=summary if result.get("summary") == "applied" else None,
            status="published", author=actor.id, created_at=_now(), reviewed_at=_now(),
        ))
    await db.flush()
    return {"result": result, "node": node_out(node, summary=True)}


async def meta_queue(db: AsyncSession, space_id: UUID, *, limit: int = 20) -> list[dict]:
    """Nodes whose description is missing or whose summary is missing/stale.

    Pages first, then dirs deepest-first, so dir summaries build bottom-up.
    """
    nodes = _visible(await _subtree(db, space_id, "/"), include_drafts=False)
    todo = []
    for n in nodes:
        missing = []
        if not n.description:
            missing.append("description")
        if not n.summary:
            missing.append("summary")
        elif summary_stale(n):
            missing.append("summary_stale")
        if missing:
            todo.append((n, missing))
    todo.sort(key=lambda t: (t[0].kind != "page", -_depth(t[0].path), t[0].path))
    return [{"path": n.path, "kind": n.kind, "needs": needs, "content_hash": n.content_hash,
             "description_source": n.description_source} for n, needs in todo[:limit]]


async def make_dir(db: AsyncSession, space_id: UUID, actor: Actor, *, path: str,
                   description: str | None = None) -> dict:
    if not actor.can_publish:
        _reject("kb_publish_role_required", 403)
    path = normalize_path(path, kind="dir")
    description = _clean_text(description, MAX_DESCRIPTION_LEN, "kb_description_too_long")
    node = await _live_node(db, space_id, path)
    if node is not None:
        if node.kind != "dir":
            _reject("kb_path_is_page", 409)
    else:
        await _ensure_dirs(db, space_id, path, actor)
        node = KbNode(space_id=space_id, path=path, kind="dir", version=1,
                      created_by=actor.id, updated_by=actor.id, created_at=_now(), updated_at=_now())
        db.add(node)
        await db.flush()
        await _refresh_dir_hashes(db, space_id, path)
    if description:
        node.description, node.description_source = description, actor.kind
        node.updated_at = _now()
    await db.flush()
    return node_out(node, summary=True)


async def delete_node(db: AsyncSession, space_id: UUID, actor: Actor, *, path: str) -> int:
    if not actor.can_publish:
        _reject("kb_publish_role_required", 403)
    path = normalize_path(path)
    nodes = await _subtree(db, space_id, path)
    if not nodes:
        _reject("kb_node_not_found", 404)
    now = _now()
    ids = [n.node_id for n in nodes]
    for n in nodes:
        n.deleted_at = now
        n.pending_count = 0
    for rev in (await db.scalars(select(KbRevision).where(
            KbRevision.node_id.in_(ids), KbRevision.status == "proposed"))).all():
        rev.status, rev.reviewer, rev.reviewed_at = "rejected", actor.id, now
        rev.note = rev.note or "node deleted"
    await db.flush()
    await _refresh_dir_hashes(db, space_id, path)
    return len(nodes)


# ── Review ────────────────────────────────────────────────────────


async def list_revisions(db: AsyncSession, space_id: UUID, *, status: str | None = "proposed",
                         path: str | None = None, author: str | None = None, limit: int = 50) -> list[dict]:
    query = (select(KbRevision, KbNode.path).join(KbNode, KbNode.node_id == KbRevision.node_id)
             .where(KbRevision.space_id == space_id))
    if status:
        query = query.where(KbRevision.status == status)
    if author:
        # An author's own content writes; metadata fills apply directly and are not drafts.
        query = query.where(KbRevision.author == author, KbRevision.kind == "content")
    if path:
        query = query.where(KbNode.path == normalize_path(path))
    rows = (await db.execute(query.order_by(KbRevision.created_at.desc()).limit(limit))).all()
    return [revision_out(rev, path=p) for rev, p in rows]


async def get_revision(db: AsyncSession, space_id: UUID, revision_id: str) -> tuple[KbRevision, KbNode]:
    rev = await db.get(KbRevision, revision_id)
    if rev is None or rev.space_id != space_id:
        _reject("kb_revision_not_found", 404)
    node = await db.get(KbNode, rev.node_id)
    return rev, node


async def approve(db: AsyncSession, space_id: UUID, actor: Actor, revision_id: str) -> dict:
    if not actor.can_publish:
        _reject("kb_publish_role_required", 403)
    rev, node = await get_revision(db, space_id, revision_id)
    if rev.status != "proposed":
        _reject("kb_revision_not_pending", 409, status=rev.status)
    if node.deleted_at is not None:
        _reject("kb_node_not_found", 404)
    now = _now()
    if rev.base_version != node.version:
        rev.status, rev.reviewer, rev.reviewed_at = "superseded", actor.id, now
        await _sync_pending(db, node)
        await db.flush()
        raise CommitThenFail(status_code=409, detail={"code": "kb_revision_stale", "current_version": node.version})
    rev.status, rev.reviewer, rev.reviewed_at = "published", actor.id, now
    # The author's kind decides who "owns" the description/summary text.
    author = Actor(id=rev.author, kind="agent" if rev.author.startswith("ag_") else "human", can_publish=False)
    _apply_content(node, rev, author)
    await db.flush()
    await _refresh_dir_hashes(db, space_id, node.path)
    await _sync_pending(db, node)
    await db.flush()
    return {"status": "published", "node": node_out(node, summary=True)}


async def reject_revision(db: AsyncSession, space_id: UUID, actor: Actor, revision_id: str,
                          note: str | None = None) -> dict:
    if not actor.can_publish:
        _reject("kb_publish_role_required", 403)
    rev, node = await get_revision(db, space_id, revision_id)
    if rev.status != "proposed":
        _reject("kb_revision_not_pending", 409, status=rev.status)
    rev.status, rev.reviewer, rev.reviewed_at = "rejected", actor.id, _now()
    if note:
        rev.note = note
    await _sync_pending(db, node)
    if node.version == 0 and node.pending_count == 0:
        node.deleted_at = _now()
    await db.flush()
    return {"status": "rejected"}

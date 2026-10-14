"""Space knowledge base: drafts/publish, metadata ownership, agentic retrieval."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from hub.auth import create_agent_token
from hub.models import Agent, Base, KbRevision, User
from hub.services import spaces
from tests.test_app.conftest import create_test_engine

SECRET = "test-kb-supabase-secret-0123456789abcdef"


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        yield db
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session, monkeypatch):
    import app.auth as app_auth
    from hub.database import get_db
    from hub.main import app

    monkeypatch.setattr(app_auth, "SUPABASE_JWT_SECRET", SECRET)

    async def override():
        yield db_session

    app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def auth(sub: uuid.UUID) -> dict:
    token = jwt.encode(
        {"sub": str(sub), "aud": "authenticated",
         "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
        SECRET,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def org(db_session):
    """Danny (owner) + Alice (member) in Acme; Eve outside. Barry is Danny's agent; Otto is Eve's."""
    now = datetime.datetime.now(datetime.timezone.utc)
    users = {n: User(display_name=n, supabase_user_id=uuid.uuid4()) for n in ("Danny", "Alice", "Eve")}
    db_session.add_all(users.values())
    await db_session.flush()
    barry_token, _ = create_agent_token("ag_barry")
    otto_token, _ = create_agent_token("ag_otto")
    db_session.add_all([
        Agent(agent_id="ag_barry", display_name="Barry", user_id=users["Danny"].id, claimed_at=now,
              agent_token=barry_token),
        Agent(agent_id="ag_otto", display_name="Otto", user_id=users["Eve"].id, claimed_at=now,
              agent_token=otto_token),
    ])
    await db_session.flush()
    acme = await spaces.create_organization(db_session, users["Danny"].id, "acme", "Acme")
    await spaces.invite_user(db_session, acme.space_id, users["Danny"].id, users["Alice"].id)
    await spaces.accept_invitation(db_session, acme.space_id, users["Alice"].id)
    await spaces.request_agent_admission(db_session, acme.space_id, users["Danny"].id, "ag_barry")
    await spaces.approve_agent(db_session, acme.space_id, users["Danny"].id, "ag_barry")
    await db_session.commit()
    return {
        "space": acme.space_id,
        "barry": {"Authorization": f"Bearer {barry_token}"},
        "otto": {"Authorization": f"Bearer {otto_token}"},
        "danny": auth(users["Danny"].supabase_user_id),
        "alice": auth(users["Alice"].supabase_user_id),
        "eve": auth(users["Eve"].supabase_user_id),
    }


def hub(org):
    return f"/hub/kb/{org['space']}"


def app_(org):
    return f"/api/spaces/{org['space']}/kb"


def agent_page(path, content, **extra):
    return {"path": path, "content": content, "title": extra.pop("title", "T"),
            "description": extra.pop("description", "when to read"),
            "summary": extra.pop("summary", "what it says"), **extra}


@pytest.mark.asyncio
async def test_agent_draft_needs_review_then_becomes_visible(client, org):
    put = await client.put(f"{hub(org)}/page", headers=org["barry"],
                           json=agent_page("/knowledge/deploy.md", "# Deploy\nrun make deploy"))
    assert put.status_code == 200, put.text
    assert put.json()["status"] == "proposed"

    # Drafts are invisible to agent retrieval.
    assert (await client.get(f"{hub(org)}/page", headers=org["barry"],
                             params={"path": "/knowledge/deploy.md"})).status_code == 404
    tree = (await client.get(f"{hub(org)}/tree", headers=org["barry"])).json()["nodes"]
    assert tree == []

    # The dashboard sees the draft; Alice (member) cannot approve, Danny (owner) can.
    queue = (await client.get(f"{app_(org)}/revisions", headers=org["danny"])).json()["revisions"]
    [rev] = queue
    assert rev["path"] == "/knowledge/deploy.md" and rev["author"] == "ag_barry"
    assert (await client.post(f"{app_(org)}/revisions/{rev['revision_id']}/approve",
                              headers=org["alice"])).status_code == 403
    ok = await client.post(f"{app_(org)}/revisions/{rev['revision_id']}/approve", headers=org["danny"])
    assert ok.status_code == 200, ok.text

    page = (await client.get(f"{hub(org)}/page", headers=org["barry"],
                             params={"path": "/knowledge/deploy.md"})).json()
    assert page["version"] == 1 and page["content"].startswith("# Deploy")
    assert page["description_source"] == "agent" and not page["summary_stale"]
    tree = (await client.get(f"{hub(org)}/tree", headers=org["barry"])).json()["nodes"]
    assert [(n["path"], n["kind"]) for n in tree] == [("/knowledge", "dir"), ("/knowledge/deploy.md", "page")]


@pytest.mark.asyncio
async def test_archive_publishes_directly_and_agent_needs_metadata(client, org):
    missing = await client.put(f"{hub(org)}/page", headers=org["barry"],
                               json={"path": "/archive/2026-10/x.md", "content": "x"})
    assert missing.status_code == 400
    put = await client.put(f"{hub(org)}/page", headers=org["barry"],
                           json=agent_page("/archive/2026-10/x.md", "result",
                                           source_refs=[{"type": "topic", "id": "tp_1"}]))
    assert put.json()["status"] == "published"
    page = (await client.get(f"{hub(org)}/page", headers=org["barry"],
                             params={"path": "/archive/2026-10/x.md"})).json()
    assert page["source_refs"] == [{"type": "topic", "id": "tp_1"}]


@pytest.mark.asyncio
async def test_version_conflict_and_stale_approval(client, db_session, org):
    path = "/handbook/release.md"
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": path, "content": "v1"})
    # Updates require the base version.
    assert (await client.put(f"{hub(org)}/page", headers=org["barry"],
                             json=agent_page(path, "v2"))).status_code == 409
    draft = (await client.put(f"{hub(org)}/page", headers=org["barry"],
                              json=agent_page(path, "v2", base_version=1))).json()
    # Danny publishes v2 meanwhile; Barry's draft is now stale.
    await client.put(f"{app_(org)}/page", headers=org["danny"],
                     json={"path": path, "content": "v2 by danny", "base_version": 1})
    stale = await client.post(f"{app_(org)}/revisions/{draft['revision_id']}/approve", headers=org["danny"])
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "kb_revision_stale"
    rev = await db_session.get(KbRevision, draft["revision_id"], populate_existing=True)
    assert rev.status == "superseded"


@pytest.mark.asyncio
async def test_member_edits_are_drafts_owner_edits_publish(client, org):
    alice = await client.put(f"{app_(org)}/page", headers=org["alice"], json={"path": "/a.md", "content": "a"})
    assert alice.json()["status"] == "proposed"
    danny = await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/b.md", "content": "b"})
    assert danny.json()["status"] == "published"
    # Members cannot touch metadata or structure directly.
    assert (await client.patch(f"{app_(org)}/meta", headers=org["alice"],
                               json={"path": "/b.md", "description": "d"})).status_code == 403
    assert (await client.delete(f"{app_(org)}/node", headers=org["alice"],
                                params={"path": "/b.md"})).status_code == 403


@pytest.mark.asyncio
async def test_meta_queue_and_human_owned_description(client, org):
    await client.put(f"{app_(org)}/page", headers=org["danny"],
                     json={"path": "/handbook/terms.md", "content": "PR = pull request"})
    queue = (await client.get(f"{hub(org)}/meta-queue", headers=org["barry"])).json()["nodes"]
    assert queue[0]["path"] == "/handbook/terms.md"
    assert set(queue[0]["needs"]) == {"description", "summary"}
    # Pages come before their dirs so dir summaries are built bottom-up.
    assert [q["kind"] for q in queue] == ["page", "dir"]

    content_hash = queue[0]["content_hash"]
    filled = await client.patch(f"{hub(org)}/meta", headers=org["barry"], json={
        "path": "/handbook/terms.md", "description": "术语表", "summary": "PR 指 pull request",
        "content_hash": content_hash})
    assert filled.json()["result"] == {"description": "applied", "summary": "applied"}

    # A human takes over the description; agents can no longer overwrite it.
    await client.patch(f"{app_(org)}/meta", headers=org["danny"],
                       json={"path": "/handbook/terms.md", "description": "查术语时读"})
    again = await client.patch(f"{hub(org)}/meta", headers=org["barry"],
                               json={"path": "/handbook/terms.md", "description": "x"})
    assert again.json()["result"] == {"description": "skipped_human_owned"}

    # Content change makes the summary stale; a summary for the old body is refused.
    await client.put(f"{app_(org)}/page", headers=org["danny"],
                     json={"path": "/handbook/terms.md", "content": "PR = pull request\nCI = ...",
                           "base_version": 1})
    page = (await client.get(f"{hub(org)}/page", headers=org["barry"],
                             params={"path": "/handbook/terms.md"})).json()
    assert page["summary_stale"] and page["description"] == "查术语时读"
    old = await client.patch(f"{hub(org)}/meta", headers=org["barry"], json={
        "path": "/handbook/terms.md", "summary": "s", "content_hash": content_hash})
    assert old.status_code == 409
    assert "summary_stale" in [q for q in (await client.get(f"{hub(org)}/meta-queue", headers=org["barry"]))
                               .json()["nodes"] if q["path"] == "/handbook/terms.md"][0]["needs"]


@pytest.mark.asyncio
async def test_dir_summary_goes_stale_when_child_changes(client, org):
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/kb/a.md", "content": "a"})
    tree = (await client.get(f"{app_(org)}/tree", headers=org["danny"])).json()["nodes"]
    dir_hash = (await client.get(f"{hub(org)}/page", headers=org["barry"], params={"path": "/kb"})).json()["content_hash"]
    await client.patch(f"{hub(org)}/meta", headers=org["barry"],
                       json={"path": "/kb", "summary": "one page", "content_hash": dir_hash})
    assert not (await client.get(f"{hub(org)}/page", headers=org["barry"], params={"path": "/kb"})).json()["summary_stale"]
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/kb/b.md", "content": "b"})
    assert (await client.get(f"{hub(org)}/page", headers=org["barry"], params={"path": "/kb"})).json()["summary_stale"]
    assert tree


@pytest.mark.asyncio
async def test_grep_search_and_context(client, org):
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={
        "path": "/README.md", "content": "Acme 团队手册：发布前先查 /handbook。", "description": "团队总览"})
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={
        "path": "/handbook/release.md", "title": "发布流程", "description": "需要上线时读",
        "content": "# 发布流程\n1. 合并 Version PR\n2. 触发 release.yml\n"})
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={
        "path": "/handbook/style_guide.md", "content": "use double quotes"})

    grep = (await client.get(f"{hub(org)}/grep", headers=org["barry"], params={"pattern": "RELEASE.yml"})).json()
    assert grep["matches"] == [{"path": "/handbook/release.md", "line": 3, "text": "2. 触发 release.yml"}]
    # LIKE wildcards in the pattern are literal.
    assert (await client.get(f"{hub(org)}/grep", headers=org["barry"], params={"pattern": "%"})).json()["matches"] == []

    results = (await client.get(f"{hub(org)}/search", headers=org["barry"], params={"q": "上线发布怎么走"})).json()["results"]
    assert results[0]["path"] == "/handbook/release.md"
    assert results[0]["snippet"]

    scoped = (await client.get(f"{hub(org)}/tree", headers=org["barry"], params={"path": "/handbook", "depth": 1})).json()
    assert {n["path"] for n in scoped["nodes"]} == {"/handbook/release.md", "/handbook/style_guide.md"}

    ctx = (await client.get(f"{hub(org)}/context", headers=org["barry"])).json()
    assert ctx["space_name"] == "Acme" and ctx["readme"].startswith("Acme 团队手册")
    assert [i["path"] for i in ctx["index"]] == ["/handbook"]
    assert ctx["index"][0]["children"] == 2 and ctx["page_count"] == 3

    spaces_out = (await client.get("/hub/kb/spaces", headers=org["barry"])).json()["spaces"]
    assert [s["name"] for s in spaces_out if s["kind"] == "organization"] == ["Acme"]


@pytest.mark.asyncio
async def test_outsiders_and_invalid_paths(client, org):
    assert (await client.get(f"{app_(org)}/tree", headers=org["eve"])).status_code == 404
    assert (await client.get(f"{hub(org)}/tree", headers=org["otto"])).status_code == 403
    for bad in ("/a/../b.md", "/a b.md", "/x", "/" + "/".join("abcdefg") + ".md"):
        r = await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": bad, "content": "x"})
        assert r.status_code == 400, bad
    big = await client.put(f"{app_(org)}/page", headers=org["danny"],
                           json={"path": "/big.md", "content": "x" * 50_001})
    assert big.status_code == 413


@pytest.mark.asyncio
async def test_delete_subtree_and_reject_new_page(client, org):
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/old/a.md", "content": "a"})
    draft = (await client.put(f"{hub(org)}/page", headers=org["barry"],
                              json=agent_page("/new/idea.md", "idea"))).json()
    rejected = await client.post(f"{app_(org)}/revisions/{draft['revision_id']}/reject",
                                 headers=org["danny"], json={"note": "not needed"})
    assert rejected.status_code == 200
    tree = (await client.get(f"{app_(org)}/tree", headers=org["danny"])).json()["nodes"]
    assert "/new/idea.md" not in {n["path"] for n in tree}

    assert (await client.delete(f"{app_(org)}/node", headers=org["danny"],
                                params={"path": "/old"})).json() == {"deleted": 2}
    assert (await client.get(f"{app_(org)}/tree", headers=org["danny"])).json()["nodes"] == [
        n for n in tree if not n["path"].startswith("/old") and n["path"] != "/new/idea.md"]
    # The path can be reused after deletion.
    again = await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/old/a.md", "content": "b"})
    assert again.json()["status"] == "published"


@pytest.mark.asyncio
async def test_agent_sees_own_draft_outcomes(client, org):
    kept = (await client.put(f"{hub(org)}/page", headers=org["barry"],
                             json=agent_page("/knowledge/a.md", "a", note="first"))).json()
    dropped = (await client.put(f"{hub(org)}/page", headers=org["barry"],
                                json=agent_page("/knowledge/b.md", "b"))).json()
    await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": "/c.md", "content": "c"})
    await client.post(f"{app_(org)}/revisions/{kept['revision_id']}/approve", headers=org["danny"])
    await client.post(f"{app_(org)}/revisions/{dropped['revision_id']}/reject", headers=org["danny"],
                      json={"note": "duplicate of /handbook"})

    mine = (await client.get(f"{hub(org)}/drafts", headers=org["barry"])).json()["revisions"]
    assert {(r["path"], r["status"]) for r in mine} == {("/knowledge/a.md", "published"), ("/knowledge/b.md", "rejected")}
    [rejected] = [r for r in mine if r["status"] == "rejected"]
    assert rejected["note"] == "duplicate of /handbook" and rejected["reviewer"].startswith("hu_")
    only = (await client.get(f"{hub(org)}/drafts", headers=org["barry"], params={"status": "rejected"})).json()
    assert [r["path"] for r in only["revisions"]] == ["/knowledge/b.md"]
    assert (await client.get(f"{hub(org)}/drafts", headers=org["otto"])).status_code == 403


@pytest.mark.asyncio
async def test_tree_order_pins_readme_and_ignores_collation(client, org):
    for path in ("/archive/a.md", "/Zeta.md", "/README.md", "/handbook/README.md", "/handbook/b.md"):
        await client.put(f"{app_(org)}/page", headers=org["danny"], json={"path": path, "content": "x"})
    tree = (await client.get(f"{hub(org)}/tree", headers=org["barry"])).json()["nodes"]
    assert [n["path"] for n in tree] == [
        "/README.md", "/Zeta.md", "/archive", "/archive/a.md",
        "/handbook", "/handbook/README.md", "/handbook/b.md",
    ]

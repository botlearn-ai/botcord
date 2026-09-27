import datetime
import json
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import MessagePolicy, MessageState
from hub.models import Agent, Base, MessageRecord, User
from hub.services.agent_capability import score_latency, score_model, score_skills

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import app.auth as app_auth
    import hub.config
    from hub.database import get_db
    from hub.main import app

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app_auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def _msg(n: int, sender: str, receiver: str, room: str, at: datetime.datetime, **kw) -> MessageRecord:
    return MessageRecord(
        hub_msg_id=f"h_cap_{n:03d}",
        msg_id=kw.pop("msg_id", f"m_cap_{n:03d}"),
        sender_id=sender,
        receiver_id=receiver,
        room_id=room,
        state=kw.pop("state", MessageState.done),
        envelope_json=json.dumps({"payload": {"text": "x"}}),
        ttl_sec=3600,
        created_at=at,
        **kw,
    )


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    user_id = uuid.uuid4()
    supabase_uid = uuid.uuid4()
    other_user_id = uuid.uuid4()
    now = datetime.datetime.now(datetime.timezone.utc)
    db_session.add_all(
        [
            User(id=user_id, display_name="U", email="u@example.com", status="active", supabase_user_id=supabase_uid),
            User(id=other_user_id, display_name="O", email="o@example.com", status="active", supabase_user_id=uuid.uuid4()),
            Agent(
                agent_id="ag_cap001",
                display_name="Cap",
                bio="I review code",
                message_policy=MessagePolicy.contacts_only,
                user_id=user_id,
                runtime="claude-code",
                runtime_model="opus",
                skills_json=[{"name": "botcord"}, {"name": "review"}, {"name": "review"}],
                created_at=now,
            ),
            Agent(
                agent_id="ag_cap_quiet",
                display_name="Quiet",
                message_policy=MessagePolicy.contacts_only,
                user_id=user_id,
                created_at=now,
            ),
            Agent(
                agent_id="ag_cap_other",
                display_name="Other",
                message_policy=MessagePolicy.contacts_only,
                user_id=other_user_id,
                created_at=now,
            ),
        ]
    )

    rows: list[MessageRecord] = []
    n = 0
    # 6 inbound DMs on distinct days; the agent replies to 4 of them after 60s.
    for day in range(6):
        at = now - datetime.timedelta(days=day + 1)
        n += 1
        rows.append(_msg(n, "ag_peer", "ag_cap001", "rm_dm_peer", at))
        if day < 4:
            n += 1
            rows.append(_msg(n, "ag_cap001", "ag_peer", "rm_dm_peer", at + datetime.timedelta(seconds=60)))
    # Group fan-out without mention: must not count as expecting a reply.
    for i in range(5):
        n += 1
        rows.append(_msg(n, "ag_peer", "ag_cap001", "rm_group", now - datetime.timedelta(hours=2 + i)))
    # One failed delivery out of 11 inbound rows.
    n += 1
    rows.append(_msg(n, "ag_peer", "ag_cap001", "rm_group", now - datetime.timedelta(hours=10), state=MessageState.failed))
    db_session.add_all(rows)
    await db_session.commit()
    return {"token": _make_token(str(supabase_uid))}


def test_score_model_tiers():
    assert score_model("claude-code", "opus")["score"] == 95
    assert score_model("codex", "gpt-5-mini")["score"] == 60
    assert score_model("codex", "gpt-5.2")["score"] == 90
    assert score_model("claude-code", None)["score"] == 85
    assert score_model(None, None)["score"] is None


def test_score_skills_and_latency():
    assert score_skills(None)["score"] is None
    assert score_skills([])["score"] == 0
    assert score_skills([{"name": "a"}, {"name": "a"}])["value"] == 1
    assert score_latency(10) == 100
    assert round(score_latency(30 * 60)) == 0


@pytest.mark.asyncio
async def test_capability_scores_owned_agent(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap001/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    layers = {layer["key"]: layer for layer in body["layers"]}
    l0 = {d["key"]: d for d in layers["l0"]["dimensions"]}
    l1 = {d["key"]: d for d in layers["l1"]["dimensions"]}

    assert l0["model"]["score"] == 95
    assert l0["skills"]["value"] == 2
    assert l0["profile"]["score"] == 70  # bio + runtime, no avatar

    assert l1["response_rate"]["sample"] == 6
    assert l1["response_rate"]["value"] == pytest.approx(4 / 6, abs=1e-3)
    assert l1["latency"]["value"] == 60
    assert l1["delivery"]["sample"] == 12
    assert l1["delivery"]["value"] == pytest.approx(11 / 12, abs=1e-3)
    assert l1["activity"]["value"] == 4
    assert layers["l1"]["score"] is not None


@pytest.mark.asyncio
async def test_capability_insufficient_samples_are_null(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap_quiet/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 200
    l1 = {d["key"]: d for d in resp.json()["layers"][1]["dimensions"]}
    assert l1["response_rate"]["score"] is None
    assert l1["latency"]["score"] is None
    assert l1["delivery"]["score"] is None
    assert l1["activity"]["score"] == 0


@pytest.mark.asyncio
async def test_capability_rejects_foreign_agent(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap_other/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 403

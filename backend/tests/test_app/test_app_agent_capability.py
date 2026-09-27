import datetime
import json
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import MessagePolicy, MessageState, TopicStatus
from hub.models import Agent, AgentSchedule, Base, Block, MessageRecord, Room, Topic, UsageEvent, User
from hub.services.agent_capability import effective_skill_count, model_tier

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
                hosting_kind="daemon",
                skills_json=[{"name": "botcord"}, {"name": "review"}, {"name": "review"}, {"name": "pdf"}],
                created_at=now - datetime.timedelta(days=60),
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
            Room(room_id="rm_cap_work", name="Work", description="", owner_id="ag_cap001", created_at=now),
            AgentSchedule(
                id="sch_cap1",
                agent_id="ag_cap001",
                name="daily",
                schedule_json={},
                payload_json={},
            ),
            Block(owner_id="ag_peer", blocked_agent_id="ag_cap001", created_at=now),
        ]
    )
    for i, status in enumerate([TopicStatus.completed, TopicStatus.completed, TopicStatus.failed]):
        db_session.add(
            Topic(
                topic_id=f"tp_cap_{i}",
                room_id="rm_cap_work",
                title=f"T{i}",
                description="",
                status=status,
                creator_id="ag_cap001",
                created_at=now,
                updated_at=now,
            )
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
    # One failed delivery out of 12 inbound rows.
    n += 1
    rows.append(_msg(n, "ag_peer", "ag_cap001", "rm_group", now - datetime.timedelta(hours=10), state=MessageState.failed))
    # Three self-initiated topic posts (no preceding inbound in that room).
    for i in range(3):
        n += 1
        rows.append(
            _msg(n, "ag_cap001", "ag_peer", "rm_cap_work", now - datetime.timedelta(days=10 + i), topic_id=f"tp_cap_{i}")
        )
    db_session.add_all(rows)
    for i, tokens in enumerate([10_000, 20_000, 40_000]):
        db_session.add(
            UsageEvent(
                user_id=user_id,
                agent_id="ag_cap001",
                run_id=f"run_{i}",
                provider="p",
                model="m",
                output_tokens=tokens,
                idempotency_key=f"idem_{i}",
            )
        )
    await db_session.commit()
    return {"token": _make_token(str(supabase_uid))}


def _axes(body: dict) -> dict:
    return {axis["key"]: axis["layers"] for axis in body["axes"]}


def test_model_tier_and_skills():
    assert model_tier("claude-code", "opus") == (95, 40)
    assert model_tier("codex", "gpt-5-mini")[0] == 60
    assert model_tier("codex", "gpt-5.2")[0] == 90
    assert model_tier("claude-code", None)[0] == 85
    assert model_tier(None, None) is None
    assert effective_skill_count(None) is None
    assert effective_skill_count([{"name": "botcord"}, {"name": "a"}, {"name": "a"}]) == 1


@pytest.mark.asyncio
async def test_capability_scores_owned_agent(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap001/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [a["key"] for a in body["axes"]] == [
        "efficacy", "latency", "reliability", "cost", "autonomy", "assurance",
    ]
    axes = _axes(body)

    # L0
    assert axes["efficacy"]["l0"]["value"] == {"model": "opus", "skills": 2}
    assert axes["latency"]["l0"]["score"] == 70
    assert axes["cost"]["l0"]["score"] == 40
    assert axes["autonomy"]["l0"]["value"] == 1

    # L1
    assert axes["efficacy"]["l1"]["value"] == pytest.approx(2 / 3, abs=1e-3)
    latency = axes["latency"]["l1"]
    assert latency["sample"] == 6
    assert latency["value"] == {"reply_rate": pytest.approx(4 / 6, abs=1e-3), "median_seconds": 60}
    reliability = axes["reliability"]["l1"]["value"]
    assert reliability["delivery_rate"] == pytest.approx(11 / 12, abs=1e-3)
    assert reliability["schedule_success_rate"] is None
    assert reliability["active_days"] == 7
    assert axes["cost"]["l1"]["value"] == 20_000
    assert axes["cost"]["l1"]["score"] == 100
    assert axes["autonomy"]["l1"]["value"] == pytest.approx(3 / 7, abs=1e-3)
    assert axes["assurance"]["l1"]["value"] == {"blocks": 1, "recalled": 0}
    assert axes["assurance"]["l1"]["score"] == 80
    assert body["layer_scores"]["l0"] is not None
    assert body["layer_scores"]["l1"] is not None


@pytest.mark.asyncio
async def test_capability_insufficient_samples_are_null(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap_quiet/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 200
    axes = _axes(resp.json())
    for key in ("efficacy", "latency", "cost", "autonomy", "assurance"):
        assert axes[key]["l1"]["score"] is None, key
    assert axes["reliability"]["l1"]["score"] == 0
    assert axes["efficacy"]["l0"]["score"] is None


@pytest.mark.asyncio
async def test_capability_rejects_foreign_agent(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_cap_other/capability",
        headers={"Authorization": f"Bearer {seed['token']}"},
    )
    assert resp.status_code == 403

"""Tests for the owner-chat in-flight stream cache (hub.owner_chat_cache).

These tests run on in-memory SQLite and MUST pass with Redis DISABLED
(BOTCORD_REDIS_URL unset). For cache-write/compaction/restore unit tests we
monkeypatch a small in-memory fake Redis client — no running Redis server.
"""

import base64
import datetime
import uuid as _uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub import owner_chat_cache
from hub.models import Agent, Base, User

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# DB / client fixtures (mirror tests/test_dashboard_chat.py)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession):
    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def _make_keypair():
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(client: AsyncClient, display_name: str = "TestAgent"):
    sk, pubkey = _make_keypair()
    resp = await client.post("/registry/agents", json={
        "display_name": display_name, "pubkey": pubkey, "bio": "test agent",
    })
    assert resp.status_code == 201
    data = resp.json()
    agent_id, key_id, challenge = data["agent_id"], data["key_id"], data["challenge"]
    signed = sk.sign(base64.b64decode(challenge))
    sig_b64 = base64.b64encode(signed.signature).decode()
    resp = await client.post(f"/registry/agents/{agent_id}/verify", json={
        "key_id": key_id, "challenge": challenge, "sig": sig_b64,
    })
    assert resp.status_code == 200
    return agent_id, resp.json()["agent_token"]


async def _claim_agent(db_session, agent_id, human_suffix="01"):
    user_id = str(_uuid.uuid4())
    db_session.add(User(
        id=_uuid.UUID(user_id),
        display_name="Owner",
        email=f"owner{human_suffix}@example.com",
        status="active",
        supabase_user_id=_uuid.uuid4(),
        human_id=f"hu_owner{human_suffix}",
    ))
    await db_session.execute(
        update(Agent).where(Agent.agent_id == agent_id).values(
            user_id=_uuid.UUID(user_id),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()
    return user_id


# ---------------------------------------------------------------------------
# Fake async Redis client
# ---------------------------------------------------------------------------


class FakeRedis:
    """Minimal in-memory async stand-in for the Redis operations we use."""

    def __init__(self):
        self.hashes: dict[str, dict] = {}
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.ttls: dict[str, int] = {}
        self.published: list[tuple[str, str]] = []
        self._seq = 0

    async def hset(self, key, mapping=None, **kwargs):
        h = self.hashes.setdefault(key, {})
        if mapping:
            h.update({k: str(v) for k, v in mapping.items()})
        return 1

    async def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    async def expire(self, key, ttl):
        self.ttls[key] = ttl
        return True

    async def exists(self, key):
        return 1 if key in self.hashes else 0

    async def xadd(self, key, fields, maxlen=None, approximate=True):
        self._seq += 1
        entry_id = f"{self._seq}-0"
        stream = self.streams.setdefault(key, [])
        stream.append((entry_id, {k: str(v) for k, v in fields.items()}))
        if maxlen is not None and len(stream) > maxlen:
            del stream[: len(stream) - maxlen]
        return entry_id

    async def xrange(self, key):
        return list(self.streams.get(key, []))

    async def publish(self, channel, payload):
        self.published.append((channel, payload))
        return 1


@pytest.fixture
def fake_redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(owner_chat_cache, "_redis_client", fake)
    monkeypatch.setattr(owner_chat_cache, "_redis_init_failed", False)
    # Force redis_enabled() True regardless of env.
    monkeypatch.setattr(owner_chat_cache.hub_config, "BOTCORD_REDIS_URL", "redis://fake")
    return fake


# ---------------------------------------------------------------------------
# Compaction unit tests (no Redis needed)
# ---------------------------------------------------------------------------


def test_compact_tool_call_preserves_param_structure():
    # Params must stay a dict (not be stringified) so the restored view renders
    # the same as the live stream; only long string leaves get truncated.
    block = {"kind": "tool_call", "seq": 3, "payload": {"name": "web_search", "params": {"q": "x" * 9000}}}
    out = owner_chat_cache.compact_block(block)
    assert out["kind"] == "tool_call"
    assert out["payload"]["name"] == "web_search"
    assert isinstance(out["payload"]["params"], dict)
    assert len(out["payload"]["params"]["q"]) <= owner_chat_cache._MAX_STR_FIELD + 1
    assert out["seq"] == 3


def test_compact_tool_result_preserves_structure():
    block = {"kind": "tool_result", "payload": {"status": "ok", "result": "z" * 9000}}
    out = owner_chat_cache.compact_block(block)
    assert out["payload"]["status"] == "ok"
    assert isinstance(out["payload"]["result"], str)
    assert len(out["payload"]["result"]) <= owner_chat_cache._MAX_STR_FIELD + 1


def test_compact_thinking_keeps_payload_shape():
    # `thinking` (codex runtime) must NOT fall through to a stringified preview.
    block = {
        "kind": "thinking",
        "seq": 2,
        "payload": {"phase": "updated", "label": "Searching web", "source": "runtime"},
    }
    out = owner_chat_cache.compact_block(block)
    assert out["kind"] == "thinking"
    assert out["payload"] == {"phase": "updated", "label": "Searching web", "source": "runtime"}
    assert out["seq"] == 2


def test_compact_truncates_long_string_in_place():
    block = {"kind": "reasoning", "payload": {"text": "r" * 9000}}
    out = owner_chat_cache.compact_block(block)
    # structure preserved (still under payload.text), long string truncated
    assert "text" in out["payload"]
    assert len(out["payload"]["text"]) <= owner_chat_cache._MAX_STR_FIELD + 1


def test_byte_cap_truncates(monkeypatch):
    monkeypatch.setattr(owner_chat_cache.hub_config, "OWNER_CHAT_MAX_EVENT_BYTES", 100)
    compact = {"kind": "assistant", "seq": 1, "payload": {"text": "y" * 4000}}
    out, truncated, size = owner_chat_cache._enforce_event_byte_cap(compact)
    assert truncated is True
    assert out["truncated"] is True
    assert "preview" in out["payload"]
    # Full 4000-char payload dropped; only a short (<=280) preview kept.
    assert len(out["payload"]["preview"]) <= 280
    assert size < 600


# ---------------------------------------------------------------------------
# Cache write / restore unit tests (fake redis)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_run_metadata(fake_redis):
    await owner_chat_cache.write_run_metadata(
        "h_trace1", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_trace1",
    )
    h = fake_redis.hashes["owner_chat_run:h_trace1"]
    assert h["status"] == "running"
    assert h["agent_id"] == "ag_1"
    assert h["event_count"] == "0"
    assert fake_redis.ttls["owner_chat_run:h_trace1"] == owner_chat_cache.hub_config.OWNER_CHAT_RUN_TTL_SECONDS


@pytest.mark.asyncio
async def test_append_event_bumps_counts(fake_redis):
    await owner_chat_cache.write_run_metadata(
        "h_t2", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t2",
    )
    out = await owner_chat_cache.append_event("h_t2", 1, {"kind": "tool_call", "payload": {"name": "ls"}})
    assert out["kind"] == "tool_call"
    h = fake_redis.hashes["owner_chat_run:h_t2"]
    assert h["event_count"] == "1"
    assert h["last_seq"] == "1"
    assert len(fake_redis.streams["owner_chat_run:h_t2:events"]) == 1


@pytest.mark.asyncio
async def test_append_event_respects_cap(fake_redis, monkeypatch):
    monkeypatch.setattr(owner_chat_cache.hub_config, "OWNER_CHAT_MAX_CACHED_EVENTS", 2)
    await owner_chat_cache.write_run_metadata(
        "h_t3", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t3",
    )
    assert await owner_chat_cache.append_event("h_t3", 1, {"kind": "assistant", "payload": {"text": "a"}})
    assert await owner_chat_cache.append_event("h_t3", 2, {"kind": "assistant", "payload": {"text": "b"}})
    # Third exceeds cap -> dropped (None).
    assert await owner_chat_cache.append_event("h_t3", 3, {"kind": "assistant", "payload": {"text": "c"}}) is None


@pytest.mark.asyncio
async def test_mark_completed_shortens_ttl(fake_redis):
    await owner_chat_cache.write_run_metadata(
        "h_t4", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t4",
    )
    await owner_chat_cache.mark_run_completed("h_t4", final_msg_id="h_final")
    h = fake_redis.hashes["owner_chat_run:h_t4"]
    assert h["status"] == "completed"
    assert h["final_msg_id"] == "h_final"
    assert fake_redis.ttls["owner_chat_run:h_t4"] == owner_chat_cache.hub_config.OWNER_CHAT_RUN_COMPLETED_TTL_SECONDS


@pytest.mark.asyncio
async def test_mark_completed_no_final_msg_id(fake_redis):
    # stream-end path completes a reply-less run without a final_msg_id.
    await owner_chat_cache.write_run_metadata(
        "h_t4b", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t4b",
    )
    await owner_chat_cache.mark_run_completed("h_t4b")
    h = fake_redis.hashes["owner_chat_run:h_t4b"]
    assert h["status"] == "completed"
    # final_msg_id stays at its initial empty value (not clobbered with junk).
    assert h["final_msg_id"] == ""
    assert fake_redis.ttls["owner_chat_run:h_t4b"] == owner_chat_cache.hub_config.OWNER_CHAT_RUN_COMPLETED_TTL_SECONDS


@pytest.mark.asyncio
async def test_mark_completed_first_wins(fake_redis):
    # The reply path completes with a real id; a later stream-end must not
    # clobber it (or re-open the run).
    await owner_chat_cache.write_run_metadata(
        "h_t4c", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t4c",
    )
    await owner_chat_cache.mark_run_completed("h_t4c", final_msg_id="h_real")
    await owner_chat_cache.mark_run_completed("h_t4c")  # late stream-end, no id
    h = fake_redis.hashes["owner_chat_run:h_t4c"]
    assert h["status"] == "completed"
    assert h["final_msg_id"] == "h_real"


@pytest.mark.asyncio
async def test_mark_completed_missing_run_is_noop(fake_redis):
    # No key yet (expired / never created) — must not create a phantom run.
    await owner_chat_cache.mark_run_completed("h_gone")
    assert "owner_chat_run:h_gone" not in fake_redis.hashes


@pytest.mark.asyncio
async def test_load_run_shapes_events(fake_redis):
    await owner_chat_cache.write_run_metadata(
        "h_t5", user_id="usr1", agent_id="ag_1", room_id="rm_oc_x", trigger_msg_id="h_t5",
    )
    await owner_chat_cache.append_event("h_t5", 1, {"kind": "tool_call", "payload": {"name": "ls"}})
    run = await owner_chat_cache.load_run("h_t5")
    assert run["status"] == "running"
    assert run["agent_id"] == "ag_1"
    assert run["room_id"] == "rm_oc_x"
    assert len(run["events"]) == 1
    ev = run["events"][0]
    assert ev["seq"] == 1
    assert ev["kind"] == "tool_call"
    assert ev["block"]["payload"]["name"] == "ls"


@pytest.mark.asyncio
async def test_publish_fanout_tags_origin(fake_redis):
    await owner_chat_cache.publish_fanout({"type": "stream_block", "trace_id": "h_x"})
    assert len(fake_redis.published) == 1
    import json
    channel, payload = fake_redis.published[0]
    assert channel == owner_chat_cache.hub_config.OWNER_CHAT_FANOUT_CHANNEL
    assert json.loads(payload)["origin"] == owner_chat_cache.INSTANCE_ID


# ---------------------------------------------------------------------------
# Redis-DISABLED graceful no-op tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disabled_ops_are_noops(monkeypatch):
    monkeypatch.setattr(owner_chat_cache.hub_config, "BOTCORD_REDIS_URL", None)
    monkeypatch.setattr(owner_chat_cache, "_redis_client", None)
    assert owner_chat_cache.redis_enabled() is False
    assert owner_chat_cache.get_redis() is None
    # None of these raise.
    await owner_chat_cache.write_run_metadata("h_d", user_id="u", agent_id="a", room_id="r", trigger_msg_id="h_d")
    assert await owner_chat_cache.append_event("h_d", 1, {"kind": "assistant"}) is None
    await owner_chat_cache.mark_run_completed("h_d", final_msg_id="x")
    await owner_chat_cache.mark_run_failed("h_d")
    assert await owner_chat_cache.load_run("h_d") is None
    await owner_chat_cache.publish_fanout({"type": "stream_block"})


# ---------------------------------------------------------------------------
# Restore endpoint — Redis DISABLED returns empty-completed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restore_endpoint_redis_disabled_empty_completed(
    client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setattr(owner_chat_cache.hub_config, "BOTCORD_REDIS_URL", None)
    monkeypatch.setattr(owner_chat_cache, "_redis_client", None)

    agent_id, token = await _register_and_verify(client, "RestoreAgent")
    await _claim_agent(db_session, agent_id, "rd")

    resp = await client.get(
        f"/dashboard/chat/runs/h_sometrace/stream-blocks",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["trace_id"] == "h_sometrace"
    assert data["status"] == "completed"
    assert data["events"] == []


# ---------------------------------------------------------------------------
# Restore endpoint — running run via fake redis + auth scoping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restore_endpoint_running_run(
    client: AsyncClient, db_session: AsyncSession, fake_redis,
):
    from hub.routers.dashboard_chat import _build_owner_chat_room_id

    agent_id, token = await _register_and_verify(client, "RunAgent")
    user_id = await _claim_agent(db_session, agent_id, "rr")
    room_id = _build_owner_chat_room_id(user_id, agent_id)

    await owner_chat_cache.write_run_metadata(
        "h_run", user_id=user_id, agent_id=agent_id, room_id=room_id, trigger_msg_id="h_run",
    )
    await owner_chat_cache.append_event("h_run", 1, {"kind": "tool_call", "payload": {"name": "web_search"}})

    resp = await client.get(
        "/dashboard/chat/runs/h_run/stream-blocks",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "running"
    assert data["agent_id"] == agent_id
    assert data["room_id"] == room_id
    assert len(data["events"]) == 1
    assert data["events"][0]["kind"] == "tool_call"
    assert data["events"][0]["block"]["payload"]["name"] == "web_search"


@pytest.mark.asyncio
async def test_restore_endpoint_wrong_owner_returns_empty(
    client: AsyncClient, db_session: AsyncSession, fake_redis,
):
    """A run owned by a different agent/room must not leak; returns empty-completed."""
    agent_id, token = await _register_and_verify(client, "OwnerScopeAgent")
    await _claim_agent(db_session, agent_id, "os")

    # Run belongs to a different agent / room.
    await owner_chat_cache.write_run_metadata(
        "h_other", user_id="usrX", agent_id="ag_other", room_id="rm_oc_other", trigger_msg_id="h_other",
    )

    resp = await client.get(
        "/dashboard/chat/runs/h_other/stream-blocks",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "completed"
    assert data["events"] == []


# ---------------------------------------------------------------------------
# /hub/stream-block still works with Redis OFF (live WS unaffected)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_block_works_redis_disabled(
    client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setattr(owner_chat_cache.hub_config, "BOTCORD_REDIS_URL", None)
    monkeypatch.setattr(owner_chat_cache, "_redis_client", None)

    from hub.routers import owner_chat_ws

    agent_id, token = await _register_and_verify(client, "StreamAgent")
    user_id = await _claim_agent(db_session, agent_id, "sb")

    # Register an in-memory trace subscription as the WS path would.
    trace_id = "h_streamtrace"
    owner_chat_ws._oc_trace_subs[trace_id] = (user_id, agent_id)
    owner_chat_ws._oc_trace_block_count[trace_id] = 0
    try:
        resp = await client.post(
            "/hub/stream-block",
            json={"trace_id": trace_id, "seq": 1, "block": {"kind": "assistant", "payload": {"text": "hi"}}},
            headers={"Authorization": f"Bearer {token}"},
        )
        # No WS connected, but the endpoint must succeed (204) without Redis.
        assert resp.status_code == 204
        assert owner_chat_ws._oc_trace_block_count[trace_id] == 1
    finally:
        owner_chat_ws._oc_trace_subs.pop(trace_id, None)
        owner_chat_ws._oc_trace_block_count.pop(trace_id, None)


# ---------------------------------------------------------------------------
# /hub/stream-end — closes a reply-less run so it isn't restored on refresh
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_end_completes_run(
    client: AsyncClient, db_session: AsyncSession, fake_redis,
):
    from hub.routers import owner_chat_ws
    from hub.routers.dashboard_chat import _build_owner_chat_room_id

    agent_id, token = await _register_and_verify(client, "EndAgent")
    user_id = await _claim_agent(db_session, agent_id, "se")
    room_id = _build_owner_chat_room_id(user_id, agent_id)

    trace_id = "h_endtrace"
    await owner_chat_cache.write_run_metadata(
        trace_id, user_id=user_id, agent_id=agent_id, room_id=room_id, trigger_msg_id=trace_id,
    )
    owner_chat_ws._oc_trace_subs[trace_id] = (user_id, agent_id)
    owner_chat_ws._oc_trace_block_count[trace_id] = 0
    try:
        resp = await client.post(
            "/hub/stream-end",
            json={"trace_id": trace_id},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 204
        # Run is now completed and the local subscription cleaned up.
        assert fake_redis.hashes[f"owner_chat_run:{trace_id}"]["status"] == "completed"
        assert trace_id not in owner_chat_ws._oc_trace_subs
    finally:
        owner_chat_ws._oc_trace_subs.pop(trace_id, None)
        owner_chat_ws._oc_trace_block_count.pop(trace_id, None)


@pytest.mark.asyncio
async def test_stream_end_wrong_owner_is_noop(
    client: AsyncClient, db_session: AsyncSession, fake_redis,
):
    """A run owned by another agent must not be completed by this caller."""
    agent_id, token = await _register_and_verify(client, "EndScopeAgent")
    await _claim_agent(db_session, agent_id, "ses")

    trace_id = "h_otherend"
    await owner_chat_cache.write_run_metadata(
        trace_id, user_id="usrZ", agent_id="ag_other", room_id="rm_oc_other", trigger_msg_id=trace_id,
    )
    resp = await client.post(
        "/hub/stream-end",
        json={"trace_id": trace_id},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 204
    # Not this agent's run — left untouched (still running).
    assert fake_redis.hashes[f"owner_chat_run:{trace_id}"]["status"] == "running"


@pytest.mark.asyncio
async def test_stream_end_redis_disabled_noop(
    client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setattr(owner_chat_cache.hub_config, "BOTCORD_REDIS_URL", None)
    monkeypatch.setattr(owner_chat_cache, "_redis_client", None)

    agent_id, token = await _register_and_verify(client, "EndDisabledAgent")
    await _claim_agent(db_session, agent_id, "sed")

    resp = await client.post(
        "/hub/stream-end",
        json={"trace_id": "h_whatever"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 204

"""Cloud Agent activity stamps (hub.services.cloud_agent_activity).

Covers the four event taps that keep ``cloud_agent_instances.last_active_at``
fresh so the idle-pause sweep recognizes ongoing use:

  1. Inbound — attention-policy gated: stamp only when the message would
     actually wake the runtime per ``resolve_effective_attention``.
  2. Outbound — unconditional stamp on the sender side.
  3. Owner-chat send — unconditional stamp on the agent side.
  4. Gateway control frames — unconditional stamp via ``_stamp_cloud_activity``.
"""

from __future__ import annotations

import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import AttentionMode
from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
)
from hub.services.cloud_agent import CloudAgentService, CreateCloudAgentInput
from hub.services.cloud_agent_activity import (
    bump_if_cloud_agent,
    maybe_bump_for_inbound,
    maybe_bump_for_inbound_many,
    would_wake_runtime,
)
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


async def _make_cloud_agent(db_session, user_id):
    svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=4,
        max_agents_per_daemon=2,
    )
    return await svc.create_cloud_agent(
        db_session,
        user_id=user_id,
        body=CreateCloudAgentInput(name="Cloud Bot"),
    )


async def _make_local_agent(db_session) -> Agent:
    """Daemon-hosted (non-cloud) agent — should never be stamped."""
    agent = Agent(
        agent_id="ag_localagent01",
        display_name="Local",
        bio=None,
        hosting_kind="daemon",
    )
    db_session.add(agent)
    await db_session.commit()
    return agent


async def _read_last_active(db_session, agent_id):
    return await db_session.scalar(
        select(CloudAgentInstance.last_active_at).where(
            CloudAgentInstance.agent_id == agent_id
        )
    )


# ---------------------------------------------------------------------------
# would_wake_runtime
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_would_wake_runtime_always_mode(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    agent.default_attention = AttentionMode.always
    await db_session.commit()

    wake = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_room1",
        text="hi",
        mentioned=False,
        sender_id="ag_other",
        message_type="message",
    )
    assert wake is True


@pytest.mark.asyncio
async def test_would_wake_runtime_mention_only_skips_without_mention(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    agent.default_attention = AttentionMode.mention_only
    await db_session.commit()

    wake = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_room1",
        text="hello",
        mentioned=False,
        sender_id="ag_other",
        message_type="message",
    )
    assert wake is False

    wake = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_room1",
        text="hello",
        mentioned=True,
        sender_id="ag_other",
        message_type="message",
    )
    assert wake is True


@pytest.mark.asyncio
async def test_would_wake_runtime_keyword_substring(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    agent.default_attention = AttentionMode.keyword
    agent.attention_keywords = '["DEPLOY", "lunch"]'
    await db_session.commit()

    wake_match = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_room1",
        text="please deploy the staging build",
        mentioned=False,
        sender_id=None,
        message_type="message",
    )
    assert wake_match is True

    wake_miss = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_room1",
        text="random chatter",
        mentioned=False,
        sender_id=None,
        message_type="message",
    )
    assert wake_miss is False


@pytest.mark.asyncio
async def test_would_wake_runtime_dm_forces_always(db_session):
    """DM rooms (rm_dm_*) force AttentionMode.always per design §4.2 even when
    the agent's global default is mention_only."""
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    agent.default_attention = AttentionMode.mention_only
    await db_session.commit()

    wake = await would_wake_runtime(
        db_session,
        receiver=agent,
        room_id="rm_dm_alice_bob",
        text="ping",
        mentioned=False,
        sender_id="ag_other",
        message_type="message",
    )
    assert wake is True


@pytest.mark.asyncio
async def test_would_wake_runtime_skips_receipt_types(db_session):
    """ack / result / error are receipts — they never wake the runtime."""
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )

    for non_waking in ("ack", "result", "error"):
        wake = await would_wake_runtime(
            db_session,
            receiver=agent,
            room_id="rm_dm_x",
            text="ok",
            mentioned=True,
            sender_id="ag_other",
            message_type=non_waking,
        )
        assert wake is False, f"{non_waking} should not wake"


# ---------------------------------------------------------------------------
# bump_if_cloud_agent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bump_stamps_cloud_agent(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())

    assert await _read_last_active(db_session, view.agent_id) is None
    await bump_if_cloud_agent(db_session, view.agent_id)
    await db_session.commit()

    stamp = await _read_last_active(db_session, view.agent_id)
    assert stamp is not None


@pytest.mark.asyncio
async def test_bump_is_noop_for_non_cloud_agent(db_session):
    agent = await _make_local_agent(db_session)
    # No CloudAgentInstance row for a local agent; bump must not crash and
    # must not invent one.
    await bump_if_cloud_agent(db_session, agent.agent_id)
    await db_session.commit()
    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == agent.agent_id
        )
    )
    assert row is None


@pytest.mark.asyncio
async def test_bump_handles_missing_agent(db_session):
    # Unknown agent id is a silent no-op.
    await bump_if_cloud_agent(db_session, "ag_doesnotexist")
    await db_session.commit()  # no error raised


# ---------------------------------------------------------------------------
# maybe_bump_for_inbound — attention gating
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inbound_stamps_when_attention_wakes(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    await maybe_bump_for_inbound(
        db_session,
        receiver_id=view.agent_id,
        sender_id="ag_other",
        room_id="rm_room1",
        text="hi",
        mentioned=True,
        message_type="message",
    )
    await db_session.commit()
    assert await _read_last_active(db_session, view.agent_id) is not None


@pytest.mark.asyncio
async def test_inbound_skips_when_attention_filters_out(db_session):
    view = await _make_cloud_agent(db_session, uuid.uuid4())
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    agent.default_attention = AttentionMode.mention_only
    await db_session.commit()

    await maybe_bump_for_inbound(
        db_session,
        receiver_id=view.agent_id,
        sender_id="ag_other",
        room_id="rm_room1",  # NOT a DM, so mention_only applies.
        text="just chatter",
        mentioned=False,
        message_type="message",
    )
    await db_session.commit()
    assert await _read_last_active(db_session, view.agent_id) is None


@pytest.mark.asyncio
async def test_inbound_many_per_receiver_mention(db_session):
    """Room fan-out: only receivers actually mentioned (or @all) wake; the
    others must not be stamped under mention_only."""
    user_id = uuid.uuid4()
    a = await _make_cloud_agent(db_session, user_id)
    b = await _make_cloud_agent(db_session, user_id)

    # Both default to mention_only so the per-receiver branching is observable.
    for agent_id in (a.agent_id, b.agent_id):
        ag = await db_session.scalar(select(Agent).where(Agent.agent_id == agent_id))
        ag.default_attention = AttentionMode.mention_only
    await db_session.commit()

    await maybe_bump_for_inbound_many(
        db_session,
        receiver_ids={a.agent_id, b.agent_id},
        sender_id="ag_sender",
        room_id="rm_room1",
        text="hello",
        mentioned_set={a.agent_id},
        message_type="message",
    )
    await db_session.commit()

    assert await _read_last_active(db_session, a.agent_id) is not None
    assert await _read_last_active(db_session, b.agent_id) is None


# ---------------------------------------------------------------------------
# Idle-pause sweep respects last_active_at
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idle_pause_skips_when_last_active_is_recent(db_session):
    """A recent ``last_active_at`` (within the idle window) must prevent the
    sweep from pausing the cloud daemon, even when ``last_run_at`` is empty
    and ``cdi.last_started_at`` is stale."""
    user_id = uuid.uuid4()
    svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=3,
        max_agents_per_daemon=2,
    )
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)

    # Backdate cdi.last_started_at well outside the idle window so the only
    # thing keeping the agent "alive" is the activity stamp.
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    cdi.last_started_at = now - datetime.timedelta(seconds=600)

    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    cai.created_at = now - datetime.timedelta(seconds=600)
    cai.last_active_at = now - datetime.timedelta(seconds=30)  # recent
    await db_session.commit()

    paused = await svc.pause_idle_cloud_daemons(
        db_session, idle_seconds=300, now=now
    )
    assert paused == 0

    await db_session.refresh(cai)
    await db_session.refresh(cdi)
    assert cai.status == "ready"
    assert cdi.status == "ready"


@pytest.mark.asyncio
async def test_idle_pause_triggers_when_last_active_is_stale(db_session):
    """Inverse of the above: with everything backdated past the idle window
    the sweep pauses both the agent and the cloud daemon."""
    user_id = uuid.uuid4()
    svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=3,
        max_agents_per_daemon=2,
    )
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    cdi.last_started_at = now - datetime.timedelta(seconds=600)
    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    cai.created_at = now - datetime.timedelta(seconds=600)
    cai.last_active_at = now - datetime.timedelta(seconds=600)
    await db_session.commit()

    paused = await svc.pause_idle_cloud_daemons(
        db_session, idle_seconds=300, now=now
    )
    assert paused == 1

    await db_session.refresh(cai)
    await db_session.refresh(cdi)
    assert cai.status == "paused"
    assert cdi.status == "paused"

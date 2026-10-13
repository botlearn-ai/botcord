"""Network retries must not create another fan-out or wake agents twice."""
import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import DashboardSendRequest, MessageRecord, Topic
from hub.services.dashboard_send_requests import reserve_room_send
from tests.test_dashboard_rooms_human_send import client, db_session, seed, _h  # noqa: F401


@pytest.mark.asyncio
async def test_replay_returns_original_without_fanout_or_notification(client, db_session, seed, monkeypatch):
    notify = AsyncMock()
    monkeypatch.setattr("app.routers.dashboard.notify_inbox", notify)
    path = "/api/dashboard/rooms/rm_humanroom/send"
    headers = _h(seed["token1"], seed["agent1"])
    topic = Topic(topic_id="tp_idempotency", room_id="rm_humanroom", title="Idempotency", creator_id=seed["agent1"])
    db_session.add(topic)
    await db_session.commit()
    body = {"topic_id": "tp_idempotency", "text": "idempotent hello", "mentions": [seed["agent2"]], "client_request_id": "retry-key"}
    first = await client.post(path, headers=headers, json=body)
    assert first.status_code == 202, first.text
    calls = notify.await_count
    records = (await db_session.execute(select(MessageRecord))).scalars().all()
    replay = await client.post(path, headers=headers, json=body)
    assert replay.status_code == 202, replay.text
    assert replay.json() == first.json()
    assert notify.await_count == calls
    await db_session.refresh(topic)
    assert topic.message_count == 1
    assert len((await db_session.execute(select(MessageRecord))).scalars().all()) == len(records)
    # Body mutation must never silently return the old result or enqueue anew.
    conflict = await client.post(path, headers=headers, json={**body, "text": "different"})
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "idempotency_key_conflict"
    # Authorization is still enforced for replays.
    denied = await client.post(path, headers=_h(seed["token1"], seed["agent_stranger"]), json=body)
    assert denied.status_code in (403, 404)


@pytest.mark.asyncio
async def test_request_keys_are_scoped_and_rollback_releases_reservation(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'requests.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(DashboardSendRequest.__table__.create)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    args = dict(user_id="u", sender_id="hu_u", room_id="r", key="key", payload={"text": "hi"})
    try:
        async with sessions() as db:
            await reserve_room_send(db, **args)
            await db.rollback()
        async with sessions() as db:
            row, replay = await reserve_room_send(db, **args)
            assert replay is None
            row.response_json = {"msg_id": "original"}
            await db.commit()
        async with sessions() as db:
            _, replay = await reserve_room_send(db, **args)
            assert replay == {"msg_id": "original"}
            for scope in [{"user_id": "other"}, {"sender_id": "hu_other"}, {"room_id": "other"}, {"key": "other"}]:
                _, replay = await reserve_room_send(db, **{**args, **scope})
                assert replay is None
            await db.rollback()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_requests_share_one_committed_result(tmp_path):
    # Independent connections exercise database uniqueness, not a process lock.
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'concurrent.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(DashboardSendRequest.__table__.create)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    reserved = asyncio.Event()
    release = asyncio.Event()
    args = dict(user_id="u", sender_id="hu_u", room_id="r", key="key", payload={"text": "hi"})
    async def first():
        async with sessions() as db:
            row, replay = await reserve_room_send(db, **args)
            assert replay is None
            reserved.set()
            await release.wait()
            row.response_json = {"msg_id": "only-once"}
            await db.commit()
    async def second():
        await reserved.wait()
        async with sessions() as db:
            _, replay = await reserve_room_send(db, **args)
            return replay
    try:
        a = asyncio.create_task(first())
        b = asyncio.create_task(second())
        await reserved.wait()
        await asyncio.sleep(0.05)
        assert not b.done()
        release.set()
        await a
        assert await b == {"msg_id": "only-once"}
    finally:
        release.set()
        await engine.dispose()

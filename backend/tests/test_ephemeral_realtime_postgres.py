"""Exercise ephemeral publish transactions against disposable PostgreSQL."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text

from hub.auth import create_agent_token
from hub.models import Agent
from hub.routers import hub
from hub.services import message_status_reactions
from tests.test_app.test_conversation_sync import add_message, add_room
from tests.test_conversation_cursor_postgres import URL, database  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not URL, reason="requires disposable PostgreSQL")]


async def test_ephemeral_broadcasts_skip_projection_and_isolate_failed_publish(
    database, real_realtime_publisher, monkeypatch
):
    engine, sessions, ctx, schema = database
    monkeypatch.setattr(hub, "engine", engine)
    monkeypatch.setattr("hub.database.async_session", sessions)
    monkeypatch.setattr(message_status_reactions, "get_redis", lambda: None)

    actor = "ag_reaction"
    token, _ = create_agent_token(actor)
    recipients = {ctx.human_id, actor, *(f"hu_watcher_{i}" for i in range(8))}
    additional_observers = {f"hu_observer_{i}" for i in range(23)}
    observers = recipients | additional_observers
    async with sessions() as db:
        db.add(Agent(
            agent_id=actor, display_name="Reaction actor", agent_token=token,
            user_id=ctx.user_id, claimed_at=datetime.now(timezone.utc),
        ))
        await add_room(db, "rm_reaction", sorted(recipients), owner=ctx.human_id)
        await add_room(db, "rm_presence", [actor, *sorted(additional_observers)], owner=ctx.human_id)
        await add_message(db, "rm_reaction", "message", 10)
        await db.commit()

    # Emulate the transactional database effect of Supabase Realtime in the
    # disposable schema. No existing realtime schema or function is modified.
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE test_publications (topic text, payload jsonb)"))
        await conn.execute(text("CREATE SEQUENCE test_presence_send_order"))
        await conn.execute(text(f"""
            CREATE FUNCTION "{schema}".test_send(payload jsonb, event text, topic text, private boolean)
            RETURNS void LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO test_publications VALUES (topic, payload);
                IF event = 'agent_status_changed' AND nextval('test_presence_send_order') = 2 THEN
                    RAISE EXCEPTION 'simulated publish failure';
                END IF;
            END $$
        """))

    recorded = []
    publish_topics = []
    checkouts = 0
    peak_checkouts = 0

    @event.listens_for(engine.sync_engine, "checkout")
    def checkout(*args):
        nonlocal checkouts, peak_checkouts
        checkouts += 1
        peak_checkouts = max(peak_checkouts, checkouts)

    @event.listens_for(engine.sync_engine, "checkin")
    def checkin(*args):
        nonlocal checkouts
        checkouts -= 1

    @event.listens_for(engine.sync_engine, "before_cursor_execute", retval=True)
    def record(conn, cursor, statement, parameters, context, executemany):
        recorded.append(statement)
        if "realtime.send(" in statement:
            publish_topics.append(parameters[2])
        return statement.replace("realtime.send(", f'"{schema}".test_send('), parameters

    def counts():
        return (
            sum("realtime.send(" in statement for statement in recorded),
            sum("conversation_dirty_rooms" in statement and "writer_xid" in statement for statement in recorded),
        )

    # Positive control: the ordinary publish helper sharing an ORM transaction
    # runs the existing projection hook.
    async with sessions() as db:
        await hub._publish_agent_realtime_event(
            db, hub.build_agent_realtime_event(type="control", agent_id=ctx.human_id)
        )
    assert counts() == (1, 1)

    async def test_db():
        async with sessions() as db:
            yield db

    app = FastAPI()
    app.include_router(hub.router)
    app.dependency_overrides[hub.get_db] = test_db
    headers = {"Authorization": f"Bearer {token}"}
    body = {"room_id": "rm_reaction", "turn_id": "test"}
    reaction_path = "/hub/messages/message/status-reactions"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for method, path in (("POST", reaction_path), ("DELETE", f"{reaction_path}/replying")):
            recorded.clear()
            response = await asyncio.wait_for(client.request(method, path, json=body, headers=headers), timeout=10)
            assert response.status_code == 204
            assert counts() == (10, 0)
            assert peak_checkouts == 1

    recorded.clear()
    publish_topics.clear()
    snapshot = SimpleNamespace(
        agent_id=actor, version=1, for_observer=lambda *, is_owner: {"visible": is_owner},
    )
    await asyncio.wait_for(hub.broadcast_status_changed(snapshot), timeout=10)
    assert counts() == (33, 0)
    assert peak_checkouts == 1

    async with engine.connect() as conn:
        reactions = (await conn.execute(text("""
            SELECT topic, payload->'ext'->>'state' FROM test_publications
            WHERE payload->>'type' = 'message_status_reaction'
        """))).all()
        presence = (await conn.execute(text("""
            SELECT topic, payload->'ext'->'status'->>'visible' FROM test_publications
            WHERE payload->>'type' = 'agent_status_changed'
        """))).all()
    assert set(reactions) == {
        (hub.build_agent_realtime_topic(target), state)
        for target in recipients for state in ("active", "cleared")
    }
    assert len(reactions) == 20
    expected_presence = {
        (hub.build_agent_realtime_topic(target), str(target in {actor, ctx.human_id}).lower())
        for target in observers
    }
    assert set(publish_topics) == {topic for topic, _ in expected_presence}
    assert set(presence) == {row for row in expected_presence if row[0] != publish_topics[1]}
    assert len(presence) == 32

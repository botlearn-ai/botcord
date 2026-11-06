import asyncio
from types import SimpleNamespace

import pytest

from hub import config as hub_config
from hub import main as hub_main


def test_startup_ownership_defaults_preserve_existing_behavior():
    assert hub_config.BOTCORD_SCHEMA_AUTO_CREATE is True
    assert hub_config.BOTCORD_BACKGROUND_TASKS_ENABLED is True


@pytest.mark.asyncio
async def test_secondary_hub_skips_schema_and_periodic_workers_but_keeps_fanout(
    monkeypatch,
):
    started = []

    async def fanout_loop():
        started.append("owner-chat-fanout")
        await asyncio.Event().wait()

    async def forbidden_loop():
        raise AssertionError("periodic worker must not start")

    async def forbidden_prepare_schema(*_args, **_kwargs):
        raise AssertionError("schema preparation must not run")

    class ForbiddenSession:
        def __call__(self):
            raise AssertionError("hub pseudo-agent seed must not query the database")

    monkeypatch.setattr(hub_config, "BOTCORD_SCHEMA_AUTO_CREATE", False)
    monkeypatch.setattr(hub_config, "BOTCORD_BACKGROUND_TASKS_ENABLED", False)
    monkeypatch.setattr(hub_main, "storage_requires_local_disk", lambda: False)
    monkeypatch.setattr(hub_main, "async_session", ForbiddenSession())
    monkeypatch.setattr(hub_main, "message_expiry_loop", forbidden_loop)
    monkeypatch.setattr(hub_main, "file_cleanup_loop", forbidden_loop)
    monkeypatch.setattr(hub_main, "subscription_billing_loop", forbidden_loop)
    monkeypatch.setattr(hub_main, "presence_cleanup_loop", forbidden_loop)
    monkeypatch.setattr(hub_main, "agent_schedule_loop", forbidden_loop)
    monkeypatch.setattr(hub_main, "cloud_agent_idle_pause_loop", forbidden_loop)
    monkeypatch.setattr(
        "hub.services.schema_startup.prepare_schema", forbidden_prepare_schema
    )
    monkeypatch.setattr(
        "hub.services.conversation_projection.conversation_projection_loop",
        forbidden_loop,
    )
    monkeypatch.setattr(
        "hub.services.access_graph_sync.access_graph_sync_loop", forbidden_loop
    )
    monkeypatch.setattr("hub.owner_chat_cache.redis_enabled", lambda: True)
    monkeypatch.setattr("hub.owner_chat_cache.owner_chat_fanout_loop", fanout_loop)

    app = SimpleNamespace(dependency_overrides={}, state=SimpleNamespace())
    async with hub_main.lifespan(app):
        await asyncio.sleep(0)
        assert started == ["owner-chat-fanout"]
        assert app.state.http_client is None

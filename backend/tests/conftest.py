import datetime

import pytest
from sqlalchemy import event
from sqlalchemy.ext import asyncio as _sa_async

# Patch create_async_engine so SQLite test engines automatically map the
# "public" schema (used by User/Role/Permission models) to None. SQLite has
# no schema concept, so without this every table lookup like `public.users`
# fails with `unknown database public`. Conftest loads before test modules
# import the name, so the wrapper propagates to every test.
_original_create_async_engine = _sa_async.create_async_engine


def _patched_create_async_engine(*args, **kwargs):
    url = args[0] if args else kwargs.get("url", "")
    if isinstance(url, str) and url.startswith("sqlite"):
        exec_opts = dict(kwargs.get("execution_options") or {})
        translate = dict(exec_opts.get("schema_translate_map") or {})
        translate.setdefault("public", None)
        exec_opts["schema_translate_map"] = translate
        kwargs["execution_options"] = exec_opts
    return _original_create_async_engine(*args, **kwargs)


_sa_async.create_async_engine = _patched_create_async_engine


# Hub routers now gate operations on `agent.claimed_at`, but the HTTP-level
# claim endpoint was removed in PR #110 (claiming goes through the app layer
# only). Hub-layer tests register agents via `/registry/agents` but cannot
# claim them through HTTP, so operations return 403. Auto-populate
# `claimed_at` on Agent inserts to mirror the "agent bound to user" state
# hub tests assume. App-layer tests manage claim state explicitly, so we
# disable the listener for tests under `tests/test_app/`.
from hub.models import Agent as _Agent  # noqa: E402

_auto_claim_state = {"enabled": True}


def _agent_init(target, args, kwargs):
    if _auto_claim_state["enabled"] and kwargs.get("claimed_at") is None:
        kwargs["claimed_at"] = datetime.datetime.now(datetime.timezone.utc)


event.listen(_Agent, "init", _agent_init)


# Stub out the Postgres-only Supabase Realtime publish helper — tests run
# against SQLite, which doesn't have the `realtime.send()` function.
async def _noop_publish_agent_realtime_event(db, event):
    return None


import hub.routers.hub as _hub_router  # noqa: E402

_hub_router._publish_agent_realtime_event = _noop_publish_agent_realtime_event


@pytest.fixture(autouse=True)
def _auto_claim_policy(request):
    path = str(getattr(request.node, "path", ""))
    _auto_claim_state["enabled"] = "test_app" not in path
    yield


@pytest.fixture
def no_auto_claim():
    """Opt-out fixture for tests that need agents to stay unclaimed."""
    _auto_claim_state["enabled"] = False
    try:
        yield
    finally:
        _auto_claim_state["enabled"] = True


@pytest.fixture(autouse=True)
def disable_endpoint_probe(monkeypatch):
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", False)


@pytest.fixture(autouse=True)
def disable_beta_gate(monkeypatch):
    """Disable beta gate for non-beta tests — beta tests enable it explicitly."""
    import hub.config

    monkeypatch.setattr(hub.config, "BETA_GATE_ENABLED", False)


@pytest.fixture(autouse=True)
def _legacy_register_test_helper(request, monkeypatch):
    """Replace removed POST /registry/agents with direct DB seeding in tests."""
    try:
        db_session = request.getfixturevalue("db_session")
    except pytest.FixtureLookupError:
        return

    import httpx
    from sqlalchemy import select

    from hub.agent_avatars import random_agent_avatar_url
    from hub.config import CHALLENGE_EXPIRE_MINUTES
    from hub.crypto import generate_challenge
    from hub.enums import KeyState
    from hub.id_generators import generate_agent_id, generate_key_id
    from hub.models import Agent, Challenge, SigningKey
    from hub.validators import parse_pubkey

    original_post = httpx.AsyncClient.post

    def _response(status_code, url, payload):
        return httpx.Response(
            status_code,
            json=payload,
            request=httpx.Request("POST", str(url)),
        )

    async def _patched_post(client, url, *args, **kwargs):
        path = httpx.URL(str(url)).path
        if path != "/registry/agents":
            return await original_post(client, url, *args, **kwargs)

        body = kwargs.get("json") or {}
        display_name = body.get("display_name")
        pubkey = body.get("pubkey")
        bio = body.get("bio")
        if not display_name or not pubkey or not bio:
            return _response(422, url, {"detail": "display_name, pubkey, and bio are required"})

        try:
            pubkey_b64 = parse_pubkey(pubkey)
        except Exception:
            return _response(422, url, {"detail": "invalid pubkey"})

        agent_id = generate_agent_id(pubkey_b64)
        existing_agent = await db_session.scalar(select(Agent).where(Agent.agent_id == agent_id))
        if existing_agent is not None:
            signing_key = await db_session.scalar(
                select(SigningKey).where(
                    SigningKey.agent_id == agent_id,
                    SigningKey.pubkey == pubkey,
                )
            )
            if signing_key is None:
                return _response(409, url, {"detail": "agent_id_collision"})

            existing_agent.display_name = display_name
            existing_agent.bio = bio
            if existing_agent.avatar_url is None:
                existing_agent.avatar_url = random_agent_avatar_url()
            key_id = signing_key.key_id
        else:
            key_id = generate_key_id()
            db_session.add(
                Agent(
                    agent_id=agent_id,
                    display_name=display_name,
                    bio=bio,
                    avatar_url=random_agent_avatar_url(),
                    claim_code=f"clm_test_{agent_id.removeprefix('ag_')}",
                )
            )
            db_session.add(
                SigningKey(
                    agent_id=agent_id,
                    key_id=key_id,
                    pubkey=pubkey,
                    state=KeyState.pending,
                )
            )
            await db_session.flush()

        challenge = generate_challenge()
        db_session.add(
            Challenge(
                agent_id=agent_id,
                key_id=key_id,
                challenge=challenge,
                expires_at=datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(minutes=CHALLENGE_EXPIRE_MINUTES),
                used=False,
            )
        )
        await db_session.commit()
        return _response(201, url, {"agent_id": agent_id, "key_id": key_id, "challenge": challenge})

    monkeypatch.setattr(httpx.AsyncClient, "post", _patched_post)


@pytest.fixture(autouse=True)
def _clear_rate_windows():
    """Clear in-memory rate-limit windows before each test."""
    from hub.routers import hub as hub_mod

    hub_mod._rate_windows.clear()
    hub_mod._pair_rate_windows.clear()
    hub_mod._typing_rate_windows.clear()
    hub_mod._typing_dedup.clear()
    yield
    hub_mod._rate_windows.clear()
    hub_mod._pair_rate_windows.clear()
    hub_mod._typing_rate_windows.clear()
    hub_mod._typing_dedup.clear()

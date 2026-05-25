"""Tests for frontend-BFF endpoints moved into the Hub backend."""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.auth import RequestContext, require_user
from app.routers import auth as auth_router
from app.routers import telegram as telegram_router


@pytest.mark.asyncio
async def test_signup_generates_supabase_link_and_sends_confirmation_email(monkeypatch):
    calls: list[tuple[str, dict | None]] = []

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers=None, json=None, params=None):
            calls.append((str(url), json))
            if str(url).endswith("/auth/v1/admin/generate_link"):
                return httpx.Response(
                    200,
                    json={
                        "properties": {"action_link": "https://supabase.test/confirm"},
                        "user": {"id": "supabase-user-1"},
                    },
                )
            if str(url) == "https://api.resend.com/emails":
                return httpx.Response(200, json={"id": "email_1"})
            raise AssertionError(f"unexpected POST {url}")

    monkeypatch.setattr(auth_router, "SUPABASE_URL", "https://supabase.test")
    monkeypatch.setattr(auth_router, "SUPABASE_SERVICE_ROLE_KEY", "service-role")
    monkeypatch.setattr(auth_router, "RESEND_API_KEY", "resend-key")
    monkeypatch.setattr(auth_router, "RESEND_FROM_EMAIL", "BotCord <noreply@example.test>")
    monkeypatch.setattr(auth_router.httpx, "AsyncClient", FakeAsyncClient)

    app = FastAPI()
    app.include_router(auth_router.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://api.test") as client:
        resp = await client.post(
            "/api/auth/signup",
            headers={"Origin": "https://www.botcord.chat"},
            json={
                "email": " USER@Example.COM ",
                "password": "secret123",
                "redirectTo": "https://evil.example/auth/callback",
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    generate_payload = calls[0][1]
    assert generate_payload is not None
    assert generate_payload["email"] == "user@example.com"
    assert generate_payload["options"]["redirect_to"] == "https://www.botcord.chat/auth/callback"
    resend_payload = calls[1][1]
    assert resend_payload is not None
    assert resend_payload["to"] == ["user@example.com"]
    assert "https://supabase.test/confirm" in resend_payload["text"]


@pytest.mark.asyncio
async def test_signup_cleans_up_supabase_user_when_email_send_fails(monkeypatch):
    deletes: list[str] = []

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers=None, json=None, params=None):
            if str(url).endswith("/auth/v1/admin/generate_link"):
                return httpx.Response(
                    200,
                    json={
                        "properties": {"action_link": "https://supabase.test/confirm"},
                        "user": {"id": "supabase-user-2"},
                    },
                )
            if str(url) == "https://api.resend.com/emails":
                return httpx.Response(500, text="mail rejected")
            raise AssertionError(f"unexpected POST {url}")

        async def delete(self, url, *, headers=None):
            deletes.append(str(url))
            return httpx.Response(204)

    monkeypatch.setattr(auth_router, "SUPABASE_URL", "https://supabase.test")
    monkeypatch.setattr(auth_router, "SUPABASE_SERVICE_ROLE_KEY", "service-role")
    monkeypatch.setattr(auth_router, "RESEND_API_KEY", "resend-key")
    monkeypatch.setattr(auth_router.httpx, "AsyncClient", FakeAsyncClient)

    app = FastAPI()
    app.include_router(auth_router.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://api.test") as client:
        resp = await client.post(
            "/api/auth/signup",
            headers={"Origin": "https://www.botcord.chat"},
            json={"email": "user@example.com", "password": "secret123"},
        )

    assert resp.status_code == 502
    assert resp.json()["error"] == "confirmation_email_failed"
    assert deletes == ["https://supabase.test/auth/v1/admin/users/supabase-user-2"]


@pytest.mark.asyncio
async def test_signup_ignores_untrusted_origin_for_redirect(monkeypatch):
    captured: dict = {}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers=None, json=None, params=None):
            if str(url).endswith("/auth/v1/admin/generate_link"):
                captured.update(json or {})
                return httpx.Response(
                    200,
                    json={
                        "properties": {"action_link": "https://supabase.test/confirm"},
                        "user": {"id": "supabase-user-3"},
                    },
                )
            if str(url) == "https://api.resend.com/emails":
                return httpx.Response(200, json={"id": "email_1"})
            raise AssertionError(f"unexpected POST {url}")

    monkeypatch.setattr(auth_router, "FRONTEND_BASE_URL", "https://www.botcord.chat")
    monkeypatch.setattr(auth_router, "SUPABASE_URL", "https://supabase.test")
    monkeypatch.setattr(auth_router, "SUPABASE_SERVICE_ROLE_KEY", "service-role")
    monkeypatch.setattr(auth_router, "RESEND_API_KEY", "resend-key")
    monkeypatch.setattr(auth_router.httpx, "AsyncClient", FakeAsyncClient)

    app = FastAPI()
    app.include_router(auth_router.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://api.test") as client:
        resp = await client.post(
            "/api/auth/signup",
            headers={"Origin": "https://evil.example"},
            json={
                "email": "user@example.com",
                "password": "secret123",
                "redirectTo": "https://evil.example/auth/callback",
            },
        )

    assert resp.status_code == 200
    assert captured["options"]["redirect_to"] == "https://www.botcord.chat/auth/callback"


@pytest.mark.asyncio
async def test_telegram_chat_ids_discovers_chats_and_senders(monkeypatch):
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers=None, json=None, params=None):
            assert str(url) == "https://api.telegram.org/bot123:abc/getUpdates"
            assert params == {"timeout": 8}
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "message": {
                                "chat": {
                                    "id": 100,
                                    "type": "private",
                                    "first_name": "Ada",
                                    "username": "ada",
                                },
                                "from": {"id": 200, "first_name": "Ada", "last_name": "Lovelace"},
                            }
                        },
                        {
                            "channel_post": {
                                "chat": {"id": -300, "type": "channel", "title": "BotCord News"}
                            }
                        },
                    ],
                },
            )

    monkeypatch.setattr(telegram_router.httpx, "AsyncClient", FakeAsyncClient)

    app = FastAPI()
    app.include_router(telegram_router.router)
    app.dependency_overrides[require_user] = lambda: RequestContext(
        user_id=uuid.uuid4(),
        supabase_user_id=str(uuid.uuid4()),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://api.test") as client:
        resp = await client.post(
            "/api/telegram/chat-ids",
            json={"botToken": "123:abc", "timeoutSeconds": 8},
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "chats": [
            {"id": "100", "type": "private", "label": "@ada"},
            {"id": "-300", "type": "channel", "label": "BotCord News"},
        ],
        "senders": [{"id": "200", "label": "Ada Lovelace"}],
    }


@pytest.mark.asyncio
async def test_telegram_chat_ids_requires_bot_token():
    app = FastAPI()
    app.include_router(telegram_router.router)
    app.dependency_overrides[require_user] = lambda: RequestContext(
        user_id=uuid.uuid4(),
        supabase_user_id=str(uuid.uuid4()),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://api.test") as client:
        resp = await client.post("/api/telegram/chat-ids", json={"botToken": ""})

    assert resp.status_code == 400
    assert resp.json() == {"error": "missing_bot_token"}

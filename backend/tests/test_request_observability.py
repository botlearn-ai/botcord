import json
import logging
import datetime
import hashlib
from unittest.mock import AsyncMock

import jwt
import pytest
from starlette.requests import Request

from hub import auth
from hub.i18n import I18nHTTPException
from hub.request_observability import auth_failure_context, rate_limit_context, request_id_for


def _request(headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/hub/inbox",
            "query_string": b"limit=50",
            "headers": headers or [],
            "client": ("172.31.35.70", 62004),
            "server": ("hub.test", 443),
            "scheme": "https",
        }
    )


def test_auth_failure_context_only_includes_safe_non_secret_metadata():
    request = _request(
        [
            (b"authorization", b"Bearer must-never-be-logged"),
            (b"x-botcord-request-id", b"0123456789abcdef0123456789abcdef"),
            (b"x-botcord-caller", b"protocol-core"),
            (b"x-botcord-caller-version", b"0.2.17"),
            (b"x-botcord-agent-id", b"ag_0123456789abcdef"),
            (b"x-botcord-credential-key-id", b"k_0123456789abcdef"),
            (b"user-agent", b"undici"),
        ]
    )

    context = auth_failure_context(request, "invalid")

    assert context == {
        "failure": "invalid",
        "request_id": request_id_for(request),
        "client_request_id": "0123456789abcdef0123456789abcdef",
        "method": "GET",
        "path": "/hub/inbox",
        "source_ip": "172.31.35.70",
        "caller": "protocol-core",
        "caller_version": "0.2.17",
        "agent_id_hint": "ag_0123456789abcdef",
        "verified_agent_id": None,
        "credential_key_id": "k_0123456789abcdef",
        "user_agent_hash": hashlib.sha256(b"undici").hexdigest()[:16],
    }
    assert "authorization" not in context
    assert "must-never-be-logged" not in json.dumps(context)


def test_request_id_rejects_unsafe_client_value():
    request = _request([(b"x-botcord-request-id", b"bad value\nforged")])
    assert request_id_for(request) != "bad value\nforged"
    assert len(request_id_for(request)) == 32
    assert auth_failure_context(request, "invalid")["client_request_id"] is None


def test_rate_limit_context_is_correlatable_without_authorization_material():
    request = _request([
        (b"authorization", b"Bearer secret"),
        (b"x-botcord-request-id", b"abcdef0123456789abcdef0123456789"),
        (b"x-botcord-caller", b"protocol-core"),
        (b"user-agent", b"botcord-daemon/1.2.3"),
    ])
    request.state.authenticated_agent_id = "ag_0123456789abcdef"
    request.state.rate_limit_reason = "sender_target_per_minute"
    context = rate_limit_context(request)
    assert context["failure"] == "rate_limited"
    assert context["client_request_id"] == "abcdef0123456789abcdef0123456789"
    assert context["request_id"] != context["client_request_id"]
    assert context["caller"] == "protocol-core"
    assert context["authenticated_agent_id"] == "ag_0123456789abcdef"
    assert context["rate_limit_reason"] == "sender_target_per_minute"
    assert "authorization" not in context
    assert "secret" not in json.dumps(context)


@pytest.mark.parametrize(
    ("name", "value", "field"),
    [
        (b"x-botcord-request-id", b"eyJhbGciOiJIUzI1NiJ9.credential", "client_request_id"),
        (b"x-botcord-agent-id", b"ag_private-key-fragment+secret", "agent_id_hint"),
        (b"x-botcord-credential-key-id", b"k_eyJhbGciOiJIUzI1NiJ9", "credential_key_id"),
        (b"x-botcord-caller", b"Bearer-secret", "caller"),
        (b"x-botcord-caller-version", b"0.2.17/private-key", "caller_version"),
    ],
)
def test_untrusted_identity_headers_reject_credential_shaped_values(
    name: bytes, value: bytes, field: str
):
    context = auth_failure_context(_request([(name, value)]), "invalid")
    assert context[field] is None
    assert value.decode() not in json.dumps(context)


def test_user_agent_is_hashed_instead_of_logged_verbatim():
    secret = "Bearer eyJhbGciOiJIUzI1NiJ9.private-fragment"
    context = auth_failure_context(_request([(b"user-agent", secret.encode())]), "invalid")
    assert context["user_agent_hash"] == hashlib.sha256(secret.encode()).hexdigest()[:16]
    assert secret not in json.dumps(context)


def test_agent_id_header_cannot_forge_verified_principal():
    context = auth_failure_context(
        _request([(b"x-botcord-agent-id", b"ag_0123456789abcdef")]), "invalid"
    )

    assert context["agent_id_hint"] == "ag_0123456789abcdef"
    assert context["verified_agent_id"] is None


@pytest.mark.parametrize(
    ("authorization", "failure"),
    [(None, "missing"), ("Basic abc", "malformed"), ("Bearer bad", "invalid")],
)
def test_agent_auth_failure_is_classified_without_token(
    authorization: str | None,
    failure: str,
    caplog: pytest.LogCaptureFixture,
):
    request = _request([(b"x-botcord-agent-id", b"ag_test")])
    caplog.set_level(logging.WARNING, logger="hub.auth")

    with pytest.raises(I18nHTTPException):
        auth.get_current_agent(request, authorization)

    assert f'"failure": "{failure}"' in caplog.text
    assert "Bearer bad" not in caplog.text


def test_expired_agent_auth_logs_signature_verified_principal(
    caplog: pytest.LogCaptureFixture,
):
    request = _request([(b"x-botcord-agent-id", b"ag_untrusted_hint")])
    token = jwt.encode(
        {
            "agent_id": "ag_trusted_expired",
            "exp": datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=1),
            "iss": "botcord",
        },
        auth.JWT_SECRET,
        algorithm=auth.JWT_ALGORITHM,
    )
    caplog.set_level(logging.WARNING, logger="hub.auth")

    with pytest.raises(I18nHTTPException):
        auth.get_current_agent(request, f"Bearer {token}")

    assert '"failure": "expired"' in caplog.text
    assert '"verified_agent_id": "ag_trusted_expired"' in caplog.text
    assert token not in caplog.text


@pytest.mark.asyncio
async def test_persisted_token_expiry_is_not_logged_as_stale_or_revoked(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    request = _request()
    agent = type("AgentStub", (), {
        "agent_id": "ag_test",
        "status": "active",
        "agent_token": "valid-token",
        "token_expires_at": datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1),
        "claimed_at": datetime.datetime.now(datetime.timezone.utc),
    })()
    result = type("ResultStub", (), {"scalar_one_or_none": lambda self: agent})()
    db = type("DbStub", (), {"execute": AsyncMock(return_value=result)})()
    monkeypatch.setattr(auth, "verify_agent_token", lambda _token: "ag_test")
    caplog.set_level(logging.WARNING, logger="hub.auth")

    with pytest.raises(I18nHTTPException) as exc_info:
        await auth.get_current_claimed_agent(request, "Bearer valid-token", db)

    assert exc_info.value.message_key == "token_expired"
    assert '"failure": "expired"' in caplog.text
    assert '"verified_agent_id": "ag_test"' in caplog.text
    assert "stale_or_revoked" not in caplog.text


@pytest.mark.asyncio
async def test_dashboard_claimed_agent_logs_expired_trusted_principal(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    request = _request()
    token = jwt.encode(
        {
            "agent_id": "ag_trusted_inbox",
            "exp": datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=1),
            "iss": "botcord",
        },
        auth.JWT_SECRET,
        algorithm=auth.JWT_ALGORITHM,
    )
    monkeypatch.setattr(
        auth,
        "verify_supabase_token",
        lambda _token: (_ for _ in ()).throw(jwt.InvalidTokenError()),
    )
    caplog.set_level(logging.WARNING, logger="hub.auth")

    with pytest.raises(I18nHTTPException) as exc_info:
        await auth.get_dashboard_claimed_agent(request, f"Bearer {token}", None, None)

    assert exc_info.value.message_key == "invalid_token"
    assert '"failure": "expired"' in caplog.text
    assert '"path": "/hub/inbox"' in caplog.text
    assert '"verified_agent_id": "ag_trusted_inbox"' in caplog.text
    assert token not in caplog.text


@pytest.mark.asyncio
async def test_dashboard_claimed_agent_logs_stale_token_without_secret(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    request = _request()
    agent = type("AgentStub", (), {
        "agent_id": "ag_trusted_inbox",
        "status": "active",
        "agent_token": "replacement-token",
        "token_expires_at": None,
        "claimed_at": datetime.datetime.now(datetime.timezone.utc),
    })()
    result = type("ResultStub", (), {"scalar_one_or_none": lambda self: agent})()
    db = type("DbStub", (), {"execute": AsyncMock(return_value=result)})()
    monkeypatch.setattr(auth, "verify_agent_token", lambda _token, **_kwargs: agent.agent_id)
    caplog.set_level(logging.WARNING, logger="hub.auth")

    with pytest.raises(I18nHTTPException):
        await auth.get_dashboard_claimed_agent(
            request, "Bearer stale-secret-token", None, db
        )

    assert '"failure": "stale_or_revoked"' in caplog.text
    assert '"verified_agent_id": "ag_trusted_inbox"' in caplog.text
    assert "stale-secret-token" not in caplog.text

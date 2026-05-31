import base64
import json

import jwt
import pytest
from jwt.exceptions import PyJWKClientError

from hub import auth
from hub.i18n import I18nHTTPException


def _unsigned_token(header: dict, payload: dict | None = None) -> str:
    def enc(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    return f"{enc(header)}.{enc(payload or {})}.sig"


def test_supabase_hs256_secret_wins_when_jwks_is_configured(monkeypatch):
    secret = "test-supabase-secret-32-bytes-ok"

    class FailingJwksClient:
        def get_signing_key_from_jwt(self, token: str):  # pragma: no cover - must not be called
            raise AssertionError("JWKS should not be used for HS256")

    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", secret)
    monkeypatch.setattr(auth, "_jwks_client", FailingJwksClient())
    token = jwt.encode(
        {"sub": "user-123", "aud": "authenticated"},
        secret,
        algorithm="HS256",
    )

    assert auth.verify_supabase_token(token) == "user-123"


def test_supabase_hs256_token_with_expected_issuer_passes(monkeypatch):
    secret = "test-supabase-secret-32-bytes-ok"
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project-ref.supabase.co")
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", secret)
    monkeypatch.setattr(auth, "_jwks_client", None)
    token = jwt.encode(
        {
            "sub": "user-123",
            "aud": "authenticated",
            "iss": "https://project-ref.supabase.co/auth/v1",
        },
        secret,
        algorithm="HS256",
    )

    assert auth.verify_supabase_token(token) == "user-123"


def test_supabase_hs256_missing_issuer_fails_when_expected(monkeypatch):
    secret = "test-supabase-secret-32-bytes-ok"
    monkeypatch.setattr(auth, "JWT_SECRET", "botcord-test-secret-32-bytes-okx")
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project-ref.supabase.co")
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", secret)
    monkeypatch.setattr(auth, "_jwks_client", None)
    token = jwt.encode(
        {"sub": "user-123", "aud": "authenticated"},
        secret,
        algorithm="HS256",
    )

    with pytest.raises(I18nHTTPException) as exc:
        auth._parse_dashboard_token(f"Bearer {token}", "ag_123")

    assert exc.value.status_code == 401
    assert exc.value.message_key == "invalid_token"


def test_supabase_hs256_wrong_issuer_fails_when_expected(monkeypatch):
    secret = "test-supabase-secret-32-bytes-ok"
    monkeypatch.setattr(auth, "JWT_SECRET", "botcord-test-secret-32-bytes-okx")
    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project-ref.supabase.co")
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", secret)
    monkeypatch.setattr(auth, "_jwks_client", None)
    token = jwt.encode(
        {
            "sub": "user-123",
            "aud": "authenticated",
            "iss": "https://other-project.supabase.co/auth/v1",
        },
        secret,
        algorithm="HS256",
    )

    with pytest.raises(I18nHTTPException) as exc:
        auth._parse_dashboard_token(f"Bearer {token}", "ag_123")

    assert exc.value.status_code == 401
    assert exc.value.message_key == "invalid_token"


def test_supabase_issuer_derives_from_jwks_url(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(
        auth,
        "SUPABASE_JWT_JWKS_URL",
        "https://project-ref.supabase.co/auth/v1/.well-known/jwks.json",
    )

    assert auth._expected_supabase_issuer() == "https://project-ref.supabase.co/auth/v1"


def test_supabase_malformed_token_maps_to_invalid_token(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", None)
    monkeypatch.setattr(auth, "_jwks_client", object())

    with pytest.raises(I18nHTTPException) as exc:
        auth._parse_dashboard_token("Bearer not-a-jwt", "ag_123")

    assert exc.value.status_code == 401
    assert exc.value.message_key == "invalid_token"


def test_invalid_botcord_jwt_with_jwks_configured_maps_to_invalid_token(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", "botcord-test-secret-32-bytes-okx")
    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", None)
    monkeypatch.setattr(auth, "_jwks_client", object())
    token = jwt.encode(
        {"agent_id": "ag_123", "iss": "botcord"},
        "wrong-botcord-test-secret-32-okx",
        algorithm="HS256",
    )

    with pytest.raises(I18nHTTPException) as exc:
        auth._parse_dashboard_token(f"Bearer {token}", "ag_123")

    assert exc.value.status_code == 401
    assert exc.value.message_key == "invalid_token"


def test_supabase_jwks_client_error_maps_to_invalid_token(monkeypatch):
    class FailingJwksClient:
        def get_signing_key_from_jwt(self, token: str):
            raise PyJWKClientError("missing kid")

    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", None)
    monkeypatch.setattr(auth, "_jwks_client", FailingJwksClient())
    token = _unsigned_token({"alg": "RS256"}, {"sub": "user-123", "aud": "authenticated"})

    with pytest.raises(I18nHTTPException) as exc:
        auth._parse_dashboard_token(f"Bearer {token}", "ag_123")

    assert exc.value.status_code == 401
    assert exc.value.message_key == "invalid_token"


def test_supabase_hs256_missing_sub_still_invalid(monkeypatch):
    secret = "test-supabase-secret-32-bytes-ok"
    monkeypatch.setattr(auth, "SUPABASE_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_JWKS_URL", None)
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", secret)
    monkeypatch.setattr(auth, "_jwks_client", None)
    token = jwt.encode(
        {"aud": "authenticated"},
        secret,
        algorithm="HS256",
    )

    with pytest.raises(jwt.InvalidTokenError, match="Missing sub claim"):
        auth.verify_supabase_token(token)

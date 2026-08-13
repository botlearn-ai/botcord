"""BotLearn first-party integration auth.

Two token families live here:

1. **BotLearn login token** — issued by BotLearn's own auth provider. The Hub
   *verifies* it (issuer / audience / signature / expiry / email_verified) but
   never mints it. Supports HS256 (shared secret / same Supabase tenant) and
   RS256/ES256 (issuer JWKS).
2. **BotCord integration session token** — minted by the Hub, short-lived,
   scoped to one user + one default Cloud Agent + a small scope set. This is
   the only BotCord credential the BotLearn browser ever holds, and it decays
   within ``BOTLEARN_SESSION_TTL_SECONDS``.

The browser never receives a long-term BotCord API key. See
``docs/cloud-agent-technical-design.md`` §3.4 / §4.5 / §6.4.
"""

from __future__ import annotations

import datetime
import logging
import uuid as _uuid
from dataclasses import dataclass

import jwt as pyjwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError

from hub.config import (
    BOTLEARN_ALLOWED_ORIGINS,
    BOTLEARN_AUDIENCE,
    BOTLEARN_INTEGRATION_ENABLED,
    BOTLEARN_ISSUER,
    BOTLEARN_JWKS_URL,
    BOTLEARN_JWT_SECRET,
    BOTLEARN_REQUIRE_EMAIL_VERIFIED,
    BOTLEARN_SESSION_TTL_SECONDS,
    JWT_ALGORITHM,
    JWT_SECRET,
)

logger = logging.getLogger(__name__)

# Namespace for deriving a stable BotCord ``supabase_user_id`` UUID from a
# non-UUID BotLearn subject. Fixed forever — changing it would orphan every
# JIT-created BotLearn user.
BOTLEARN_USER_NAMESPACE = _uuid.UUID("b07c0ad0-b07e-1ea7-0000-b07c0a9eb07c")

# Session token envelope identity.
BOTLEARN_SESSION_TOKEN_KIND = "botlearn-integration-session"
BOTLEARN_SESSION_ISSUER = "botcord-hub"
BOTLEARN_SESSION_AUDIENCE = "botlearn"

# Scopes granted to a fresh session. Kept minimal — the Cloud Run public
# subset only.
BOTLEARN_SCOPE_RUNS_CREATE = "cloud_runs:create"
BOTLEARN_SCOPE_RUNS_READ = "cloud_runs:read"
BOTLEARN_SCOPE_RUNS_STREAM = "cloud_runs:stream"
BOTLEARN_SCOPE_RUNS_CANCEL = "cloud_runs:cancel"

DEFAULT_BOTLEARN_SCOPES: list[str] = [
    BOTLEARN_SCOPE_RUNS_CREATE,
    BOTLEARN_SCOPE_RUNS_READ,
    BOTLEARN_SCOPE_RUNS_STREAM,
    BOTLEARN_SCOPE_RUNS_CANCEL,
]

# WS method -> required scope. The Hub rejects any method not in this map
# (this is the allowlist) and any method whose scope the session lacks.
BOTLEARN_METHOD_REQUIRED_SCOPE: dict[str, str] = {
    "cloud_agent.get": BOTLEARN_SCOPE_RUNS_READ,
    "cloud_run.create": BOTLEARN_SCOPE_RUNS_CREATE,
    "cloud_run.get": BOTLEARN_SCOPE_RUNS_READ,
    "cloud_run.cancel": BOTLEARN_SCOPE_RUNS_CANCEL,
    "cloud_usage.get": BOTLEARN_SCOPE_RUNS_READ,
}

BOTLEARN_WS_PROTOCOL = "botcord-agent-session/0.1"


class BotlearnAuthError(Exception):
    """Raised for BotLearn token / origin failures.

    The HTTP layer maps :attr:`http_status`; the WS layer maps to a close
    code. Service code never raises ``HTTPException`` directly.
    """

    def __init__(self, code: str, message: str, *, http_status: int = 401) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


@dataclass(frozen=True)
class BotlearnIdentity:
    subject: str
    email: str | None
    email_verified: bool
    name: str | None


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# JWKS clients keyed by URL — lazily created, long-lived (mirrors app.auth).
_jwks_clients: dict[str, PyJWKClient] = {}


def _get_jwks_client(jwks_url: str) -> PyJWKClient:
    if jwks_url not in _jwks_clients:
        _jwks_clients[jwks_url] = PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_clients[jwks_url]


def _is_unknown_jwks_kid_error(exc: PyJWKClientError) -> bool:
    return str(exc).startswith("Unable to find a signing key that matches:")


def is_botlearn_origin_allowed(origin: str | None) -> bool:
    """Origin allowlist gate for the session + WS endpoints.

    Deny by default: an empty allowlist (unconfigured) closes the integration,
    and a missing Origin header is rejected.
    """
    if not BOTLEARN_ALLOWED_ORIGINS:
        return False
    if not origin:
        return False
    return origin.rstrip("/") in set(BOTLEARN_ALLOWED_ORIGINS)


def verify_botlearn_id_token(token: str) -> BotlearnIdentity:
    """Verify a BotLearn login token and return the caller's identity.

    Raises :class:`BotlearnAuthError` on any verification failure.
    """
    if not BOTLEARN_INTEGRATION_ENABLED:
        raise BotlearnAuthError(
            "botlearn_disabled",
            "BotLearn integration is not enabled",
            http_status=403,
        )

    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError:
        raise BotlearnAuthError("invalid_token", "Invalid BotLearn token")

    alg = header.get("alg", "RS256")
    options: dict[str, bool] = {}
    decode_kwargs: dict = {"algorithms": [alg]}
    if BOTLEARN_AUDIENCE:
        decode_kwargs["audience"] = BOTLEARN_AUDIENCE
    else:
        options["verify_aud"] = False
    if BOTLEARN_ISSUER:
        decode_kwargs["issuer"] = BOTLEARN_ISSUER

    try:
        if alg.startswith("HS"):
            if not BOTLEARN_JWT_SECRET:
                raise BotlearnAuthError(
                    "botlearn_not_configured",
                    "BotLearn HS256 verification is not configured",
                    http_status=503,
                )
            payload = pyjwt.decode(
                token, BOTLEARN_JWT_SECRET, options=options, **decode_kwargs
            )
        else:
            if not BOTLEARN_JWKS_URL:
                raise BotlearnAuthError(
                    "botlearn_not_configured",
                    "BotLearn JWKS verification is not configured",
                    http_status=503,
                )
            signing_key = _get_jwks_client(BOTLEARN_JWKS_URL).get_signing_key_from_jwt(
                token
            )
            payload = pyjwt.decode(
                token, signing_key.key, options=options, **decode_kwargs
            )
    except pyjwt.ExpiredSignatureError:
        raise BotlearnAuthError("token_expired", "BotLearn token expired")
    except pyjwt.InvalidIssuerError:
        raise BotlearnAuthError("invalid_issuer", "BotLearn token issuer not allowed")
    except pyjwt.InvalidAudienceError:
        raise BotlearnAuthError(
            "invalid_audience", "BotLearn token audience not allowed"
        )
    except BotlearnAuthError:
        raise
    except PyJWKClientError as exc:
        if _is_unknown_jwks_kid_error(exc):
            logger.debug("BotLearn JWKS key lookup failed: %s", exc)
            raise BotlearnAuthError("invalid_token", "Invalid BotLearn token")
        logger.warning("BotLearn JWKS verification unavailable: %s", exc)
        raise BotlearnAuthError(
            "botlearn_jwks_unavailable",
            "BotLearn JWKS verification is unavailable",
            http_status=503,
        )
    except pyjwt.InvalidTokenError as exc:
        logger.debug("BotLearn token verification failed: %s", exc)
        raise BotlearnAuthError("invalid_token", "Invalid BotLearn token")

    subject = payload.get("sub")
    if not subject:
        raise BotlearnAuthError("invalid_token", "BotLearn token missing sub claim")

    email = payload.get("email")
    email = email.strip().lower() if isinstance(email, str) and email.strip() else None
    # Supabase access tokens carry email_verified inside user_metadata (no
    # top-level claim); generic OIDC issuers use the top-level claim.
    user_metadata = payload.get("user_metadata")
    email_verified = bool(
        payload.get("email_verified")
        or (isinstance(user_metadata, dict) and user_metadata.get("email_verified"))
    )
    if BOTLEARN_REQUIRE_EMAIL_VERIFIED and not email_verified:
        raise BotlearnAuthError(
            "email_not_verified",
            "BotLearn account email is not verified",
            http_status=403,
        )

    name = payload.get("name") or payload.get("full_name") or None
    return BotlearnIdentity(
        subject=str(subject),
        email=email,
        email_verified=email_verified,
        name=name if isinstance(name, str) else None,
    )


def botcord_supabase_id_for_botlearn(subject: str) -> _uuid.UUID:
    """Map a BotLearn subject to the BotCord ``supabase_user_id`` UUID.

    When BotLearn shares the Supabase tenant the subject *is* the Supabase
    UUID, so it maps onto the same ``users`` row the dashboard would create.
    Otherwise derive a stable UUID5 so re-login lands on the same user.
    """
    try:
        return _uuid.UUID(subject)
    except (ValueError, AttributeError):
        return _uuid.uuid5(BOTLEARN_USER_NAMESPACE, subject)


def issue_botlearn_session_token(
    *,
    user_id: _uuid.UUID,
    botlearn_subject: str,
    agent_id: str,
    installation_id: str,
    scopes: list[str],
    session_key: str | None = None,
    session_profile_required: bool = False,
) -> tuple[str, int]:
    """Mint a short-lived BotCord integration session token.

    Returns ``(token, expires_in_seconds)``.
    """
    now = _now()
    exp = now + datetime.timedelta(seconds=BOTLEARN_SESSION_TTL_SECONDS)
    payload = {
        "kind": BOTLEARN_SESSION_TOKEN_KIND,
        "iss": BOTLEARN_SESSION_ISSUER,
        "aud": BOTLEARN_SESSION_AUDIENCE,
        "sub": str(user_id),
        "botlearn_sub": botlearn_subject,
        "user_id": str(user_id),
        "agent_id": agent_id,
        "installation_id": installation_id,
        "scopes": list(scopes),
        "iat": now,
        "exp": exp,
    }
    if session_key:
        payload["session_key"] = session_key
    if session_profile_required:
        # Deliberately only an enforcement bit: profile id/hash/content remain
        # in server-side Hub/daemon state and never enter the browser token.
        payload["session_profile_required"] = True
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, BOTLEARN_SESSION_TTL_SECONDS


def verify_botlearn_session_token(token: str) -> dict:
    """Decode + validate a BotCord integration session token.

    Raises :class:`BotlearnAuthError` on any failure. Guards against a token
    of another kind being replayed here.
    """
    try:
        payload = pyjwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            audience=BOTLEARN_SESSION_AUDIENCE,
            issuer=BOTLEARN_SESSION_ISSUER,
        )
    except pyjwt.ExpiredSignatureError:
        raise BotlearnAuthError("token_expired", "Session token expired")
    except pyjwt.InvalidTokenError:
        raise BotlearnAuthError("invalid_token", "Invalid session token")
    if payload.get("kind") != BOTLEARN_SESSION_TOKEN_KIND:
        raise BotlearnAuthError("invalid_token", "Wrong token kind")
    if not payload.get("user_id") or not payload.get("agent_id"):
        raise BotlearnAuthError("invalid_token", "Session token missing claims")
    if not payload.get("installation_id"):
        raise BotlearnAuthError("invalid_token", "Session token missing installation")
    return payload

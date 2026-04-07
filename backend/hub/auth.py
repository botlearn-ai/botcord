import datetime
import logging

import jwt
from fastapi import Depends, Header, HTTPException
from jwt import PyJWKClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import FRONTEND_BASE_URL, JWT_ALGORITHM, JWT_EXPIRE_HOURS, JWT_SECRET, SUPABASE_JWT_SECRET, SUPABASE_JWT_JWKS_URL
from hub.database import get_db
from hub.i18n import I18nHTTPException
from hub.models import Agent, User

_logger = logging.getLogger(__name__)

# Lazily initialised JWKS client (cached keys, thread-safe)
_jwks_client: PyJWKClient | None = None
if SUPABASE_JWT_JWKS_URL:
    _jwks_client = PyJWKClient(SUPABASE_JWT_JWKS_URL, cache_keys=True)


def create_agent_token(agent_id: str) -> tuple[str, int]:
    """Create a JWT token for the given agent_id.

    Returns:
        (token_string, expires_at_unix_timestamp)
    """
    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        hours=JWT_EXPIRE_HOURS
    )
    payload = {
        "agent_id": agent_id,
        "exp": expires_at,
        "iss": "botcord",
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, int(expires_at.timestamp())


def verify_agent_token(token: str) -> str:
    """Verify a JWT token and return the agent_id.

    Raises:
        jwt.ExpiredSignatureError: If the token has expired.
        jwt.InvalidTokenError: If the token is invalid.
    """
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    agent_id = payload.get("agent_id")
    if not agent_id:
        raise jwt.InvalidTokenError("Missing agent_id claim")
    # Validate issuer if present (backward-compatible with old tokens)
    iss = payload.get("iss")
    if iss is not None and iss != "botcord":
        raise jwt.InvalidTokenError("Invalid issuer")
    return agent_id


def get_current_agent(authorization: str = Header(...)) -> str:
    """FastAPI dependency: extract agent_id from Bearer token.

    Raises 401 if the token is missing, malformed, or invalid.
    """
    if not authorization.startswith("Bearer "):
        raise I18nHTTPException(status_code=401, message_key="invalid_authorization_header")
    token = authorization[len("Bearer "):]
    try:
        return verify_agent_token(token)
    except jwt.ExpiredSignatureError:
        raise I18nHTTPException(status_code=401, message_key="token_expired")
    except jwt.InvalidTokenError:
        raise I18nHTTPException(status_code=401, message_key="invalid_token")


async def get_current_claimed_agent(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> str:
    agent_id = get_current_agent(authorization)
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    if agent.claimed_at is None:
        claim_url = f"{FRONTEND_BASE_URL.rstrip('/')}/agents/claim/{agent.claim_code}" if agent.claim_code else None
        if claim_url:
            raise I18nHTTPException(status_code=403, message_key="agent_not_claimed", claim_url=claim_url)
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed_generic")
    return agent_id


def verify_supabase_token(token: str) -> str:
    """Verify a Supabase JWT and return the ``sub`` claim (supabase user id).

    Raises ``jwt.InvalidTokenError`` on any verification failure.
    """
    if not SUPABASE_JWT_SECRET and not _jwks_client:
        raise jwt.InvalidTokenError("Supabase auth not configured")

    if _jwks_client:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
        )
    else:
        payload = jwt.decode(
            token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated",
        )

    sub = payload.get("sub")
    if not sub:
        raise jwt.InvalidTokenError("Missing sub claim")
    return sub


def _parse_dashboard_token(
    authorization: str,
    x_active_agent: str | None,
) -> tuple[str, str | None]:
    """Parse a dashboard Authorization header.

    Returns (agent_id, supabase_user_id | None).
    When the token is a botcord agent JWT, supabase_user_id is None (trusted).
    When the token is a Supabase JWT, supabase_user_id is extracted from ``sub``
    and must be verified against the agent's ``user_id`` by the caller.
    """
    if not authorization.startswith("Bearer "):
        raise I18nHTTPException(status_code=401, message_key="invalid_authorization_header")
    token = authorization[len("Bearer "):]

    # Fast path: botcord agent JWT — agent_id is embedded, already trusted.
    try:
        return verify_agent_token(token), None
    except jwt.InvalidTokenError:
        pass

    # Slow path: Supabase JWT — need X-Active-Agent + ownership check later.
    try:
        supabase_user_id = verify_supabase_token(token)
    except jwt.InvalidTokenError:
        raise I18nHTTPException(status_code=401, message_key="invalid_token")

    if not x_active_agent:
        raise I18nHTTPException(status_code=400, message_key="active_agent_header_required")

    return x_active_agent, supabase_user_id


async def _resolve_internal_user_id(
    db: AsyncSession, supabase_uid: str
) -> str | None:
    """Resolve a Supabase ``sub`` claim to the internal ``users.id``.

    The ``agents.user_id`` column references ``users.id``, not the Supabase
    UUID directly, so we need this indirection.
    """
    result = await db.execute(
        select(User.id).where(User.supabase_user_id == supabase_uid)
    )
    row = result.scalar_one_or_none()
    return str(row) if row else None


async def get_dashboard_agent(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Dashboard dual-token dependency.

    1. Try verifying as a botcord agent token (fast path).
    2. Fall back to Supabase JWT + X-Active-Agent header.

    When using Supabase JWT, verifies that the agent belongs to the
    authenticated user (via ``users.supabase_user_id`` → ``agents.user_id``).
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    if supabase_uid is not None:
        internal_uid = await _resolve_internal_user_id(db, supabase_uid)
        if internal_uid is None:
            raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")
        result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
        agent = result.scalar_one_or_none()
        if agent is None:
            raise I18nHTTPException(status_code=404, message_key="agent_not_found")
        if str(agent.user_id) != internal_uid:
            raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")

    return agent_id


async def get_dashboard_claimed_agent(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Like get_dashboard_agent but also verifies the agent exists and is claimed.

    When using Supabase JWT, verifies agent ownership via ``users`` → ``agents.user_id``.
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    if agent.claimed_at is None:
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed_generic")
    if supabase_uid is not None:
        internal_uid = await _resolve_internal_user_id(db, supabase_uid)
        if internal_uid is None or str(agent.user_id) != internal_uid:
            raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")

    return agent_id


async def get_dashboard_agent_with_user(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> tuple[str, str | None]:
    """Like get_dashboard_claimed_agent but also returns the internal user_id.

    Returns (agent_id, internal_user_id | None).
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    if agent.claimed_at is None:
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed_generic")

    internal_uid: str | None = None
    if supabase_uid is not None:
        internal_uid = await _resolve_internal_user_id(db, supabase_uid)
        if internal_uid is None or str(agent.user_id) != internal_uid:
            raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")
    else:
        # Agent JWT: derive user_id from the agent record
        internal_uid = str(agent.user_id) if agent.user_id else None

    return agent_id, internal_uid

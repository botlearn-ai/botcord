import datetime

import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import JWT_ALGORITHM, JWT_EXPIRE_HOURS, JWT_SECRET, SUPABASE_JWT_SECRET
from hub.database import get_db
from hub.i18n import I18nHTTPException
from hub.models import Agent


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
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed")
    return agent_id


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
    if not SUPABASE_JWT_SECRET:
        raise I18nHTTPException(status_code=401, message_key="user_auth_not_configured")
    try:
        payload = jwt.decode(
            token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated",
        )
    except jwt.InvalidTokenError:
        raise I18nHTTPException(status_code=401, message_key="invalid_token")

    if not x_active_agent:
        raise I18nHTTPException(status_code=400, message_key="active_agent_header_required")

    supabase_user_id = payload.get("sub")
    if not supabase_user_id:
        raise I18nHTTPException(status_code=401, message_key="invalid_token")

    return x_active_agent, supabase_user_id


async def get_dashboard_agent(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Dashboard dual-token dependency.

    1. Try verifying as a botcord agent token (fast path).
    2. Fall back to Supabase JWT + X-Active-Agent header.

    When using Supabase JWT, verifies that the agent belongs to the
    authenticated user (via ``Agent.user_id``).
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    if supabase_uid is not None:
        result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
        agent = result.scalar_one_or_none()
        if agent is None:
            raise I18nHTTPException(status_code=404, message_key="agent_not_found")
        if str(agent.user_id) != supabase_uid:
            raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")

    return agent_id


async def get_dashboard_claimed_agent(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Like get_dashboard_agent but also verifies the agent exists and is claimed.

    When using Supabase JWT, verifies agent ownership via ``Agent.user_id``.
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    if agent.claimed_at is None:
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed")
    if supabase_uid is not None and str(agent.user_id) != supabase_uid:
        raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")

    return agent_id


async def get_dashboard_agent_with_user(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> tuple[str, str | None]:
    """Like get_dashboard_claimed_agent but also returns supabase_user_id.

    Returns (agent_id, supabase_user_id | None).
    """
    agent_id, supabase_uid = _parse_dashboard_token(authorization, x_active_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    if agent.claimed_at is None:
        raise I18nHTTPException(status_code=403, message_key="agent_not_claimed")
    if supabase_uid is not None and str(agent.user_id) != supabase_uid:
        raise I18nHTTPException(status_code=403, message_key="agent_not_owned_by_user")

    # For agent JWT tokens, derive user_id from the agent record
    effective_user_id = supabase_uid or (str(agent.user_id) if agent.user_id else None)
    return agent_id, effective_user_id

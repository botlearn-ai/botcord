import datetime

import jwt
from fastapi import Header, HTTPException

from hub.config import JWT_ALGORITHM, JWT_EXPIRE_HOURS, JWT_SECRET, SUPABASE_JWT_SECRET
from hub.i18n import I18nHTTPException


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


def get_dashboard_agent(
    authorization: str = Header(...),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
) -> str:
    """Dashboard dual-token dependency:
    1. Try verifying as a botcord agent token (fast path).
    2. Fall back to Supabase JWT + X-Active-Agent header.
    """
    if not authorization.startswith("Bearer "):
        raise I18nHTTPException(status_code=401, message_key="invalid_authorization_header")
    token = authorization[len("Bearer "):]

    # Try agent token first
    try:
        return verify_agent_token(token)
    except jwt.InvalidTokenError:
        pass

    # Try Supabase token
    if not SUPABASE_JWT_SECRET:
        raise I18nHTTPException(status_code=401, message_key="user_auth_not_configured")
    try:
        jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
    except jwt.InvalidTokenError:
        raise I18nHTTPException(status_code=401, message_key="invalid_token")

    if not x_active_agent:
        raise I18nHTTPException(status_code=400, message_key="active_agent_header_required")

    return x_active_agent

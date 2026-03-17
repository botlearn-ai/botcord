import datetime

import jwt
from fastapi import Header, HTTPException

from hub.config import JWT_ALGORITHM, JWT_EXPIRE_HOURS, JWT_SECRET


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
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization[len("Bearer "):]
    try:
        return verify_agent_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

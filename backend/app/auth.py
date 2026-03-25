"""Supabase JWT authentication for the /api routes.

Supports both HS256 (shared secret) and RS256/ES256 (JWKS public key)
tokens.  The strategy:

1. Peek at the token header ``alg``.
2. If HS256 → verify with ``SUPABASE_JWT_SECRET``.
3. Otherwise → fetch the signing key from the issuer's JWKS endpoint
   (cached in-process by ``PyJWKClient``).
"""

import logging
import uuid as _uuid
from dataclasses import dataclass, field

import jwt
from jwt import PyJWKClient
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import SUPABASE_JWT_SECRET
from hub.database import get_db
from hub.models import User, UserRole, Role

_logger = logging.getLogger(__name__)

# JWKS clients keyed by issuer URL — lazily created, long-lived.
_jwks_clients: dict[str, PyJWKClient] = {}


@dataclass
class RequestContext:
    """Authenticated user context available to /api route handlers."""

    user_id: _uuid.UUID  # local User.id
    supabase_user_id: str
    roles: list[str] = field(default_factory=list)
    active_agent_id: str | None = None


def _get_jwks_client(issuer: str) -> PyJWKClient:
    """Return a cached ``PyJWKClient`` for the given issuer."""
    if issuer not in _jwks_clients:
        jwks_url = f"{issuer.rstrip('/')}/.well-known/jwks.json"
        _jwks_clients[issuer] = PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_clients[issuer]


def _decode_supabase_token(token: str) -> str:
    """Decode a Supabase JWT and return the ``sub`` claim.

    Raises ``HTTPException(401)`` on any verification failure.
    """
    # Peek at the header to decide verification strategy.
    try:
        header = jwt.get_unverified_header(token)
    except jwt.DecodeError:
        raise HTTPException(status_code=401, detail="Invalid token")

    alg = header.get("alg", "HS256")

    try:
        if alg == "HS256":
            # Shared-secret path (legacy / local dev).
            if not SUPABASE_JWT_SECRET:
                raise HTTPException(status_code=401, detail="User auth is not configured")
            payload = jwt.decode(
                token,
                SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
            )
        else:
            # Asymmetric path — use JWKS from the token's issuer.
            unverified = jwt.decode(token, options={"verify_signature": False})
            issuer = unverified.get("iss", "")
            if not issuer:
                raise HTTPException(status_code=401, detail="Invalid token: missing issuer")
            jwks_client = _get_jwks_client(issuer)
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                audience="authenticated",
            )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as exc:
        _logger.debug("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid token: missing sub claim")

    return sub


async def _load_user_and_roles(
    supabase_user_id: str,
    db: AsyncSession,
) -> tuple[User, list[str]]:
    """Look up local User by supabase_user_id and load role names."""
    # Convert string to UUID for proper column comparison (needed for SQLite)
    try:
        uid = _uuid.UUID(supabase_user_id)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid user identifier")

    result = await db.execute(
        select(User).where(User.supabase_user_id == uid)
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if user.banned_at is not None:
        raise HTTPException(status_code=403, detail="User is banned")

    # Load role names
    role_result = await db.execute(
        select(Role.name)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user.id)
    )
    roles = [row[0] for row in role_result.all()]

    return user, roles


async def require_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RequestContext:
    """Verify Supabase Bearer token, load user, return context."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = authorization[len("Bearer "):]
    supabase_user_id = _decode_supabase_token(token)
    user, roles = await _load_user_and_roles(supabase_user_id, db)

    return RequestContext(
        user_id=user.id,
        supabase_user_id=supabase_user_id,
        roles=roles,
    )


async def require_beta_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Check beta_access for authenticated users on gated routes. Skips unauthenticated requests."""
    from hub.config import BETA_GATE_ENABLED
    if not BETA_GATE_ENABLED:
        return
    if not authorization or not authorization.startswith("Bearer "):
        return  # Let the route's own auth dependency handle unauthenticated requests
    try:
        sub = _decode_supabase_token(authorization[7:])
        user, _ = await _load_user_and_roles(sub, db)
        if not user.beta_access:
            raise HTTPException(status_code=403, detail="Beta access required")
    except HTTPException as exc:
        if exc.status_code == 403:
            raise
        return  # Let the route handle other auth errors


async def require_active_agent(
    authorization: str | None = Header(default=None),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> RequestContext:
    """Like require_user but also validates X-Active-Agent header.

    Ensures the referenced agent belongs to the authenticated user.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = authorization[len("Bearer "):]
    supabase_user_id = _decode_supabase_token(token)
    user, roles = await _load_user_and_roles(supabase_user_id, db)

    if not x_active_agent:
        raise HTTPException(status_code=400, detail="X-Active-Agent header is required")

    # Verify agent ownership
    from hub.models import Agent

    agent_result = await db.execute(
        select(Agent).where(Agent.agent_id == x_active_agent)
    )
    agent = agent_result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if str(agent.user_id) != str(user.id):
        raise HTTPException(status_code=403, detail="Agent not owned by user")

    return RequestContext(
        user_id=user.id,
        supabase_user_id=supabase_user_id,
        roles=roles,
        active_agent_id=x_active_agent,
    )

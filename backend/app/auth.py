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
    # The social identity id of the User (``hu_*``). Available whenever the
    # request carries a valid Supabase JWT, regardless of whether an active
    # Agent is selected — Human-first routes use this as the viewer anchor.
    human_id: str | None = None
    # The User's display name, convenience for building viewer descriptors.
    user_display_name: str | None = None


def _get_jwks_client(issuer: str) -> PyJWKClient:
    """Return a cached ``PyJWKClient`` for the given issuer."""
    if issuer not in _jwks_clients:
        jwks_url = f"{issuer.rstrip('/')}/.well-known/jwks.json"
        _jwks_clients[issuer] = PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_clients[issuer]


def _decode_supabase_token(token: str) -> dict:
    """Decode a Supabase JWT and return the full payload dict.

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

    return payload


async def _load_user_and_roles(
    supabase_user_id: str,
    db: AsyncSession,
    *,
    jwt_payload: dict | None = None,
) -> tuple[User, list[str]]:
    """Look up local User by supabase_user_id, auto-creating if missing."""
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
        # Auto-create: the user exists in Supabase (JWT is valid) but the
        # local record was never created (e.g. email-verify callback landed
        # on a different origin).
        from hub.config import BETA_GATE_ENABLED
        email = (jwt_payload or {}).get("email")
        metadata = (jwt_payload or {}).get("user_metadata", {})
        display_name = (
            metadata.get("full_name")
            or metadata.get("name")
            or metadata.get("preferred_username")
            or (email.split("@")[0] if email else "User")
        )
        user = User(
            supabase_user_id=uid,
            email=email,
            display_name=display_name,
            avatar_url=metadata.get("avatar_url") or metadata.get("picture"),
            beta_access=not BETA_GATE_ENABLED,
        )
        db.add(user)

        # Assign "member" role if it exists
        role_result = await db.execute(
            select(Role).where(Role.name == "member")
        )
        member_role = role_result.scalar_one_or_none()
        if member_role:
            db.add(UserRole(user_id=user.id, role_id=member_role.id))

        await db.commit()
        await db.refresh(user)
        _logger.info("Auto-created local user %s for supabase_user_id %s", user.id, supabase_user_id)

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
    jwt_payload = _decode_supabase_token(token)
    supabase_user_id = jwt_payload["sub"]
    user, roles = await _load_user_and_roles(supabase_user_id, db, jwt_payload=jwt_payload)

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
        jwt_payload = _decode_supabase_token(authorization[7:])
        sub = jwt_payload["sub"]
        user, _ = await _load_user_and_roles(sub, db, jwt_payload=jwt_payload)
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
    jwt_payload = _decode_supabase_token(token)
    supabase_user_id = jwt_payload["sub"]
    user, roles = await _load_user_and_roles(supabase_user_id, db, jwt_payload=jwt_payload)

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
        human_id=user.human_id,
        user_display_name=user.display_name,
    )


async def require_user_with_optional_agent(
    authorization: str | None = Header(default=None),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
) -> RequestContext:
    """Authenticated user context; X-Active-Agent is optional.

    Use for endpoints that work for both Agent-operating and Human-only
    (no active agent selected) sessions. If the header is present it is
    validated for ownership and exposed via ``ctx.active_agent_id``;
    otherwise ``active_agent_id`` is ``None``.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = authorization[len("Bearer "):]
    jwt_payload = _decode_supabase_token(token)
    supabase_user_id = jwt_payload["sub"]
    user, roles = await _load_user_and_roles(supabase_user_id, db, jwt_payload=jwt_payload)

    active_agent_id: str | None = None
    if x_active_agent:
        from hub.models import Agent

        agent_result = await db.execute(
            select(Agent).where(Agent.agent_id == x_active_agent)
        )
        agent = agent_result.scalar_one_or_none()
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        if str(agent.user_id) != str(user.id):
            raise HTTPException(status_code=403, detail="Agent not owned by user")
        active_agent_id = x_active_agent

    return RequestContext(
        user_id=user.id,
        supabase_user_id=supabase_user_id,
        roles=roles,
        active_agent_id=active_agent_id,
        human_id=user.human_id,
        user_display_name=user.display_name,
    )

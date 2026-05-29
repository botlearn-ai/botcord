"""Supabase JWT authentication for the /api routes.

Supports both HS256 (shared secret) and RS256/ES256 (JWKS public key)
tokens.  The strategy:

1. Peek at the token header ``alg``.
2. If HS256 → verify with ``SUPABASE_JWT_SECRET``.
3. Otherwise → fetch the signing key from the issuer's JWKS endpoint
   (cached in-process by ``PyJWKClient``).
"""

import datetime
import logging
import uuid as _uuid
from dataclasses import dataclass, field
from urllib.parse import urlencode

import jwt
from jwt import PyJWKClient
from fastapi import Depends, Header, HTTPException
from sqlalchemy import func as sa_func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import assert_current_agent_token, verify_agent_token
from hub.config import FRONTEND_BASE_URL, SUPABASE_JWT_SECRET
from hub.database import get_db
from hub.models import Agent, AgentManagementGrant, User, UserRole, Role

_logger = logging.getLogger(__name__)

# JWKS clients keyed by issuer URL — lazily created, long-lived.
_jwks_clients: dict[str, PyJWKClient] = {}


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


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
    # "user" for Supabase-authenticated humans, "agent" for owner-granted
    # BotCord agent credentials.
    auth_kind: str = "user"


@dataclass(frozen=True)
class ReservedAgentManagementGrant:
    id: _uuid.UUID
    scope: str
    limits_json: dict


MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE = "cloud_agents:create"
MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION = "team_orchestration:provision"
MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION = "daemon_agents:provision"
MANAGEMENT_SCOPE_RUNTIME_SKILLS_INSTALL = "runtime_skills:install"

ALLOWED_MANAGEMENT_SCOPES = {
    MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE,
    MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
    MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION,
    MANAGEMENT_SCOPE_RUNTIME_SKILLS_INSTALL,
}


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


def _clean_email(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    if not email or "@" not in email:
        return None
    return email


def _jwt_metadata(payload: dict | None, key: str) -> dict:
    value = (payload or {}).get(key)
    return value if isinstance(value, dict) else {}


def _jwt_beta_access(payload: dict | None) -> bool:
    metadata = _jwt_metadata(payload, "user_metadata")
    app_metadata = _jwt_metadata(payload, "app_metadata")
    return metadata.get("beta_access") is True or app_metadata.get("beta_access") is True


def _jwt_can_match_existing_email(payload: dict | None) -> bool:
    if (payload or {}).get("is_anonymous") is True:
        return False

    metadata = _jwt_metadata(payload, "user_metadata")
    app_metadata = _jwt_metadata(payload, "app_metadata")
    providers = app_metadata.get("providers")
    provider_names = providers if isinstance(providers, list) else []

    return (
        app_metadata.get("provider") == "email"
        or "email" in provider_names
        or metadata.get("email_verified") is True
        or app_metadata.get("email_verified") is True
    )


async def _load_user_and_roles(
    supabase_user_id: str,
    db: AsyncSession,
    *,
    jwt_payload: dict | None = None,
) -> tuple[User, list[str]]:
    """Look up local User by Supabase identity, auto-creating if missing.

    Some users can arrive with a fresh Supabase ``sub`` after auth-provider or
    BFF migration while still carrying the same authenticated login email. Prefer
    reattaching that existing local account over silently creating a second
    BotCord account.
    """
    # Convert string to UUID for proper column comparison (needed for SQLite)
    try:
        uid = _uuid.UUID(supabase_user_id)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid user identifier")

    result = await db.execute(
        select(User).where(User.supabase_user_id == uid)
    )
    user = result.scalar_one_or_none()

    email = _clean_email((jwt_payload or {}).get("email"))
    metadata = _jwt_metadata(jwt_payload, "user_metadata")
    jwt_has_beta_access = _jwt_beta_access(jwt_payload)

    if user is None:
        if email and _jwt_can_match_existing_email(jwt_payload):
            result = await db.execute(
                select(User).where(sa_func.lower(User.email) == email)
            )
            user = result.scalar_one_or_none()
            if user is not None:
                previous_supabase_user_id = str(user.supabase_user_id)
                user.supabase_user_id = uid
                user.last_login_at = _utc_now()
                if user.avatar_url is None:
                    user.avatar_url = metadata.get("avatar_url") or metadata.get("picture")
                if jwt_has_beta_access and not user.beta_access:
                    user.beta_access = True
                await db.commit()
                await db.refresh(user)
                _logger.info(
                    "Reattached local user %s from supabase_user_id %s to %s via email",
                    user.id,
                    previous_supabase_user_id,
                    supabase_user_id,
                )

    if user is None:
        # Auto-create: the user exists in Supabase (JWT is valid) but the
        # local record was never created (e.g. email-verify callback landed
        # on a different origin).
        from hub.config import BETA_GATE_ENABLED
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
            beta_access=jwt_has_beta_access or not BETA_GATE_ENABLED,
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

    if jwt_has_beta_access and not user.beta_access:
        user.beta_access = True
        await db.commit()
        await db.refresh(user)

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


def _management_authorize_url(
    agent_id: str,
    scopes: list[str],
    *,
    daemon_instance_id: str | None = None,
) -> str:
    query_params = {"scopes": ",".join(scopes)}
    if daemon_instance_id:
        query_params["daemon_instance_id"] = daemon_instance_id
    query = urlencode(query_params)
    return (
        f"{FRONTEND_BASE_URL.rstrip('/')}/settings/agents/"
        f"{agent_id}/cli-permissions?{query}"
    )


def _normalise_required_scopes(required_scopes: list[str] | tuple[str, ...]) -> list[str]:
    scopes = list(dict.fromkeys(required_scopes))
    unknown = [scope for scope in scopes if scope not in ALLOWED_MANAGEMENT_SCOPES]
    if unknown:
        raise RuntimeError(f"unknown management scope(s): {', '.join(unknown)}")
    return scopes


def _ensure_beta_access(user: User) -> None:
    from hub.config import BETA_GATE_ENABLED

    if BETA_GATE_ENABLED and not user.beta_access:
        raise HTTPException(status_code=403, detail="Beta access required")


async def _context_from_user_token(token: str, db: AsyncSession) -> RequestContext:
    jwt_payload = _decode_supabase_token(token)
    supabase_user_id = jwt_payload["sub"]
    user, roles = await _load_user_and_roles(supabase_user_id, db, jwt_payload=jwt_payload)
    _ensure_beta_access(user)
    return RequestContext(
        user_id=user.id,
        supabase_user_id=supabase_user_id,
        roles=roles,
        human_id=user.human_id,
        user_display_name=user.display_name,
        auth_kind="user",
    )


async def _context_from_agent_token(token: str, db: AsyncSession) -> RequestContext:
    try:
        agent_id = verify_agent_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    assert_current_agent_token(agent, token)
    if agent.claimed_at is None or agent.user_id is None:
        raise HTTPException(status_code=403, detail="Agent is not bound to a user")

    user = await db.scalar(select(User).where(User.id == agent.user_id))
    if user is None:
        raise HTTPException(status_code=403, detail="Agent owner not found")
    _ensure_beta_access(user)

    return RequestContext(
        user_id=user.id,
        supabase_user_id=str(user.supabase_user_id),
        roles=[],
        active_agent_id=agent.agent_id,
        human_id=user.human_id,
        user_display_name=user.display_name,
        auth_kind="agent",
    )


async def require_user_or_agent_owner(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RequestContext:
    """Accept either Supabase user auth or a bound BotCord agent token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = authorization[len("Bearer "):]
    try:
        return await _context_from_agent_token(token, db)
    except HTTPException as agent_exc:
        try:
            return await _context_from_user_token(token, db)
        except HTTPException as user_exc:
            if user_exc.status_code != 401:
                raise user_exc
            raise agent_exc


def _grant_is_current(
    grant: AgentManagementGrant,
    *,
    daemon_instance_id: str | None,
    now: datetime.datetime,
    allow_global_daemon_grant: bool = True,
) -> bool:
    if grant.revoked_at is not None:
        return False
    expires_at = grant.expires_at
    if expires_at is not None:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
        if expires_at <= now:
            return False
    limits = grant.limits_json or {}
    max_uses = limits.get("max_uses")
    if (
        isinstance(max_uses, int)
        and not isinstance(max_uses, bool)
        and max_uses >= 0
        and grant.use_count >= max_uses
    ):
        return False
    if daemon_instance_id is None:
        return grant.daemon_instance_id is None
    if allow_global_daemon_grant and grant.daemon_instance_id is None:
        return True
    return grant.daemon_instance_id == daemon_instance_id


async def missing_agent_management_scopes(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    required_scopes: list[str] | tuple[str, ...],
    daemon_instance_id: str | None = None,
    allow_global_daemon_grant: bool = True,
) -> list[str]:
    scopes = _normalise_required_scopes(required_scopes)
    if ctx.auth_kind != "agent":
        return []
    if not ctx.active_agent_id:
        return scopes

    result = await db.execute(
        select(AgentManagementGrant).where(
            AgentManagementGrant.user_id == ctx.user_id,
            AgentManagementGrant.agent_id == ctx.active_agent_id,
            AgentManagementGrant.scope.in_(scopes),
        )
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    granted = {
        grant.scope
        for grant in result.scalars().all()
        if _grant_is_current(
            grant,
            daemon_instance_id=daemon_instance_id,
            now=now,
            allow_global_daemon_grant=allow_global_daemon_grant,
        )
    }
    return [scope for scope in scopes if scope not in granted]


async def require_agent_management_scopes(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    required_scopes: list[str] | tuple[str, ...],
    daemon_instance_id: str | None = None,
    allow_global_daemon_grant: bool = True,
) -> None:
    missing = await missing_agent_management_scopes(
        db,
        ctx=ctx,
        required_scopes=required_scopes,
        daemon_instance_id=daemon_instance_id,
        allow_global_daemon_grant=allow_global_daemon_grant,
    )
    if not missing:
        return
    agent_id = ctx.active_agent_id or ""
    raise _management_permission_required(
        agent_id=agent_id,
        missing=missing,
        daemon_instance_id=daemon_instance_id,
    )


def _management_permission_required(
    *,
    agent_id: str,
    missing: list[str],
    daemon_instance_id: str | None,
) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={
            "code": "management_permission_required",
            "message": "This agent needs an owner-granted management permission.",
            "agent_id": agent_id,
            "required_scopes": missing,
            "authorize_url": _management_authorize_url(
                agent_id,
                missing,
                daemon_instance_id=daemon_instance_id,
            )
            if agent_id
            else None,
        },
    )


def require_user_or_agent_management(
    required_scopes: list[str] | tuple[str, ...],
):
    scopes = _normalise_required_scopes(required_scopes)

    async def _dependency(
        ctx: RequestContext = Depends(require_user_or_agent_owner),
        db: AsyncSession = Depends(get_db),
    ) -> RequestContext:
        await require_agent_management_scopes(db, ctx=ctx, required_scopes=scopes)
        return ctx

    return _dependency


async def active_agent_management_grants(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    required_scopes: list[str] | tuple[str, ...],
    daemon_instance_id: str | None = None,
    allow_global_daemon_grant: bool = True,
) -> dict[str, AgentManagementGrant]:
    scopes = _normalise_required_scopes(required_scopes)
    if ctx.auth_kind != "agent" or not ctx.active_agent_id:
        return {}
    result = await db.execute(
        select(AgentManagementGrant).where(
            AgentManagementGrant.user_id == ctx.user_id,
            AgentManagementGrant.agent_id == ctx.active_agent_id,
            AgentManagementGrant.scope.in_(scopes),
        )
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    grants: dict[str, AgentManagementGrant] = {}
    for grant in result.scalars().all():
        if not _grant_is_current(
            grant,
            daemon_instance_id=daemon_instance_id,
            now=now,
            allow_global_daemon_grant=allow_global_daemon_grant,
        ):
            continue
        # Prefer daemon-specific grants over global grants when both exist.
        current = grants.get(grant.scope)
        if current is None or (
            daemon_instance_id is not None
            and current.daemon_instance_id is None
            and grant.daemon_instance_id == daemon_instance_id
        ):
            grants[grant.scope] = grant
    return grants


async def reserve_agent_management_scope_uses(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    scopes: list[str] | tuple[str, ...],
    daemon_instance_id: str | None = None,
    allow_global_daemon_grant: bool = True,
) -> dict[str, ReservedAgentManagementGrant]:
    """Atomically reserve management grant uses before a side effect runs."""
    required_scopes = _normalise_required_scopes(scopes)
    if ctx.auth_kind != "agent":
        return {}
    agent_id = ctx.active_agent_id or ""
    if not agent_id:
        raise _management_permission_required(
            agent_id=agent_id,
            missing=required_scopes,
            daemon_instance_id=daemon_instance_id,
        )

    reserved: dict[str, ReservedAgentManagementGrant] = {}
    missing: list[str] = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for scope in required_scopes:
        grant = await _reserve_agent_management_scope_use(
            db,
            ctx=ctx,
            scope=scope,
            daemon_instance_id=daemon_instance_id,
            allow_global_daemon_grant=allow_global_daemon_grant,
            now=now,
        )
        if grant is None:
            missing.append(scope)
        else:
            reserved[scope] = grant

    if missing:
        await db.rollback()
        raise _management_permission_required(
            agent_id=agent_id,
            missing=missing,
            daemon_instance_id=daemon_instance_id,
        )

    await db.commit()
    return reserved


async def _reserve_agent_management_scope_use(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    scope: str,
    daemon_instance_id: str | None,
    allow_global_daemon_grant: bool,
    now: datetime.datetime,
) -> ReservedAgentManagementGrant | None:
    result = await db.execute(
        select(AgentManagementGrant)
        .where(
            AgentManagementGrant.user_id == ctx.user_id,
            AgentManagementGrant.agent_id == ctx.active_agent_id,
            AgentManagementGrant.scope == scope,
        )
        .with_for_update()
    )
    candidates = [
        grant
        for grant in result.scalars().all()
        if _grant_is_current(
            grant,
            daemon_instance_id=daemon_instance_id,
            now=now,
            allow_global_daemon_grant=allow_global_daemon_grant,
        )
    ]
    candidates.sort(
        key=lambda grant: (
            0
            if daemon_instance_id is not None
            and grant.daemon_instance_id == daemon_instance_id
            else 1,
            grant.created_at
            or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc),
        )
    )

    for grant in candidates:
        conditions = [
            AgentManagementGrant.id == grant.id,
            AgentManagementGrant.revoked_at.is_(None),
            or_(
                AgentManagementGrant.expires_at.is_(None),
                AgentManagementGrant.expires_at > now,
            ),
        ]
        if daemon_instance_id is None:
            conditions.append(AgentManagementGrant.daemon_instance_id.is_(None))
        elif allow_global_daemon_grant:
            conditions.append(
                or_(
                    AgentManagementGrant.daemon_instance_id.is_(None),
                    AgentManagementGrant.daemon_instance_id == daemon_instance_id,
                )
            )
        else:
            conditions.append(
                AgentManagementGrant.daemon_instance_id == daemon_instance_id
            )

        limits = grant.limits_json or {}
        max_uses = limits.get("max_uses")
        if (
            isinstance(max_uses, int)
            and not isinstance(max_uses, bool)
            and max_uses >= 0
        ):
            conditions.append(AgentManagementGrant.use_count < max_uses)

        reserved_id = (
            await db.execute(
                update(AgentManagementGrant)
                .where(*conditions)
                .values(use_count=AgentManagementGrant.use_count + 1)
                .returning(AgentManagementGrant.id)
                .execution_options(synchronize_session=False)
            )
        ).scalar_one_or_none()
        if reserved_id is not None:
            return ReservedAgentManagementGrant(
                id=grant.id,
                scope=grant.scope,
                limits_json=grant.limits_json or {},
            )
    return None


async def release_agent_management_scope_uses(
    db: AsyncSession,
    grants: (
        dict[str, ReservedAgentManagementGrant]
        | list[ReservedAgentManagementGrant]
        | tuple[ReservedAgentManagementGrant, ...]
    ),
) -> None:
    grant_values = grants.values() if isinstance(grants, dict) else grants
    grant_ids = [grant.id for grant in grant_values]
    if not grant_ids:
        return
    await db.rollback()
    await db.execute(
        update(AgentManagementGrant)
        .where(
            AgentManagementGrant.id.in_(grant_ids),
            AgentManagementGrant.use_count > 0,
        )
        .values(use_count=AgentManagementGrant.use_count - 1)
        .execution_options(synchronize_session=False)
    )
    await db.commit()


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

import datetime
import hashlib
import json
import logging
import re
import time
import uuid

import jcs
from fastapi import APIRouter, Depends, HTTPException, Request, Response

logger = logging.getLogger(__name__)
from hub.i18n import I18nHTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import create_agent_token, get_current_agent
from hub.config import CHALLENGE_EXPIRE_MINUTES
from hub import config as hub_config
from hub.constants import DEFAULT_TTL_SEC, LATEST_PLUGIN_VERSION, MIN_PLUGIN_VERSION, PROTOCOL_VERSION, is_below_min_version
from hub.crypto import generate_challenge, verify_challenge_sig
from hub.database import get_db
from hub.id_generators import generate_agent_id, generate_endpoint_id, generate_hub_msg_id, generate_key_id
from hub.models import Agent, Challenge, Endpoint, EndpointState, KeyState, MessageRecord, MessageState, SigningKey, UsedNonce
from hub.schemas import (
    AddKeyRequest,
    AddKeyResponse,
    AgentDiscoveryResponse,
    AgentSummary,
    ClaimContextResponse,
    ClaimLinkResponse,
    EndpointHealthStatus,
    EndpointProbeReport,
    EndpointResponse,
    KeyResponse,
    RegisterAgentRequest,
    RegisterAgentResponse,
    RegisterEndpointRequest,
    ResolveEndpointInfo,
    ResolveResponse,
    RevokeKeyResponse,
    TokenRefreshRequest,
    UpdateProfileRequest,
    VerifyRequest,
    VerifyResponse,
)
from hub.services.wallet import get_or_create_wallet
from hub.validators import check_agent_ownership, parse_pubkey, probe_endpoint, probe_endpoint_detailed, validate_endpoint_url

router = APIRouter(prefix="/registry", tags=["registry"])


def _generate_claim_code() -> str:
    return f"clm_{uuid.uuid4().hex}"


@router.post("/agents", response_model=RegisterAgentResponse, status_code=201)
async def register_agent(req: RegisterAgentRequest, db: AsyncSession = Depends(get_db)):
    """Register a new agent. Returns agent_id, key_id, and a challenge nonce.

    Idempotent: if the same pubkey is registered again, returns the existing
    agent with a fresh challenge instead of creating a duplicate.
    """
    pubkey_b64 = parse_pubkey(req.pubkey)

    agent_id = generate_agent_id(pubkey_b64)

    # Check if this agent already exists (same pubkey → same agent_id)
    existing_agent = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
    )
    if existing_agent.scalar_one_or_none() is not None:
        # Agent exists — find the signing key for this pubkey
        existing_key = await db.execute(
            select(SigningKey).where(
                SigningKey.agent_id == agent_id,
                SigningKey.pubkey == req.pubkey,
            )
        )
        sk = existing_key.scalar_one_or_none()
        if sk is None:
            raise I18nHTTPException(status_code=409, message_key="agent_id_collision")
        # Issue a fresh challenge for re-verification
        key_id = sk.key_id
        challenge = generate_challenge()
        expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            minutes=CHALLENGE_EXPIRE_MINUTES
        )
        db.add(Challenge(
            agent_id=agent_id,
            key_id=key_id,
            challenge=challenge,
            expires_at=expires_at,
            used=False,
        ))
        # Update display_name if provided and different
        agent_obj = (await db.execute(
            select(Agent).where(Agent.agent_id == agent_id)
        )).scalar_one()
        if req.display_name and req.display_name != agent_obj.display_name:
            agent_obj.display_name = req.display_name
        if req.bio is not None:
            agent_obj.bio = req.bio
        await db.commit()
        return RegisterAgentResponse(agent_id=agent_id, key_id=key_id, challenge=challenge)

    # New agent — create records
    key_id = generate_key_id()
    challenge = generate_challenge()

    agent = Agent(
        agent_id=agent_id,
        display_name=req.display_name,
        bio=req.bio,
        claim_code=_generate_claim_code(),
    )
    db.add(agent)

    signing_key = SigningKey(
        agent_id=agent_id,
        key_id=key_id,
        pubkey=req.pubkey,
        state=KeyState.pending,
    )
    db.add(signing_key)
    # Flush Agent + SigningKey first so the FK on Challenge.key_id is satisfied
    await db.flush()

    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        minutes=CHALLENGE_EXPIRE_MINUTES
    )
    challenge_record = Challenge(
        agent_id=agent_id,
        key_id=key_id,
        challenge=challenge,
        expires_at=expires_at,
        used=False,
    )
    db.add(challenge_record)

    await db.commit()

    return RegisterAgentResponse(agent_id=agent_id, key_id=key_id, challenge=challenge)


@router.post("/agents/{agent_id}/verify", response_model=VerifyResponse)
async def verify_agent(agent_id: str, req: VerifyRequest, db: AsyncSession = Depends(get_db)):
    """Verify key ownership via challenge-response. Returns a JWT on success."""
    # Find the challenge record
    result = await db.execute(
        select(Challenge).where(
            Challenge.agent_id == agent_id,
            Challenge.key_id == req.key_id,
            Challenge.challenge == req.challenge,
        )
    )
    challenge_record = result.scalar_one_or_none()
    if challenge_record is None:
        raise I18nHTTPException(status_code=404, message_key="challenge_not_found")

    if challenge_record.used:
        raise I18nHTTPException(status_code=400, message_key="challenge_already_used")

    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = challenge_record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if now > expires_at:
        raise I18nHTTPException(status_code=400, message_key="challenge_expired")

    # Get the signing key (scoped to agent_id)
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == req.key_id,
            SigningKey.agent_id == agent_id,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None:
        raise I18nHTTPException(status_code=404, message_key="key_not_found")

    # Extract base64 pubkey from "ed25519:<base64>" format
    pubkey_b64 = signing_key.pubkey[len("ed25519:"):]

    # Verify the signature
    if not verify_challenge_sig(pubkey_b64, req.challenge, req.sig):
        raise I18nHTTPException(status_code=401, message_key="signature_verification_failed")

    # Mark challenge as used, activate key, issue token
    challenge_record.used = True
    signing_key.state = KeyState.active

    # Auto-create wallet on first verification
    await get_or_create_wallet(db, agent_id)

    token, expires_at = create_agent_token(agent_id)

    # Look up agent to get claim_code for claim_url
    agent_result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
    )
    agent = agent_result.scalar_one_or_none()
    claim_url = None
    if agent and agent.claim_code:
        claim_url = f"{hub_config.FRONTEND_BASE_URL.rstrip('/')}/agents/claim/{agent.claim_code}"

    await db.commit()

    return VerifyResponse(agent_token=token, expires_at=expires_at, claim_url=claim_url)


# ---------------------------------------------------------------------------
# Route 3: Register endpoint (relaxed — probe failure → state=unverified)
# ---------------------------------------------------------------------------


def _build_welcome_envelope(agent_id: str) -> dict:
    """Build an unsigned system message welcoming the agent after endpoint registration."""
    payload = {
        "text": (
            "[BotCord Hub] Welcome! Your webhook endpoint is active. "
            "This test message confirms delivery is working."
        )
    }
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    return {
        "v": PROTOCOL_VERSION,
        "msg_id": str(uuid.uuid4()),
        "ts": int(time.time()),
        "from": "hub",
        "to": agent_id,
        "type": "system",
        "reply_to": None,
        "ttl_sec": DEFAULT_TTL_SEC,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": "hub", "value": ""},
    }


@router.post("/agents/{agent_id}/endpoints", response_model=EndpointResponse, status_code=201, deprecated=True)
async def register_endpoint(
    agent_id: str,
    req: RegisterEndpointRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Register or update an agent endpoint. Probe failure results in state=unverified."""
    response.headers["Deprecation"] = "true"
    response.headers["Warning"] = '299 BotCord "Webhook endpoint delivery is deprecated; use /hub/ws + /hub/inbox"'
    check_agent_ownership(agent_id, current_agent)
    validate_endpoint_url(req.url)

    # Run probe — capture success/failure instead of letting 422 propagate
    now = datetime.datetime.now(datetime.timezone.utc)
    probe_ok = True
    try:
        await probe_endpoint(req.url, req.webhook_token)
    except HTTPException:
        probe_ok = False

    initial_state = EndpointState.active if probe_ok else EndpointState.unverified

    # Check agent exists
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    # If an active, unreachable, or unverified endpoint exists, update it
    result = await db.execute(
        select(Endpoint).where(
            Endpoint.agent_id == agent_id,
            Endpoint.state.in_([
                EndpointState.active,
                EndpointState.unreachable,
                EndpointState.unverified,
            ]),
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        was_not_active = existing.state != EndpointState.active
        existing.url = req.url
        existing.webhook_token = req.webhook_token
        existing.state = initial_state
        existing.last_probe_at = now

        if was_not_active and initial_state == EndpointState.active:
            # Restart stalled messages that were parked due to ENDPOINT_UNREACHABLE
            stalled = await db.execute(
                select(MessageRecord).where(
                    MessageRecord.receiver_id == agent_id,
                    MessageRecord.state == MessageState.queued,
                    MessageRecord.last_error == "ENDPOINT_UNREACHABLE",
                    MessageRecord.next_retry_at.is_(None),
                )
            )
            for rec in stalled.scalars().all():
                rec.next_retry_at = now

        await db.commit()
        await db.refresh(existing)
        resp = EndpointResponse(
            endpoint_id=existing.endpoint_id,
            url=existing.url,
            state=existing.state.value,
            webhook_token_set=existing.webhook_token is not None,
            registered_at=existing.registered_at,
        )
        json_resp = JSONResponse(content=resp.model_dump(mode="json"), status_code=200)
        json_resp.headers["Deprecation"] = "true"
        json_resp.headers["Warning"] = '299 BotCord "Webhook endpoint delivery is deprecated; use /hub/ws + /hub/inbox"'
        return json_resp

    # Create new endpoint
    endpoint_id = generate_endpoint_id()
    endpoint = Endpoint(
        agent_id=agent_id,
        endpoint_id=endpoint_id,
        url=req.url,
        webhook_token=req.webhook_token,
        state=initial_state,
        last_probe_at=now,
    )
    db.add(endpoint)
    await db.commit()
    await db.refresh(endpoint)

    # Queue welcome message on NEW registration with state=active
    if initial_state == EndpointState.active:
        welcome_env = _build_welcome_envelope(agent_id)
        welcome_record = MessageRecord(
            hub_msg_id=generate_hub_msg_id(),
            msg_id=welcome_env["msg_id"],
            sender_id="hub",
            receiver_id=agent_id,
            state=MessageState.queued,
            envelope_json=json.dumps(welcome_env),
            ttl_sec=DEFAULT_TTL_SEC,
            created_at=now,
            next_retry_at=now,
        )
        db.add(welcome_record)
        await db.commit()

    return EndpointResponse(
        endpoint_id=endpoint.endpoint_id,
        url=endpoint.url,
        state=endpoint.state.value,
        webhook_token_set=endpoint.webhook_token is not None,
        registered_at=endpoint.registered_at,
    )


# ---------------------------------------------------------------------------
# Endpoint test (dry-run probe, no DB write)
# ---------------------------------------------------------------------------


@router.post(
    "/agents/{agent_id}/endpoints/test",
    response_model=EndpointProbeReport,
    deprecated=True,
)
async def test_endpoint(
    agent_id: str,
    req: RegisterEndpointRequest,
    response: Response,
    current_agent: str = Depends(get_current_agent),
):
    """Dry-run endpoint probe — tests both paths, returns structured report, no DB write."""
    response.headers["Deprecation"] = "true"
    response.headers["Warning"] = '299 BotCord "Webhook endpoint delivery is deprecated; use /hub/ws + /hub/inbox"'
    check_agent_ownership(agent_id, current_agent)
    validate_endpoint_url(req.url)
    return await probe_endpoint_detailed(req.url, req.webhook_token)


# ---------------------------------------------------------------------------
# Endpoint status dashboard
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/endpoints/status",
    response_model=EndpointHealthStatus,
    deprecated=True,
)
async def endpoint_status(
    agent_id: str,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Get endpoint health status: state, queued/failed counts, recent errors."""
    response.headers["Deprecation"] = "true"
    response.headers["Warning"] = '299 BotCord "Webhook endpoint delivery is deprecated; use /hub/ws + /hub/inbox"'
    check_agent_ownership(agent_id, current_agent)

    # Find endpoint in any non-inactive state
    result = await db.execute(
        select(Endpoint).where(
            Endpoint.agent_id == agent_id,
            Endpoint.state.in_([
                EndpointState.active,
                EndpointState.unreachable,
                EndpointState.unverified,
            ]),
        )
    )
    endpoint = result.scalar_one_or_none()
    if endpoint is None:
        raise I18nHTTPException(status_code=404, message_key="no_endpoint_registered")

    # Queued message count
    queued_result = await db.execute(
        select(func.count(MessageRecord.id)).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.state == MessageState.queued,
        )
    )
    queued_count = queued_result.scalar() or 0

    # Failed message count (last 24h)
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
    failed_result = await db.execute(
        select(func.count(MessageRecord.id)).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.state == MessageState.failed,
            MessageRecord.created_at >= cutoff,
        )
    )
    failed_count = failed_result.scalar() or 0

    # Recent distinct error strings (limit 10)
    from sqlalchemy import distinct
    errors_result = await db.execute(
        select(distinct(MessageRecord.last_error)).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.last_error.isnot(None),
            MessageRecord.created_at >= cutoff,
        ).limit(10)
    )
    recent_errors = [row[0] for row in errors_result.all() if row[0]]

    return EndpointHealthStatus(
        endpoint_id=endpoint.endpoint_id,
        url=endpoint.url,
        state=endpoint.state.value,
        webhook_token_set=endpoint.webhook_token is not None,
        registered_at=endpoint.registered_at,
        last_probe_at=endpoint.last_probe_at,
        last_delivery_error=endpoint.last_delivery_error,
        queued_message_count=queued_count,
        failed_message_count=failed_count,
        recent_errors=recent_errors,
    )


# ---------------------------------------------------------------------------
# Route 4: Get key info
# ---------------------------------------------------------------------------


@router.get("/agents/{agent_id}/keys/{key_id}", response_model=KeyResponse)
async def get_key(agent_id: str, key_id: str, db: AsyncSession = Depends(get_db)):
    """Get public key info. Key must belong to the specified agent."""
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == key_id,
            SigningKey.agent_id == agent_id,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None:
        raise I18nHTTPException(status_code=404, message_key="key_not_found")

    return KeyResponse(
        key_id=signing_key.key_id,
        pubkey=signing_key.pubkey,
        state=signing_key.state.value,
        created_at=signing_key.created_at,
    )


# ---------------------------------------------------------------------------
# Route 5: Resolve agent
# ---------------------------------------------------------------------------


@router.get("/resolve/{agent_id}", response_model=ResolveResponse)
async def resolve_agent(agent_id: str, db: AsyncSession = Depends(get_db)):
    """Resolve agent info + endpoint availability."""
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    result = await db.execute(
        select(Endpoint).where(
            Endpoint.agent_id == agent_id,
            Endpoint.state == EndpointState.active,
        )
    )
    rows = result.scalars().all()
    endpoints = [
        ResolveEndpointInfo(
            endpoint_id=ep.endpoint_id,
            url=ep.url,
            state=ep.state.value,
        )
        for ep in rows
    ]

    return ResolveResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        bio=agent.bio,
        is_claimed=agent.claimed_at is not None,
        has_endpoint=len(endpoints) > 0,
        endpoints=endpoints,
    )


# ---------------------------------------------------------------------------
# Route 6: Agent discovery
# ---------------------------------------------------------------------------


@router.get("/agents", response_model=AgentDiscoveryResponse, include_in_schema=False)
async def discover_agents(name: str | None = None, db: AsyncSession = Depends(get_db)):
    """Discover agents by display_name — temporarily disabled."""
    raise I18nHTTPException(status_code=403, message_key="agent_discovery_disabled")


# ---------------------------------------------------------------------------
# Route 6b: Update agent profile (display_name, bio)
# ---------------------------------------------------------------------------


@router.patch("/agents/{agent_id}/profile", response_model=ResolveResponse)
async def update_profile(
    agent_id: str,
    req: UpdateProfileRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Update agent profile fields (display_name, bio)."""
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    if req.display_name is not None:
        agent.display_name = req.display_name
    if req.bio is not None:
        agent.bio = req.bio

    await db.commit()
    await db.refresh(agent)

    # Return full resolve-style response
    ep_result = await db.execute(
        select(Endpoint).where(
            Endpoint.agent_id == agent_id,
            Endpoint.state == EndpointState.active,
        )
    )
    endpoints = [
        ResolveEndpointInfo(
            endpoint_id=ep.endpoint_id, url=ep.url, state=ep.state.value
        )
        for ep in ep_result.scalars().all()
    ]

    return ResolveResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        bio=agent.bio,
        is_claimed=agent.claimed_at is not None,
        has_endpoint=len(endpoints) > 0,
        endpoints=endpoints,
    )


@router.get(
    "/agents/{agent_id}/claim-context",
    response_model=ClaimContextResponse,
)
async def get_claim_context(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Resolve static claim context from agent_id."""
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    return ClaimContextResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
    )


@router.get(
    "/agents/{agent_id}/claim-link",
    response_model=ClaimLinkResponse,
)
async def get_claim_link(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Get (or create) claim_code and claim URL for agent-owned claiming flow."""
    check_agent_ownership(agent_id, current_agent)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    if not agent.claim_code:
        agent.claim_code = _generate_claim_code()
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            # Extremely unlikely random collision: retry once.
            agent.claim_code = _generate_claim_code()
            await db.commit()
        await db.refresh(agent)

    return ClaimLinkResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        claim_code=agent.claim_code,
        claim_url=f"{hub_config.FRONTEND_BASE_URL.rstrip('/')}/agents/claim/{agent.claim_code}",
    )


# ---------------------------------------------------------------------------
# Route 7: Add key (key rotation)
# ---------------------------------------------------------------------------


@router.post("/agents/{agent_id}/keys", response_model=AddKeyResponse, status_code=201)
async def add_key(
    agent_id: str,
    req: AddKeyRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Add a new signing key (pending until verified)."""
    check_agent_ownership(agent_id, current_agent)
    parse_pubkey(req.pubkey)

    key_id = generate_key_id()
    challenge = generate_challenge()

    signing_key = SigningKey(
        agent_id=agent_id,
        key_id=key_id,
        pubkey=req.pubkey,
        state=KeyState.pending,
    )
    db.add(signing_key)
    # Flush SigningKey first so the FK on Challenge.key_id is satisfied
    await db.flush()

    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        minutes=CHALLENGE_EXPIRE_MINUTES
    )
    challenge_record = Challenge(
        agent_id=agent_id,
        key_id=key_id,
        challenge=challenge,
        expires_at=expires_at,
        used=False,
    )
    db.add(challenge_record)

    await db.commit()

    return AddKeyResponse(key_id=key_id, challenge=challenge)


# ---------------------------------------------------------------------------
# Route 8: Revoke key
# ---------------------------------------------------------------------------


@router.delete("/agents/{agent_id}/keys/{key_id}", response_model=RevokeKeyResponse)
async def revoke_key(
    agent_id: str,
    key_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Revoke a signing key. Cannot revoke the last active key."""
    check_agent_ownership(agent_id, current_agent)

    # Find the key
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == key_id,
            SigningKey.agent_id == agent_id,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None:
        raise I18nHTTPException(status_code=404, message_key="key_not_found")

    if signing_key.state == KeyState.revoked:
        raise I18nHTTPException(status_code=400, message_key="key_already_revoked")

    # Count active keys for this agent
    result = await db.execute(
        select(func.count(SigningKey.id)).where(
            SigningKey.agent_id == agent_id,
            SigningKey.state == KeyState.active,
        )
    )
    active_count = result.scalar() or 0

    if active_count <= 1 and signing_key.state == KeyState.active:
        raise I18nHTTPException(status_code=400, message_key="cannot_revoke_last_active_key")

    signing_key.state = KeyState.revoked
    await db.commit()

    return RevokeKeyResponse(key_id=signing_key.key_id, state=signing_key.state.value)


@router.post("/agents/{agent_id}/token/refresh", response_model=VerifyResponse)
async def refresh_token(
    agent_id: str, req: TokenRefreshRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """Refresh JWT by proving key ownership via nonce signature."""
    # Log and enforce client plugin version
    plugin_version = re.sub(r"[^\w.\-]", "", request.headers.get("X-Plugin-Version", "")[:20]) or None
    if plugin_version:
        logger.info("Token refresh: agent=%s plugin_version=%s", agent_id, plugin_version)
        if is_below_min_version(plugin_version):
            logger.warning("Token refresh rejected: agent=%s plugin_version=%s below min=%s",
                           agent_id, plugin_version, MIN_PLUGIN_VERSION)
            raise HTTPException(
                status_code=426,
                detail=f"Plugin {plugin_version} is below minimum {MIN_PLUGIN_VERSION}. "
                       f"Please update: openclaw plugins install @botcord/botcord@latest",
            )

    # 1. Look up the signing key
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == req.key_id,
            SigningKey.agent_id == agent_id,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None:
        raise I18nHTTPException(status_code=404, message_key="key_not_found")

    if signing_key.state != KeyState.active:
        raise I18nHTTPException(status_code=403, message_key="key_not_active")

    # 2. Check nonce has not been used (anti-replay)
    result = await db.execute(
        select(UsedNonce).where(
            UsedNonce.agent_id == agent_id,
            UsedNonce.nonce == req.nonce,
        )
    )
    if result.scalar_one_or_none() is not None:
        raise I18nHTTPException(status_code=409, message_key="nonce_already_used")

    # 3. Verify signature over the nonce
    pubkey_b64 = signing_key.pubkey[len("ed25519:"):]
    if not verify_challenge_sig(pubkey_b64, req.nonce, req.sig):
        raise I18nHTTPException(status_code=401, message_key="signature_verification_failed")

    # 4. Record nonce as used (with IntegrityError guard for concurrent requests)
    db.add(UsedNonce(agent_id=agent_id, nonce=req.nonce))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise I18nHTTPException(status_code=409, message_key="nonce_already_used")

    # 5. Issue new token
    token, expires_at = create_agent_token(agent_id)

    await db.commit()

    return VerifyResponse(
        agent_token=token,
        expires_at=expires_at,
        latest_plugin_version=LATEST_PLUGIN_VERSION,
        min_plugin_version=MIN_PLUGIN_VERSION,
    )

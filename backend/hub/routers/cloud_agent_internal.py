"""Internal Cloud Agent endpoints — invoked by the in-sandbox cloud daemon.

Only one endpoint today: ``POST /internal/cloud-agents/runs/{run_id}/settle``.
The cloud daemon hits it when a ``cloud_run`` finishes, reporting token
counts and sandbox seconds; the Hub applies them through
:class:`UsageService.settle` so the usage ledger and per-user balance
stay in sync.

Auth accepts either:

- ``Authorization: Bearer <INTERNAL_API_SECRET>`` — for operator / cron
  callers (same pattern as ``/internal/wallet/*``); requires
  ``ALLOW_PRIVATE_ENDPOINTS``.
- ``Authorization: Bearer <cloud-daemon-access JWT>`` — for the cloud
  daemon itself. The JWT's ``cloud_daemon_instance_id`` claim binds the
  call to one cloud daemon; the endpoint then verifies the supplied
  ``run_id`` actually belongs to an agent hosted on that daemon.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.database import get_db
from hub.i18n import I18nHTTPException
from hub.models import CloudAgentInstance, UsageReservation
from hub.routers.cloud_daemon_control import (
    _TokenError,
    _verify_cloud_daemon_access_token,
)
from hub.services.cloud_agent_usage import TokenUsage, UsageError, UsageService

logger = logging.getLogger(__name__)


internal_router = APIRouter(
    prefix="/internal/cloud-agents", tags=["cloud-agents-internal"]
)


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class SettleRunRequest(BaseModel):
    provider: str = Field(default="deepseek")
    model: str
    input_cache_hit_tokens: int = Field(default=0, ge=0)
    input_cache_miss_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    sandbox_seconds: int = Field(default=0, ge=0)
    idempotency_key: str | None = Field(default=None, max_length=128)
    metadata: dict | None = None


class SettleRunResponse(BaseModel):
    run_id: str
    usage_event_id: int
    credits_charged: int
    sandbox_seconds: int
    idempotency_key: str
    deduplicated: bool


# ---------------------------------------------------------------------------
# Auth — dual-mode (cloud daemon JWT OR internal secret)
# ---------------------------------------------------------------------------


def _try_cloud_daemon_token(authorization: str | None) -> str | None:
    """Return ``cloud_daemon_instance_id`` if the bearer is a valid cloud-daemon JWT.

    Returns ``None`` when the header is missing or isn't a cloud-daemon
    token. The caller falls through to the internal-secret path.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    candidate = authorization.removeprefix("Bearer ").strip()
    try:
        claims = _verify_cloud_daemon_access_token(candidate)
    except _TokenError:
        return None
    cloud_daemon_instance_id = claims.get("cloud_daemon_instance_id")
    if not isinstance(cloud_daemon_instance_id, str):
        return None
    return cloud_daemon_instance_id


def _require_internal_secret(authorization: str | None) -> None:
    """Verify the operator-side fallback bearer — mirrors wallet._require_internal."""
    if not hub_config.ALLOW_PRIVATE_ENDPOINTS:
        raise I18nHTTPException(
            status_code=403, message_key="internal_endpoints_disabled"
        )
    expected = hub_config.INTERNAL_API_SECRET
    if expected:
        if not authorization or not authorization.startswith("Bearer "):
            raise I18nHTTPException(
                status_code=401, message_key="missing_internal_api_secret"
            )
        provided = authorization.removeprefix("Bearer ").strip()
        if provided != expected:
            raise I18nHTTPException(
                status_code=401, message_key="invalid_internal_api_secret"
            )


async def _authorize_settle(
    *,
    db: AsyncSession,
    run_id: str,
    authorization: str | None,
) -> None:
    """Authorize a settle call. Either the cloud daemon JWT bound to this
    run's host, or the operator INTERNAL_API_SECRET.

    The JWT path looks up the reservation and confirms the underlying
    agent is hosted on the daemon named in the token's claim — that
    stops one cloud daemon from settling another's runs.
    """
    cloud_daemon_instance_id = _try_cloud_daemon_token(authorization)
    if cloud_daemon_instance_id is None:
        # No cloud-daemon JWT — must be the operator path.
        _require_internal_secret(authorization)
        return

    reservation = await db.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run_id)
    )
    if reservation is None:
        # Don't leak whether run_ids exist via auth error code; the
        # settle handler will raise the canonical 404 below.
        return

    cai = await db.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == reservation.agent_id
        )
    )
    if cai is None or cai.cloud_daemon_instance_id != cloud_daemon_instance_id:
        raise I18nHTTPException(
            status_code=403,
            message_key="cloud_run_settle_wrong_daemon",
            detail=(
                f"cloud daemon {cloud_daemon_instance_id!r} cannot settle "
                f"run {run_id!r}"
            ),
        )


# ---------------------------------------------------------------------------
# Service dependency — overridable by tests
# ---------------------------------------------------------------------------


_DEFAULT_USAGE_SERVICE = UsageService()


def get_usage_service() -> UsageService:
    """FastAPI dependency exposing the usage ledger orchestrator."""
    return _DEFAULT_USAGE_SERVICE


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@internal_router.post(
    "/runs/{run_id}/settle", response_model=SettleRunResponse, status_code=200
)
async def settle_cloud_run(
    run_id: str,
    req: SettleRunRequest,
    db: AsyncSession = Depends(get_db),
    usage: UsageService = Depends(get_usage_service),
    authorization: str | None = Header(default=None),
) -> SettleRunResponse:
    """Settle the reservation for ``run_id`` and update the usage ledger.

    Idempotent on ``idempotency_key`` (default ``f"{run_id}:settle"``); a
    second call with the same key returns the existing event with
    ``deduplicated=True``.
    """
    await _authorize_settle(db=db, run_id=run_id, authorization=authorization)

    tokens = TokenUsage(
        input_cache_hit_tokens=req.input_cache_hit_tokens,
        input_cache_miss_tokens=req.input_cache_miss_tokens,
        output_tokens=req.output_tokens,
    )

    try:
        result = await usage.settle(
            db,
            run_id=run_id,
            provider=req.provider,
            model=req.model,
            tokens=tokens,
            sandbox_seconds=req.sandbox_seconds,
            idempotency_key=req.idempotency_key,
            metadata=req.metadata,
        )
        await db.commit()
    except UsageError as exc:
        # Map service-level errors to the right HTTP status. The cloud
        # daemon retries on 5xx but not on 4xx, so be precise here.
        if exc.code == "reservation_not_found":
            raise I18nHTTPException(
                status_code=404,
                message_key="cloud_run_reservation_not_found",
                detail=exc.message,
            ) from exc
        if exc.code == "reservation_not_active":
            raise I18nHTTPException(
                status_code=409,
                message_key="cloud_run_reservation_not_active",
                detail=exc.message,
            ) from exc
        logger.warning(
            "settle_cloud_run UsageError code=%s msg=%s", exc.code, exc.message
        )
        raise I18nHTTPException(
            status_code=400,
            message_key="cloud_run_settle_failed",
            detail=exc.message,
        ) from exc

    return SettleRunResponse(
        run_id=run_id,
        usage_event_id=result.usage_event_id,
        credits_charged=result.credits_charged,
        sandbox_seconds=result.sandbox_seconds,
        idempotency_key=result.idempotency_key,
        deduplicated=result.deduplicated,
    )

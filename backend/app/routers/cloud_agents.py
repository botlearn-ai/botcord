"""
[INPUT]: Authenticated user + Pydantic request bodies for Cloud Agent CRUD.
[OUTPUT]: /api/cloud-agents — create / list / get / pause / resume / delete.
[POS]: BFF surface for the Cloud Agent MVP, gated by ``CLOUD_AGENT_FEATURE_ENABLED``.
[PROTOCOL]: Only the authenticated user that owns the Cloud Agent may operate on it.
"""

from __future__ import annotations

import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE,
    RequestContext,
    release_agent_management_scope_uses,
    reserve_agent_management_scope_uses,
    require_user,
    require_user_or_agent_management,
)
from hub.database import get_db
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentRunView,
    CloudAgentUsageView,
    CloudAgentService,
    CloudAgentView,
    CreateCloudAgentInput,
    CreateRunInput,
    RunBudget,
)
from hub.services.new_api import NewApiError, NewApiService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cloud-agents", tags=["app-cloud-agents"])


# Module-level service instance. Tests override via
# ``app.dependency_overrides[get_cloud_agent_service]``.
_DEFAULT_SERVICE = CloudAgentService()
_DEFAULT_NEW_API_SERVICE = NewApiService()


def get_cloud_agent_service() -> CloudAgentService:
    """FastAPI dependency: hook for tests to inject a configured service."""
    return _DEFAULT_SERVICE


def get_new_api_service() -> NewApiService:
    """FastAPI dependency: hook for tests to inject a configured new-api client."""
    return _DEFAULT_NEW_API_SERVICE


def _set_default_service_for_tests(service: CloudAgentService) -> None:
    """Test-only: replace the module-level default."""
    global _DEFAULT_SERVICE
    _DEFAULT_SERVICE = service


def _handle_service_error(exc: CloudAgentError) -> HTTPException:
    return HTTPException(
        status_code=exc.http_status,
        detail={"code": exc.code, "message": exc.message},
    )


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class CreateCloudAgentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    bio: str | None = Field(default=None, max_length=2048)
    model_profile: str | None = Field(default=None, max_length=64)
    runtime: str | None = Field(default=None, max_length=64)
    runtime_model: str | None = Field(default=None, max_length=128)
    reasoning_effort: str | None = Field(default=None, max_length=64)
    thinking: bool | None = None


class CloudAgentOut(BaseModel):
    cloud_agent_instance_id: str
    agent_id: str
    name: str
    bio: str | None
    avatar_url: str | None
    hosting_kind: str
    runtime: str
    model_profile: str
    status: str
    cloud_daemon_instance_id: str
    cloud_daemon_status: str
    provider: str
    provider_sandbox_id: str | None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    last_run_at: datetime.datetime | None
    error_code: str | None
    error_message: str | None
    runtime_model: str | None = None
    reasoning_effort: str | None = None
    thinking: bool | None = None

    @classmethod
    def from_view(cls, view: CloudAgentView) -> "CloudAgentOut":
        return cls(
            cloud_agent_instance_id=view.cloud_agent_instance_id,
            agent_id=view.agent_id,
            name=view.name,
            bio=view.bio,
            avatar_url=view.avatar_url,
            hosting_kind=view.hosting_kind,
            runtime=view.runtime,
            model_profile=view.model_profile,
            status=view.status,
            cloud_daemon_instance_id=view.cloud_daemon_instance_id,
            cloud_daemon_status=view.cloud_daemon_status,
            provider=view.provider,
            provider_sandbox_id=view.provider_sandbox_id,
            created_at=view.created_at,
            updated_at=view.updated_at,
            last_run_at=view.last_run_at,
            error_code=view.error_code,
            error_message=view.error_message,
            runtime_model=view.runtime_model,
            reasoning_effort=view.reasoning_effort,
            thinking=view.thinking,
        )


class CloudAgentListOut(BaseModel):
    cloud_agents: list[CloudAgentOut]


class RunBudgetIn(BaseModel):
    max_wall_time_seconds: int = Field(default=600, ge=1, le=14400)
    max_tool_calls: int = Field(default=30, ge=1, le=1000)


class CreateRunRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=65536)
    room_id: str | None = Field(default=None, max_length=64)
    topic: str | None = Field(default=None, max_length=256)
    budget: RunBudgetIn | None = None


class RunBudgetOut(BaseModel):
    max_wall_time_seconds: int
    max_tool_calls: int


class CloudAgentRunOut(BaseModel):
    run_id: str
    agent_id: str
    hub_msg_id: str
    room_id: str
    status: str
    budget: RunBudgetOut

    @classmethod
    def from_view(cls, view: CloudAgentRunView) -> "CloudAgentRunOut":
        return cls(
            run_id=view.run_id,
            agent_id=view.agent_id,
            hub_msg_id=view.hub_msg_id,
            room_id=view.room_id,
            status=view.status,
            budget=RunBudgetOut(
                max_wall_time_seconds=view.budget.max_wall_time_seconds,
                max_tool_calls=view.budget.max_tool_calls,
            ),
        )


class CloudAgentUsageEventOut(BaseModel):
    run_id: str
    provider: str
    model: str
    input_cache_hit_tokens: int
    input_cache_miss_tokens: int
    output_tokens: int
    sandbox_seconds: int
    credits_charged: int
    idempotency_key: str
    created_at: datetime.datetime


class CloudAgentUsageOut(BaseModel):
    agent_id: str
    period_start: datetime.datetime
    period_end: datetime.datetime
    included_credits: int
    used_credits: int
    reserved_credits: int
    available_credits: int
    included_sandbox_seconds: int
    used_sandbox_seconds: int
    reserved_sandbox_seconds: int
    available_sandbox_seconds: int
    events: list[CloudAgentUsageEventOut]

    @classmethod
    def from_view(cls, view: CloudAgentUsageView) -> "CloudAgentUsageOut":
        return cls(
            agent_id=view.agent_id,
            period_start=view.period_start,
            period_end=view.period_end,
            included_credits=view.included_credits,
            used_credits=view.used_credits,
            reserved_credits=view.reserved_credits,
            available_credits=view.available_credits,
            included_sandbox_seconds=view.included_sandbox_seconds,
            used_sandbox_seconds=view.used_sandbox_seconds,
            reserved_sandbox_seconds=view.reserved_sandbox_seconds,
            available_sandbox_seconds=view.available_sandbox_seconds,
            events=[CloudAgentUsageEventOut(**event.__dict__) for event in view.events],
        )


class CloudAgentApiTokenBalanceOut(BaseModel):
    configured: bool
    provisioned: bool
    api_base_url: str | None
    new_api_user_id: int | None
    new_api_username: str | None
    token_id: int | None
    token_name: str | None
    quota: int
    used_quota: int
    token_remain_quota: int
    token_used_quota: int
    quota_per_usd: float
    balance_usd: float
    token_balance_usd: float


class CloudAgentApiTokenRechargeRequest(BaseModel):
    amount_usd: float = Field(gt=0, le=10000)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("", status_code=201, response_model=CloudAgentOut)
async def create_cloud_agent(
    body: CreateCloudAgentRequest,
    ctx: RequestContext = Depends(
        require_user_or_agent_management([MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE])
    ),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentOut:
    reserved_grants = await reserve_agent_management_scope_uses(
        db,
        ctx=ctx,
        scopes=[MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE],
    )
    try:
        view = await service.create_cloud_agent(
            db,
            user_id=ctx.user_id,
            body=CreateCloudAgentInput(
                name=body.name,
                bio=body.bio,
                model_profile=body.model_profile,
                runtime=body.runtime,
                runtime_model=body.runtime_model,
                reasoning_effort=body.reasoning_effort,
                thinking=body.thinking,
            ),
        )
        await db.commit()
    except CloudAgentError as exc:
        await release_agent_management_scope_uses(db, reserved_grants)
        raise _handle_service_error(exc) from exc
    except Exception:
        await release_agent_management_scope_uses(db, reserved_grants)
        raise
    return CloudAgentOut.from_view(view)


@router.get("", response_model=CloudAgentListOut)
async def list_cloud_agents(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentListOut:
    try:
        views = await service.list_cloud_agents(db, user_id=ctx.user_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentListOut(
        cloud_agents=[CloudAgentOut.from_view(v) for v in views]
    )


def _api_token_balance_out(balance) -> CloudAgentApiTokenBalanceOut:
    return CloudAgentApiTokenBalanceOut(
        configured=balance.configured,
        provisioned=balance.provisioned,
        api_base_url=balance.api_base_url,
        new_api_user_id=balance.new_api_user_id,
        new_api_username=balance.new_api_username,
        token_id=balance.token_id,
        token_name=balance.token_name,
        quota=balance.quota,
        used_quota=balance.used_quota,
        token_remain_quota=balance.token_remain_quota,
        token_used_quota=balance.token_used_quota,
        quota_per_usd=balance.quota_per_usd,
        balance_usd=balance.balance_usd,
        token_balance_usd=balance.token_balance_usd,
    )


@router.get("/api-token/balance", response_model=CloudAgentApiTokenBalanceOut)
async def get_cloud_agent_api_token_balance(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: NewApiService = Depends(get_new_api_service),
) -> CloudAgentApiTokenBalanceOut:
    try:
        balance = await service.get_balance(db, user_id=ctx.user_id)
        await db.commit()
    except NewApiError as exc:
        raise HTTPException(
            status_code=503 if exc.code == "new_api_not_configured" else 502,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return _api_token_balance_out(balance)


@router.post("/api-token/recharge", response_model=CloudAgentApiTokenBalanceOut)
async def recharge_cloud_agent_api_token(
    body: CloudAgentApiTokenRechargeRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: NewApiService = Depends(get_new_api_service),
) -> CloudAgentApiTokenBalanceOut:
    try:
        balance = await service.top_up(
            db,
            user_id=ctx.user_id,
            amount_usd=body.amount_usd,
        )
        await db.commit()
    except NewApiError as exc:
        raise HTTPException(
            status_code=503 if exc.code == "new_api_not_configured" else 502,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return _api_token_balance_out(balance)


@router.get("/{agent_id}", response_model=CloudAgentOut)
async def get_cloud_agent(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentOut:
    try:
        view = await service.get_cloud_agent(db, user_id=ctx.user_id, agent_id=agent_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentOut.from_view(view)


@router.post("/{agent_id}/pause", response_model=CloudAgentOut)
async def pause_cloud_agent(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentOut:
    try:
        view = await service.pause_cloud_agent(db, user_id=ctx.user_id, agent_id=agent_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentOut.from_view(view)


@router.post("/{agent_id}/resume", response_model=CloudAgentOut)
async def resume_cloud_agent(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentOut:
    try:
        view = await service.resume_cloud_agent(db, user_id=ctx.user_id, agent_id=agent_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentOut.from_view(view)


@router.delete("/{agent_id}", response_model=CloudAgentOut)
async def delete_cloud_agent(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentOut:
    try:
        view = await service.delete_cloud_agent(db, user_id=ctx.user_id, agent_id=agent_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentOut.from_view(view)


@router.post("/{agent_id}/runs", status_code=201, response_model=CloudAgentRunOut)
async def create_cloud_agent_run(
    agent_id: str,
    body: CreateRunRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentRunOut:
    budget = (
        RunBudget(
            max_wall_time_seconds=body.budget.max_wall_time_seconds,
            max_tool_calls=body.budget.max_tool_calls,
        )
        if body.budget is not None
        else None
    )
    try:
        view = await service.create_run(
            db,
            user_id=ctx.user_id,
            agent_id=agent_id,
            body=CreateRunInput(
                prompt=body.prompt,
                room_id=body.room_id,
                topic=body.topic,
                budget=budget,
            ),
        )
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentRunOut.from_view(view)


@router.get("/{agent_id}/usage", response_model=CloudAgentUsageOut)
async def get_cloud_agent_usage(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
) -> CloudAgentUsageOut:
    try:
        view = await service.get_usage(db, user_id=ctx.user_id, agent_id=agent_id)
    except CloudAgentError as exc:
        raise _handle_service_error(exc) from exc
    return CloudAgentUsageOut.from_view(view)

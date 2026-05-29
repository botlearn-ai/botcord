"""Authenticated app API for MVP team orchestration."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    MANAGEMENT_SCOPE_RUNTIME_SKILLS_INSTALL,
    MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
    RequestContext,
    require_agent_management_scopes,
    release_agent_management_scope_uses,
    reserve_agent_management_scope_uses,
    require_user,
    require_user_or_agent_management,
)
from app.routers.cloud_agents import CloudAgentOut, RunBudgetIn, RunBudgetOut
from app.routers.cloud_agents import get_cloud_agent_service
from app.routers.runtime_skills import (
    AgentRuntimeSkillInstallIn,
    install_agent_runtime_skill_for_agent,
)
from hub.database import get_db
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
    CloudAgentView,
    RunBudget,
)
from hub.services.team_orchestration import (
    TeamOrchestrationService,
    TeamPlan,
    TeamProvisionResult,
    TeamRolePlan,
)


router = APIRouter(prefix="/api/team-orchestration", tags=["app-team-orchestration"])


class TeamRoleIn(BaseModel):
    key: str | None = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    brief: str = Field(min_length=1, max_length=2048)
    runtime: str | None = Field(default=None, max_length=64)
    runtime_model: str | None = Field(default=None, max_length=128)
    reasoning_effort: str | None = Field(default=None, max_length=64)
    thinking: bool | None = None
    skills: list[AgentRuntimeSkillInstallIn] | None = Field(default=None, max_length=5)


class TeamPlanRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=4096)
    roles: list[TeamRoleIn] | None = Field(default=None, max_length=5)
    role_count: int | None = Field(default=None, ge=1, le=5)


class TeamProvisionRequest(TeamPlanRequest):
    room_name: str | None = Field(default=None, max_length=128)
    start_runs: bool = True
    budget: RunBudgetIn | None = None


class TeamRoleOut(BaseModel):
    key: str
    name: str
    brief: str
    runtime: str | None = None
    runtime_model: str | None = None
    reasoning_effort: str | None = None
    thinking: bool | None = None
    skills: list[AgentRuntimeSkillInstallIn] | None = None


class TeamPlanOut(BaseModel):
    goal: str
    roles: list[TeamRoleOut]
    kickoff_prompt: str


class TeamRoomOut(BaseModel):
    room_id: str
    name: str
    owner_id: str
    owner_type: str
    member_count: int


class TeamTopicOut(BaseModel):
    topic_id: str
    room_id: str
    title: str
    goal: str | None


class TeamRoleProvisionOut(BaseModel):
    role: TeamRoleOut
    cloud_agent: CloudAgentOut
    run_id: str | None = None
    run_status: str | None = None
    run_error: str | None = Field(
        default=None,
        description=(
            "Best-effort kickoff run error code. Team, room, topic, and agents "
            "remain provisioned when this is set."
        ),
    )
    budget: RunBudgetOut | None = None


class TeamProvisionOut(BaseModel):
    plan: TeamPlanOut
    room: TeamRoomOut
    topic: TeamTopicOut
    roles: list[TeamRoleProvisionOut]


def _service(cloud_agent_service: CloudAgentService) -> TeamOrchestrationService:
    return TeamOrchestrationService(cloud_agent_service=cloud_agent_service)


def _role_from_in(role: TeamRoleIn) -> TeamRolePlan:
    return TeamRolePlan(
        key=role.key or role.name,
        name=role.name,
        brief=role.brief,
        runtime=role.runtime,
        runtime_model=role.runtime_model,
        reasoning_effort=role.reasoning_effort,
        thinking=role.thinking,
        skills=[skill.model_dump(exclude_none=True) for skill in role.skills]
        if role.skills
        else None,
    )


def _roles_from_in(roles: list[TeamRoleIn] | None) -> list[TeamRolePlan] | None:
    if roles is None:
        return None
    return [_role_from_in(role) for role in roles]


def _plan_out(plan: TeamPlan) -> TeamPlanOut:
    return TeamPlanOut(
        goal=plan.goal,
        roles=[
            TeamRoleOut(
                key=role.key,
                name=role.name,
                brief=role.brief,
                runtime=role.runtime,
                runtime_model=role.runtime_model,
                reasoning_effort=role.reasoning_effort,
                thinking=role.thinking,
                skills=[
                    AgentRuntimeSkillInstallIn.model_validate(skill)
                    for skill in role.skills
                ]
                if role.skills
                else None,
            )
            for role in plan.roles
        ],
        kickoff_prompt=plan.kickoff_prompt,
    )


def _provision_out(result: TeamProvisionResult) -> TeamProvisionOut:
    role_outputs: list[TeamRoleProvisionOut] = []
    for item in result.roles:
        budget = None
        if item.run is not None:
            budget = RunBudgetOut(
                max_wall_time_seconds=item.run.budget.max_wall_time_seconds,
                max_tool_calls=item.run.budget.max_tool_calls,
            )
        role_outputs.append(
            TeamRoleProvisionOut(
                role=TeamRoleOut(
                    key=item.role.key,
                    name=item.role.name,
                    brief=item.role.brief,
                    runtime=item.role.runtime,
                    runtime_model=item.role.runtime_model,
                    reasoning_effort=item.role.reasoning_effort,
                    thinking=item.role.thinking,
                    skills=[
                        AgentRuntimeSkillInstallIn.model_validate(skill)
                        for skill in item.role.skills
                    ]
                    if item.role.skills
                    else None,
                ),
                cloud_agent=CloudAgentOut.from_view(item.cloud_agent),
                run_id=item.run.run_id if item.run else None,
                run_status=item.run.status if item.run else None,
                run_error=item.run_error,
                budget=budget,
            )
        )

    return TeamProvisionOut(
        plan=_plan_out(result.plan),
        room=TeamRoomOut(
            room_id=result.room.room_id,
            name=result.room.name,
            owner_id=result.room.owner_id,
            owner_type=(
                result.room.owner_type.value
                if hasattr(result.room.owner_type, "value")
                else str(result.room.owner_type)
            ),
            member_count=len(result.roles) + 1,
        ),
        topic=TeamTopicOut(
            topic_id=result.topic.topic_id,
            room_id=result.topic.room_id,
            title=result.topic.title,
            goal=result.topic.goal,
        ),
        roles=role_outputs,
    )


@router.post("/plan", response_model=TeamPlanOut)
async def plan_team(
    body: TeamPlanRequest,
    ctx: RequestContext = Depends(require_user),
    cloud_agent_service: CloudAgentService = Depends(get_cloud_agent_service),
) -> TeamPlanOut:
    del ctx
    service = _service(cloud_agent_service)
    return _plan_out(
        service.build_plan(
            goal=body.goal,
            roles=_roles_from_in(body.roles),
            role_count=body.role_count,
        )
    )


@router.post("/provision", response_model=TeamProvisionOut, status_code=201)
async def provision_team(
    body: TeamProvisionRequest,
    ctx: RequestContext = Depends(
        require_user_or_agent_management([MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION])
    ),
    db: AsyncSession = Depends(get_db),
    cloud_agent_service: CloudAgentService = Depends(get_cloud_agent_service),
) -> TeamProvisionOut:
    service = _service(cloud_agent_service)
    roles = _roles_from_in(body.roles)
    plan = service.build_plan(goal=body.goal, roles=roles, role_count=body.role_count)
    has_role_skills = any(role.skills for role in plan.roles)
    required_scopes = [MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION]
    if has_role_skills:
        required_scopes.append(MANAGEMENT_SCOPE_RUNTIME_SKILLS_INSTALL)
        await require_agent_management_scopes(
            db,
            ctx=ctx,
            required_scopes=[MANAGEMENT_SCOPE_RUNTIME_SKILLS_INSTALL],
        )

    reserved_grants = await reserve_agent_management_scope_uses(
        db,
        ctx=ctx,
        scopes=required_scopes,
    )

    try:
        team_grant = reserved_grants.get(MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION)
        if team_grant is not None:
            limits = team_grant.limits_json or {}
            max_role_count = limits.get("max_role_count")
            requested_role_count = len(plan.roles)
            if (
                isinstance(max_role_count, int)
                and requested_role_count > max_role_count
            ):
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "management_limit_exceeded",
                        "scope": MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
                        "limit": "max_role_count",
                        "max_role_count": max_role_count,
                    },
                )
            if limits.get("allow_start_runs") is False and body.start_runs:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "management_limit_exceeded",
                        "scope": MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
                        "limit": "allow_start_runs",
                    },
                )

        async def _install_role_skills(
            role: TeamRolePlan,
            cloud_agent: CloudAgentView,
        ) -> None:
            for skill in role.skills or []:
                await install_agent_runtime_skill_for_agent(
                    agent_id=cloud_agent.agent_id,
                    body=AgentRuntimeSkillInstallIn.model_validate(skill),
                    ctx=ctx,
                    db=db,
                )

        result = await service.provision_team(
            db,
            user_id=ctx.user_id,
            goal=plan.goal,
            roles=plan.roles,
            role_count=None,
            room_name=body.room_name,
            start_runs=body.start_runs,
            run_budget=RunBudget(
                max_wall_time_seconds=body.budget.max_wall_time_seconds,
                max_tool_calls=body.budget.max_tool_calls,
            )
            if body.budget
            else None,
            role_skill_installer=_install_role_skills,
        )
        await db.commit()
    except HTTPException:
        await release_agent_management_scope_uses(db, reserved_grants)
        raise
    except CloudAgentError as exc:
        await release_agent_management_scope_uses(db, reserved_grants)
        raise HTTPException(
            status_code=exc.http_status,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except Exception:
        await release_agent_management_scope_uses(db, reserved_grants)
        raise
    return _provision_out(result)

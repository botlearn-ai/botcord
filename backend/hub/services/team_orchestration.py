"""MVP service for planning and provisioning small Cloud Agent teams."""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import (
    ParticipantType,
    RoomJoinPolicy,
    RoomRole,
    RoomVisibility,
    TopicStatus,
)
from hub.id_generators import generate_human_id, generate_room_id, generate_topic_id
from hub.models import (
    Agent,
    CloudAgentInstance,
    MessageRecord,
    Room,
    RoomMember,
    Topic,
    User,
)
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentRunView,
    CloudAgentService,
    CloudAgentView,
    CreateCloudAgentInput,
    CreateRunInput,
    RunBudget,
)


_ROLE_KEY_RE = re.compile(r"[^a-z0-9]+")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TeamRolePlan:
    key: str
    name: str
    brief: str
    runtime: str | None = None
    runtime_model: str | None = None
    reasoning_effort: str | None = None
    thinking: bool | None = None
    skills: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class TeamPlan:
    goal: str
    roles: list[TeamRolePlan]
    kickoff_prompt: str


@dataclass(frozen=True)
class TeamProvisionRole:
    role: TeamRolePlan
    cloud_agent: CloudAgentView
    run: CloudAgentRunView | None
    run_error: str | None = None


@dataclass(frozen=True)
class TeamProvisionResult:
    plan: TeamPlan
    room: Room
    topic: Topic
    roles: list[TeamProvisionRole]


class TeamOrchestrationService:
    """Compose existing Cloud Agent, Room, and Topic primitives."""

    def __init__(self, cloud_agent_service: CloudAgentService | None = None) -> None:
        self._cloud_agents = cloud_agent_service or CloudAgentService()

    def build_plan(
        self,
        *,
        goal: str,
        roles: list[TeamRolePlan] | None = None,
        role_count: int | None = None,
    ) -> TeamPlan:
        cleaned_goal = _clean_goal(goal)
        planned_roles = _normalize_roles(roles, role_count=role_count)
        return TeamPlan(
            goal=cleaned_goal,
            roles=planned_roles,
            kickoff_prompt=_build_kickoff_prompt(cleaned_goal, planned_roles),
        )

    async def provision_team(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        goal: str,
        roles: list[TeamRolePlan] | None = None,
        role_count: int | None = None,
        room_name: str | None = None,
        start_runs: bool = True,
        run_budget: RunBudget | None = None,
        role_skill_installer: Callable[[TeamRolePlan, CloudAgentView], Awaitable[None]]
        | None = None,
    ) -> TeamProvisionResult:
        plan = self.build_plan(goal=goal, roles=roles, role_count=role_count)
        user = await _load_user_with_human_id(db, user_id)

        created_agents: list[CloudAgentView] = []
        provision_id = f"team_{uuid.uuid4().hex}"
        room_id: str | None = None
        topic_id: str | None = None
        try:
            for role in plan.roles:
                created_agents.append(
                    await self._cloud_agents.create_cloud_agent(
                        db,
                        user_id=user_id,
                        body=CreateCloudAgentInput(
                            name=role.name,
                            bio=role.brief,
                            runtime=role.runtime,
                            runtime_model=role.runtime_model,
                            reasoning_effort=role.reasoning_effort,
                            thinking=role.thinking,
                            provisioning_context={
                                "kind": "team_orchestration",
                                "provision_id": provision_id,
                                "role_key": role.key,
                            },
                        ),
                    )
                )

            if role_skill_installer is not None:
                for role, cloud_agent in zip(plan.roles, created_agents, strict=True):
                    await role_skill_installer(role, cloud_agent)

            room = await _create_team_room(
                db,
                user=user,
                name=_clean_room_name(room_name, plan.goal),
                goal=plan.goal,
                agent_ids=[agent.agent_id for agent in created_agents],
            )
            room_id = room.room_id
            topic = await _create_team_topic(
                db,
                room_id=room.room_id,
                creator_id=created_agents[0].agent_id,
                goal=plan.goal,
            )
            topic_id = topic.topic_id

            provisioned_roles: list[TeamProvisionRole] = []
            for role, cloud_agent in zip(plan.roles, created_agents, strict=True):
                run: CloudAgentRunView | None = None
                run_error: str | None = None
                if start_runs:
                    try:
                        run = await self._cloud_agents.create_run(
                            db,
                            user_id=user_id,
                            agent_id=cloud_agent.agent_id,
                            body=CreateRunInput(
                                prompt=_build_role_kickoff_prompt(plan.goal, role),
                                room_id=room.room_id,
                                topic=topic.title,
                                budget=run_budget,
                            ),
                        )
                    except CloudAgentError as exc:
                        # Team creation is the durable unit for the MVP.
                        # Kickoff runs are best-effort and callers get a
                        # per-role run_error they can surface or retry from.
                        run_error = exc.code
                provisioned_roles.append(
                    TeamProvisionRole(
                        role=role,
                        cloud_agent=cloud_agent,
                        run=run,
                        run_error=run_error,
                    )
                )

            return TeamProvisionResult(
                plan=plan,
                room=room,
                topic=topic,
                roles=provisioned_roles,
            )
        except Exception:
            await _compensate_failed_provision(
                db,
                cloud_agents=self._cloud_agents,
                user_id=user_id,
                created_agents=created_agents,
                provision_id=provision_id,
                room_id=room_id,
                topic_id=topic_id,
            )
            raise


async def _compensate_failed_provision(
    db: AsyncSession,
    *,
    cloud_agents: CloudAgentService,
    user_id: uuid.UUID,
    created_agents: list[CloudAgentView],
    provision_id: str,
    room_id: str | None,
    topic_id: str | None,
) -> None:
    try:
        await db.rollback()
    except Exception as exc:  # noqa: BLE001
        logger.warning("team provision rollback failed before cleanup: err=%s", exc)

    if room_id is not None:
        try:
            await db.execute(
                delete(MessageRecord).where(MessageRecord.room_id == room_id)
            )
            if topic_id is not None:
                await db.execute(delete(Topic).where(Topic.topic_id == topic_id))
            await db.execute(delete(RoomMember).where(RoomMember.room_id == room_id))
            await db.execute(delete(Topic).where(Topic.room_id == room_id))
            await db.execute(delete(Room).where(Room.room_id == room_id))
            await db.commit()
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            logger.warning(
                "team provision room cleanup failed: room=%s topic=%s err=%s",
                room_id,
                topic_id,
                exc,
            )
    elif created_agents:
        created_agent_ids = [agent.agent_id for agent in created_agents]
        leaked_room_ids = (
            await db.execute(
                select(RoomMember.room_id).where(
                    RoomMember.agent_id.in_(created_agent_ids),
                    RoomMember.participant_type == ParticipantType.agent,
                )
            )
        ).scalars().all()
        for leaked_room_id in set(leaked_room_ids):
            try:
                await db.execute(
                    delete(MessageRecord).where(MessageRecord.room_id == leaked_room_id)
                )
                await db.execute(
                    delete(RoomMember).where(RoomMember.room_id == leaked_room_id)
                )
                await db.execute(delete(Topic).where(Topic.room_id == leaked_room_id))
                await db.execute(delete(Room).where(Room.room_id == leaked_room_id))
                await db.commit()
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                logger.warning(
                    "team provision leaked room cleanup failed: room=%s err=%s",
                    leaked_room_id,
                    exc,
                )

    cleanup_agent_ids = list(dict.fromkeys(agent.agent_id for agent in created_agents))
    marked_agent_ids = await _find_marked_team_provision_agent_ids(
        db,
        user_id=user_id,
        provision_id=provision_id,
    )
    cleanup_agent_ids.extend(
        agent_id for agent_id in marked_agent_ids if agent_id not in cleanup_agent_ids
    )

    for agent_id in reversed(cleanup_agent_ids):
        try:
            await cloud_agents.delete_cloud_agent(
                db,
                user_id=user_id,
                agent_id=agent_id,
            )
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            logger.warning(
                "team provision cloud agent cleanup failed: agent=%s err=%s",
                agent_id,
                exc,
            )


async def _find_marked_team_provision_agent_ids(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    provision_id: str,
) -> list[str]:
    rows = (
        await db.execute(
            select(CloudAgentInstance.agent_id, CloudAgentInstance.metadata_json).where(
                CloudAgentInstance.user_id == user_id,
                CloudAgentInstance.status != "deleted",
            )
        )
    ).all()
    agent_ids: list[str] = []
    for agent_id, metadata in rows:
        context = (metadata or {}).get("provisioning_context")
        if not isinstance(context, dict):
            continue
        if (
            context.get("kind") == "team_orchestration"
            and context.get("provision_id") == provision_id
        ):
            agent_ids.append(agent_id)
    return agent_ids


def _clean_goal(goal: str) -> str:
    cleaned = (goal or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="goal is required")
    return cleaned


def _normalize_roles(
    roles: list[TeamRolePlan] | None,
    *,
    role_count: int | None,
) -> list[TeamRolePlan]:
    if roles:
        normalized = [
            TeamRolePlan(
                key=_role_key(role.key or role.name),
                name=role.name.strip(),
                brief=role.brief.strip(),
                runtime=role.runtime,
                runtime_model=role.runtime_model,
                reasoning_effort=role.reasoning_effort,
                thinking=role.thinking,
                skills=role.skills,
            )
            for role in roles
            if role.name.strip() and role.brief.strip()
        ]
    else:
        normalized = list(_default_roles())

    if role_count is not None:
        normalized = normalized[:role_count]

    if not normalized:
        raise HTTPException(status_code=400, detail="at least one role is required")
    if len(normalized) > 5:
        raise HTTPException(status_code=400, detail="at most five roles are supported")

    seen: set[str] = set()
    unique: list[TeamRolePlan] = []
    for role in normalized:
        key = role.key
        if key in seen:
            suffix = 2
            while f"{key}-{suffix}" in seen:
                suffix += 1
            key = f"{key}-{suffix}"
            role = TeamRolePlan(
                key=key,
                name=role.name,
                brief=role.brief,
                runtime=role.runtime,
                runtime_model=role.runtime_model,
                reasoning_effort=role.reasoning_effort,
                thinking=role.thinking,
                skills=role.skills,
            )
        seen.add(key)
        unique.append(role)
    return unique


def _default_roles() -> tuple[TeamRolePlan, ...]:
    return (
        TeamRolePlan(
            key="planner",
            name="Team Planner",
            brief="Breaks the goal into milestones, dependencies, and acceptance checks.",
        ),
        TeamRolePlan(
            key="builder",
            name="Implementation Lead",
            brief="Executes the main implementation work and reports concrete progress.",
        ),
        TeamRolePlan(
            key="reviewer",
            name="Quality Reviewer",
            brief="Reviews outputs for correctness, gaps, and follow-up work.",
        ),
    )


def _role_key(value: str) -> str:
    key = _ROLE_KEY_RE.sub("-", value.strip().lower()).strip("-")
    return key or "role"


def _build_kickoff_prompt(goal: str, roles: list[TeamRolePlan]) -> str:
    role_lines = "\n".join(f"- {role.name}: {role.brief}" for role in roles)
    return (
        f"Goal: {goal}\n\n"
        f"Team roles:\n{role_lines}\n\n"
        "Coordinate in this room and keep updates concise."
    )


def _build_role_kickoff_prompt(goal: str, role: TeamRolePlan) -> str:
    return (
        f"Team goal: {goal}\n\n"
        f"Your role: {role.name}\n"
        f"Role brief: {role.brief}\n\n"
        "Start by posting your initial plan, assumptions, and first concrete action."
    )


def _clean_room_name(room_name: str | None, goal: str) -> str:
    name = (room_name or "").strip()
    if not name:
        name = f"Team: {goal[:80]}"
    return name[:128]


async def _load_user_with_human_id(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.human_id:
        user.human_id = generate_human_id()
        await db.flush()
    return user


async def _create_team_room(
    db: AsyncSession,
    *,
    user: User,
    name: str,
    goal: str,
    agent_ids: list[str],
) -> Room:
    room = Room(
        room_id=generate_room_id(),
        name=name,
        description=goal,
        rule=(
            "Coordinate on the stated goal. Keep messages task-focused and "
            "explicit about blockers."
        ),
        owner_id=user.human_id,
        owner_type=ParticipantType.human,
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
        default_send=True,
        default_invite=False,
        max_members=len(agent_ids) + 1,
    )
    db.add(room)
    await db.flush()
    db.add(
        RoomMember(
            room_id=room.room_id,
            agent_id=user.human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.owner,
        )
    )
    for agent_id in agent_ids:
        exists = await db.scalar(select(Agent.agent_id).where(Agent.agent_id == agent_id))
        if exists is None:
            raise HTTPException(status_code=400, detail=f"agent {agent_id} not found")
        db.add(
            RoomMember(
                room_id=room.room_id,
                agent_id=agent_id,
                participant_type=ParticipantType.agent,
                role=RoomRole.member,
            )
        )
    await db.commit()
    await db.refresh(room)
    return room


async def _create_team_topic(
    db: AsyncSession,
    *,
    room_id: str,
    creator_id: str,
    goal: str,
) -> Topic:
    topic = Topic(
        topic_id=generate_topic_id(),
        room_id=room_id,
        title="Team kickoff",
        description=goal,
        status=TopicStatus.open,
        creator_id=creator_id,
        goal=goal,
    )
    db.add(topic)
    await db.commit()
    await db.refresh(topic)
    return topic

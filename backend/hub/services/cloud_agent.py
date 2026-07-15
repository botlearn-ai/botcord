"""CloudAgentService — orchestrates Cloud Agent lifecycle.

PR 3 scope: API skeleton + fake provider. The service creates rows for the
Agent, the underlying cloud daemon (``daemon_instances`` + ``cloud_daemon_instances``),
the binding row (``cloud_agent_instances``), and invokes a
:class:`CloudDaemonProvider` to spin up (or resume) the sandbox.

The actual ``provision_agent`` control-frame dispatch over
``/cloud/daemon/ws`` lands in PR 5. For now the service marks the agent
``ready`` as soon as the provider reports the sandbox is ready, so we can
exercise the lifecycle end-to-end with the fake provider.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import logging
import secrets
import time
import uuid
from dataclasses import dataclass
import copy
from typing import Any

import sentry_sdk
from nacl.signing import SigningKey as NaClSigningKey
from sqlalchemy import and_, func, or_, select, text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy.orm.attributes import flag_modified

from hub.agent_avatars import random_agent_avatar_url
from hub.auth import create_agent_token
from hub.config import (
    CLOUD_AGENT_DEFAULT_MAX_AGENTS_PER_DAEMON,
    CLOUD_AGENT_DEFAULT_MODEL_PROFILE,
    CLOUD_AGENT_DEFAULT_PROVIDER,
    CLOUD_AGENT_DEFAULT_RUNTIME,
    CLOUD_AGENT_FEATURE_ENABLED,
    CLOUD_AGENT_MAX_PER_USER,
    CLOUD_AGENT_OWNER_CHAT_RUN_LEASE_SECONDS,
    HUB_PUBLIC_BASE_URL,
)
from hub.enums import KeyState, MessageState
from hub.id_generators import (
    generate_agent_id,
    generate_cloud_agent_instance_id,
    generate_cloud_agent_run_id,
    generate_cloud_daemon_instance_id,
    generate_daemon_instance_id,
    generate_hub_msg_id,
    generate_key_id,
)
from hub.models import (
    Agent,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
    MessageRecord,
    SigningKey,
    UsageEvent,
    UsageReservation,
)
from hub.routers.cloud_daemon_control import (
    CloudDaemonDispatchError,
    disconnect_cloud_daemon_control,
    is_cloud_daemon_online,
    send_cloud_control_frame,
)
from hub.services.cloud_agent_usage import UsageError, UsageService
from hub.services.cloud_daemon_provider import (
    CloudDaemonHandle,
    CloudDaemonProvider,
    get_provider,
)
from hub.services.wallet import get_or_create_wallet
from hub.services.new_api import NewApiError, NewApiService

logger = logging.getLogger(__name__)

_OWNER_CHAT_CLOUD_AGENT_RETRY_MESSAGE = (
    "Cloud agent is temporarily unavailable. Please retry in a moment."
)


class CloudAgentError(Exception):
    """Raised by :class:`CloudAgentService` for callable-level errors.

    The API layer maps :attr:`code` to an HTTP status. Service code never
    raises ``HTTPException`` directly so the service stays usable from
    background tasks and tests.
    """

    def __init__(self, code: str, message: str, *, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _agent_token_expires_at_seconds(
    expires_at: datetime.datetime | None,
) -> int | None:
    if expires_at is None:
        return None
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    return int(expires_at.timestamp())


@dataclass
class CreateCloudAgentInput:
    name: str
    bio: str | None = None
    model_profile: str | None = None
    runtime: str | None = None
    runtime_model: str | None = None
    reasoning_effort: str | None = None
    thinking: bool | None = None
    provisioning_context: dict[str, Any] | None = None


@dataclass
class CloudAgentView:
    """Read-model returned from service methods. Mirrors the API DTO."""

    cloud_agent_instance_id: str
    agent_id: str
    name: str
    bio: str | None
    avatar_url: str | None
    user_id: uuid.UUID
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


@dataclass
class RunBudget:
    """Per-run wall-time + tool-call caps. Daemon enforces; Hub records."""

    max_wall_time_seconds: int = 600
    max_tool_calls: int = 30


@dataclass
class CreateRunInput:
    prompt: str
    room_id: str | None = None
    topic: str | None = None
    budget: RunBudget | None = None


@dataclass
class CloudAgentRunView:
    run_id: str
    agent_id: str
    hub_msg_id: str
    room_id: str
    status: str
    budget: RunBudget


@dataclass
class CloudAgentRunStatusView:
    """Best-effort run state derived from the usage ledger.

    There is no dedicated run-state table (see PR 9 decision); status is
    inferred from the per-run :class:`UsageReservation` and any settled
    :class:`UsageEvent`. ``status`` is one of ``running`` / ``completed`` /
    ``cancelled`` / ``unknown``.
    """

    run_id: str
    agent_id: str
    status: str
    reserved_credits: int
    reserved_sandbox_seconds: int
    credits_charged: int | None
    created_at: datetime.datetime
    settled_at: datetime.datetime | None = None


@dataclass
class CloudAgentUsageEventView:
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


@dataclass
class CloudAgentUsageView:
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
    events: list[CloudAgentUsageEventView]


# Cap on the prompt so a misuse doesn't fill the column / blow the
# envelope wire size. Generous default — model context is the real cap.
_RUN_PROMPT_MAX_CHARS = 64 * 1024
_ACTIVE_CLOUD_DAEMON_STATUSES = ("creating", "starting", "ready", "paused")
_RESUME_START_COALESCE_SECONDS = 30
_CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY = "pending_launch_token"
_CLOUD_DAEMON_CURRENT_LAUNCH_TOKEN_KEY = "current_launch_token"
_PROVISIONING_LAUNCH_TOKEN_KEY = "cloud_daemon_launch_token"
_VERIFIED_PENDING_LAUNCH_LIST_FAILURES = {
    "cloud_daemon_ack_timeout",
    "cloud_daemon_list_agents_rejected",
}


@dataclass(frozen=True)
class _CloudDaemonAgentListProbe:
    agent_ids: set[str] | None
    failure_code: str | None = None


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _as_aware_utc(value: datetime.datetime | None) -> datetime.datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value.astimezone(datetime.timezone.utc)


def _cloud_agent_last_activity_at(
    cai: CloudAgentInstance, cdi: CloudDaemonInstance
) -> datetime.datetime:
    # NB: deliberately exclude ``cai.updated_at`` — the SQLAlchemy
    # ``onupdate`` hook flips it for unrelated status writes (provisioning
    # → ready → paused), so the sweep saw every cloud agent as active. The
    # explicit, event-driven signal lives on ``cai.last_active_at`` (owned
    # by hub.services.cloud_agent_activity).
    candidates = [
        _as_aware_utc(cai.last_run_at),
        _as_aware_utc(cai.last_active_at),
        _as_aware_utc(cai.created_at),
        _as_aware_utc(cdi.last_started_at),
        _as_aware_utc(cdi.created_at),
    ]
    return max(ts for ts in candidates if ts is not None)


def _cloud_daemon_start_requested_at(
    cdi: CloudDaemonInstance,
) -> datetime.datetime | None:
    return _as_aware_utc(cdi.last_started_at) or _as_aware_utc(cdi.created_at)


def _is_recent_inflight_start(
    cdi: CloudDaemonInstance,
    *,
    now: datetime.datetime,
) -> bool:
    if cdi.status != "starting" or not cdi.provider_sandbox_id:
        return False
    started_at = _cloud_daemon_start_requested_at(cdi)
    if started_at is None:
        return False
    return (
        now - started_at
        <= datetime.timedelta(seconds=_RESUME_START_COALESCE_SECONDS)
    )


def _placeholder_refresh_hash() -> str:
    """Generate the dummy hash stored on the cloud daemon's daemon_instances row.

    Cloud daemons don't run the device-code refresh-token flow; the access
    token is issued by the Hub on each sandbox start. We still need to
    populate the NOT NULL column on ``daemon_instances``, so a random hash
    fills the column without exposing a real secret.
    """
    return hashlib.sha256(secrets.token_bytes(32)).hexdigest()


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class CloudAgentService:
    """Lifecycle orchestrator for Cloud Agents."""

    def __init__(
        self,
        *,
        provider: CloudDaemonProvider | None = None,
        provider_name: str | None = None,
        feature_enabled: bool | None = None,
        max_per_user: int | None = None,
        max_agents_per_daemon: int | None = None,
        usage_service: UsageService | None = None,
        new_api_service: NewApiService | None = None,
    ) -> None:
        self._provider_name = provider_name or CLOUD_AGENT_DEFAULT_PROVIDER
        self._provider = provider  # may be None; resolved lazily
        self._feature_enabled = (
            CLOUD_AGENT_FEATURE_ENABLED if feature_enabled is None else feature_enabled
        )
        self._max_per_user = (
            CLOUD_AGENT_MAX_PER_USER if max_per_user is None else max_per_user
        )
        self._max_agents_per_daemon = (
            CLOUD_AGENT_DEFAULT_MAX_AGENTS_PER_DAEMON
            if max_agents_per_daemon is None
            else max_agents_per_daemon
        )
        self._usage = usage_service or UsageService()
        self._new_api = new_api_service or NewApiService()

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    async def create_cloud_agent(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        body: CreateCloudAgentInput,
    ) -> CloudAgentView:
        self._require_feature_enabled()
        name = (body.name or "").strip()
        if not name:
            raise CloudAgentError("invalid_name", "name is required", http_status=400)
        runtime = (body.runtime or CLOUD_AGENT_DEFAULT_RUNTIME).strip()
        runtime_model = _clean_runtime_option(body.runtime_model)
        reasoning_effort = _clean_runtime_option(body.reasoning_effort)
        model_profile = (
            body.model_profile or runtime_model or CLOUD_AGENT_DEFAULT_MODEL_PROFILE
        ).strip()

        await self._enforce_per_user_quota(db, user_id)

        # Find an existing cloud daemon with free capacity, or provision a
        # fresh one. The schema supports >=1 Cloud Agent per cloud daemon
        # so this is the slot-allocation knob.
        cloud_daemon, daemon_row = await self._allocate_or_create_cloud_daemon(
            db,
            user_id=user_id,
            runtime=runtime,
        )
        if not _daemon_snapshot_accepts_runtime_options(
            daemon_row,
            runtime=runtime,
            runtime_model=runtime_model,
            reasoning_effort=reasoning_effort,
            thinking=body.thinking,
        ):
            raise CloudAgentError(
                "runtime_unavailable",
                "selected runtime, model, or reasoning effort is unavailable",
                http_status=409,
            )

        provider = self._get_provider()

        # Create Agent + SigningKey + cloud_agent_instances row in one tx.
        signing_key = NaClSigningKey.generate()
        pubkey_b64 = base64.b64encode(bytes(signing_key.verify_key)).decode("ascii")
        private_key_b64 = base64.b64encode(bytes(signing_key)).decode("ascii")
        agent_id = generate_agent_id(pubkey_b64)

        existing = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
        if existing is not None:
            # 2^-128 collision; treat as data corruption.
            raise CloudAgentError(
                "agent_id_collision",
                "generated agent_id already exists",
                http_status=500,
            )

        now = _now()
        agent = Agent(
            agent_id=agent_id,
            display_name=name,
            bio=body.bio,
            avatar_url=random_agent_avatar_url(),
            user_id=user_id,
            hosting_kind="cloud",
            runtime=runtime,
            daemon_instance_id=daemon_row.id,
            claimed_at=now,
        )
        db.add(agent)
        key_id = generate_key_id()
        db.add(
            SigningKey(
                agent_id=agent_id,
                key_id=key_id,
                pubkey=f"ed25519:{pubkey_b64}",
                state=KeyState.active,
            )
        )
        await db.flush()

        agent_token, token_expires_at = create_agent_token(agent_id)
        agent.agent_token = agent_token
        agent.token_expires_at = datetime.datetime.fromtimestamp(
            token_expires_at, tz=datetime.timezone.utc
        )
        await get_or_create_wallet(db, agent_id)

        # Stash the freshly-generated private key + key_id in metadata so
        # the WS hello hook (PR 5) can build the ``provision_agent`` frame
        # without re-deriving anything. The provision dispatcher scrubs
        # the private key after the daemon acks — see
        # :meth:`provision_pending_for_cloud_daemon`.
        cloud_agent = CloudAgentInstance(
            id=generate_cloud_agent_instance_id(),
            user_id=user_id,
            agent_id=agent_id,
            cloud_daemon_instance_id=cloud_daemon.id,
            daemon_instance_id=daemon_row.id,
            runtime=runtime,
            model_profile=model_profile,
            status="provisioning",
            metadata_json={
                **(
                    {"provisioning_context": body.provisioning_context}
                    if body.provisioning_context
                    else {}
                ),
                "provisioning": {
                    "private_key_b64": private_key_b64,
                    "public_key_b64": pubkey_b64,
                    "key_id": key_id,
                },
                **_runtime_options_metadata(
                    runtime_model=runtime_model,
                    reasoning_effort=reasoning_effort,
                    thinking=body.thinking,
                ),
            },
        )
        db.add(cloud_agent)
        cloud_daemon.active_agent_count = (cloud_daemon.active_agent_count or 0) + 1
        await db.flush()

        runtime_env = await self._runtime_env_for_user(db, user_id=user_id)

        if is_cloud_daemon_online(cloud_daemon.id):
            existing_agent_states = await db.execute(
                select(CloudAgentInstance).where(
                    CloudAgentInstance.cloud_daemon_instance_id == cloud_daemon.id,
                    CloudAgentInstance.id != cloud_agent.id,
                    CloudAgentInstance.status.notin_(("deleted", "deleting")),
                )
            )
            existing_agent_states = existing_agent_states.scalars().all()
            existing_agent_state_by_id = {
                cai.agent_id: _snapshot_cloud_agent_state(cai)
                for cai in existing_agent_states
            }
            original_daemon_state = _snapshot_cloud_daemon_state(cloud_daemon)
            launch_token = _begin_cloud_daemon_relaunch(
                cloud_daemon,
                provisioning_agents=[cloud_agent],
            )
            cloud_daemon.status = "starting"
            cloud_daemon.error_code = None
            cloud_daemon.error_message = None
            cloud_agent.status = "provisioning"
            await db.commit()

            try:
                handle = await provider.create_or_resume(
                    cloud_daemon_instance_id=cloud_daemon.id,
                    daemon_instance_id=daemon_row.id,
                    user_id=str(user_id),
                    runtime=cloud_daemon.runtime,
                    provider_sandbox_id=cloud_daemon.provider_sandbox_id,
                    extra_env=runtime_env,
                    launch_token=launch_token,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "cloud daemon provider failed for online relaunch: cloud=%s err=%s",
                    cloud_daemon.id,
                    exc,
                )
                _restore_cloud_daemon_state(cloud_daemon, original_daemon_state)
                for cai in existing_agent_states:
                    _restore_cloud_agent_state(
                        cai,
                        existing_agent_state_by_id[cai.agent_id],
                    )
                cloud_agent.status = "failed"
                cloud_agent.error_code = "provider_create_failed"
                cloud_agent.error_message = str(exc)
                _scrub_provisioning_metadata(cloud_agent)
                _clear_cloud_daemon_pending_launch(cloud_daemon)
                await db.commit()
                raise CloudAgentError(
                    "provider_create_failed",
                    f"cloud daemon provider failed: {exc}",
                    http_status=502,
                ) from exc

            _apply_handle_to_rows(cloud_daemon, handle)
            if handle.status == "starting":
                cloud_daemon.last_started_at = _now()
            elif handle.status == "failed":
                _restore_cloud_daemon_state(cloud_daemon, original_daemon_state)
                for cai in existing_agent_states:
                    _restore_cloud_agent_state(
                        cai,
                        existing_agent_state_by_id[cai.agent_id],
                    )
                cloud_agent.status = "failed"
                cloud_agent.error_code = handle.error_code
                cloud_agent.error_message = handle.error_message
                _scrub_provisioning_metadata(cloud_agent)
                _clear_cloud_daemon_pending_launch(cloud_daemon)
            elif handle.status == "ready":
                cloud_daemon.status = "starting"
            if handle.status in {"ready", "starting"}:
                _promote_cloud_daemon_pending_launch(
                    cloud_daemon,
                    launch_token=launch_token,
                )
            await db.commit()

            if handle.status == "failed":
                raise CloudAgentError(
                    handle.error_code or "provider_create_failed",
                    handle.error_message
                    or "cloud daemon provider reported failure",
                    http_status=502,
                )
            # ``ready`` or ``starting`` both mean the provider accepted a
            # relaunch. A stale websocket from the old process may still be
            # registered, so leave provisioning open until a control WS with
            # the matching launch token replays the pending agents.
            await db.refresh(cloud_agent)
            await db.refresh(cloud_daemon)
            await db.refresh(agent)
            return _make_view(agent, cloud_agent, cloud_daemon)

        # Hand off to the provider. The fake provider returns ready
        # synchronously; the E2B provider will return ``starting`` and
        # transition to ``ready`` once the daemon's hello frame lands.
        try:
            launch_token = _cloud_daemon_launch_token_for_start(cloud_daemon)
            handle = await provider.create_or_resume(
                cloud_daemon_instance_id=cloud_daemon.id,
                daemon_instance_id=daemon_row.id,
                user_id=str(user_id),
                runtime=cloud_daemon.runtime,
                provider_sandbox_id=cloud_daemon.provider_sandbox_id,
                extra_env=runtime_env,
                launch_token=launch_token,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "cloud daemon provider failed: cloud=%s err=%s",
                cloud_daemon.id,
                exc,
            )
            cloud_agent.status = "failed"
            cloud_agent.error_code = "provider_create_failed"
            cloud_agent.error_message = str(exc)
            cloud_daemon.status = "failed"
            cloud_daemon.error_code = "provider_create_failed"
            cloud_daemon.error_message = str(exc)
            await db.commit()
            raise CloudAgentError(
                "provider_create_failed",
                f"cloud daemon provider failed: {exc}",
                http_status=502,
            ) from exc

        _apply_handle_to_rows(cloud_daemon, handle)
        if handle.status == "starting":
            cloud_daemon.last_started_at = _now()
        if handle.status == "ready":
            # Fake-provider shortcut: the in-memory provider stands in for
            # the full sandbox+WS dance, so we mark ready immediately and
            # scrub the never-needed private key from metadata.
            cloud_agent.status = "ready"
            _scrub_provisioning_metadata(cloud_agent)
        elif handle.status == "failed":
            cloud_agent.status = "failed"
            cloud_agent.error_code = handle.error_code
            cloud_agent.error_message = handle.error_message
            _scrub_provisioning_metadata(cloud_agent)
        # else: stay in 'provisioning' until the daemon connects and
        # ``provision_pending_for_cloud_daemon`` finishes the handshake.
        await db.commit()

        if handle.status == "failed":
            # Surface the failure to the caller AFTER persisting state so
            # the caller can retry without leaving orphan rows. The API
            # layer maps this to 502.
            raise CloudAgentError(
                handle.error_code or "provider_create_failed",
                handle.error_message
                or "cloud daemon provider reported failure",
                http_status=502,
            )

        await db.refresh(cloud_agent)
        await db.refresh(cloud_daemon)
        await db.refresh(agent)

        return _make_view(agent, cloud_agent, cloud_daemon)

    async def list_cloud_agents(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
    ) -> list[CloudAgentView]:
        rows = (
            await db.execute(
                select(CloudAgentInstance, Agent, CloudDaemonInstance)
                .join(Agent, Agent.agent_id == CloudAgentInstance.agent_id)
                .join(
                    CloudDaemonInstance,
                    CloudDaemonInstance.id == CloudAgentInstance.cloud_daemon_instance_id,
                )
                .where(
                    CloudAgentInstance.user_id == user_id,
                    CloudAgentInstance.status != "deleted",
                )
                .order_by(CloudAgentInstance.created_at.desc())
            )
        ).all()
        return [_make_view(agent, cai, cdi) for cai, agent, cdi in rows]

    async def get_cloud_agent(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> CloudAgentView:
        cai, agent, cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        return _make_view(agent, cai, cdi)

    async def pause_cloud_agent(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> CloudAgentView:
        cai, agent, cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        if cai.status in {"deleted", "deleting"}:
            raise CloudAgentError(
                "invalid_state",
                f"cannot pause cloud agent in status {cai.status!r}",
                http_status=409,
            )
        if cai.status == "paused":
            return _make_view(agent, cai, cdi)

        provider = self._get_provider()
        cai.status = "paused"
        await db.flush()
        daemon_paused = False

        # Cloud daemon pause is a per-sandbox operation. Pause the sandbox
        # only once every non-deleted peer on it is also paused.
        remaining_running = await db.scalar(
            select(func.count())
            .select_from(CloudAgentInstance)
            .where(
                CloudAgentInstance.cloud_daemon_instance_id == cdi.id,
                CloudAgentInstance.status.in_(("provisioning", "ready")),
            )
        )
        if (remaining_running or 0) == 0:
            handle = await provider.pause(
                cloud_daemon_instance_id=cdi.id,
                provider_sandbox_id=cdi.provider_sandbox_id,
            )
            _apply_handle_to_rows(cdi, handle)
            cdi.last_paused_at = _now()
            daemon_paused = True
        await db.commit()
        if daemon_paused:
            await disconnect_cloud_daemon_control(
                cdi.id,
                reason="cloud daemon manually paused",
            )
        await db.refresh(cai)
        await db.refresh(cdi)
        return _make_view(agent, cai, cdi)

    async def pause_idle_cloud_daemons(
        self,
        db: AsyncSession,
        *,
        idle_seconds: float,
        now: datetime.datetime | None = None,
        limit: int = 100,
    ) -> int:
        """Pause ready cloud daemon sandboxes that have been idle long enough.

        This is intentionally conservative: a daemon is eligible only when all
        ready agents under it are idle and no cloud-run message or usage
        reservation suggests work is still pending.
        """
        if idle_seconds <= 0:
            return 0

        current = now or _now()
        cutoff = current - datetime.timedelta(seconds=idle_seconds)
        result = await db.execute(
            select(CloudDaemonInstance)
            .where(CloudDaemonInstance.status == "ready")
            .order_by(CloudDaemonInstance.updated_at.asc())
            .limit(limit)
        )
        candidates = list(result.scalars().all())
        paused = 0

        for cdi in candidates:
            cloud_daemon_instance_id = cdi.id
            provider_sandbox_id = cdi.provider_sandbox_id
            try:
                if await self._pause_cloud_daemon_if_idle(
                    db, cdi, cutoff=cutoff, now=current
                ):
                    paused += 1
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                logger.warning(
                    "idle pause failed: cloud=%s sandbox=%s err=%s",
                    cloud_daemon_instance_id,
                    provider_sandbox_id,
                    exc,
                )

        return paused

    async def resume_cloud_agent(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> CloudAgentView:
        await _lock_cloud_daemon_lifecycle(db, user_id)
        cai, agent, cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        if cai.status in {"deleted", "deleting"}:
            raise CloudAgentError(
                "invalid_state",
                f"cannot resume cloud agent in status {cai.status!r}",
                http_status=409,
            )
        daemon_online = is_cloud_daemon_online(cdi.id)
        if cdi.status == "ready" and daemon_online:
            if _cloud_daemon_pending_launch_token(cdi):
                return _make_view(agent, cai, cdi)
            handled = await self._ensure_agent_loaded_in_online_daemon(
                db, cai, agent, cdi
            )
            if handled:
                await db.refresh(cai)
                await db.refresh(cdi)
                await db.refresh(agent)
                return _make_view(agent, cai, cdi)
            if cai.status == "ready":
                return _make_view(agent, cai, cdi)

        provider = self._get_provider()
        if cdi.status != "ready" or not daemon_online:
            runtime_env = await self._runtime_env_for_user(db, user_id=user_id)
            await _ensure_no_other_active_cloud_daemon(
                db,
                user_id=user_id,
                cloud_daemon_instance_id=cdi.id,
            )
            if _is_recent_inflight_start(cdi, now=_now()):
                _ensure_provisioning_metadata(db, cai, agent)
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
                cdi.error_code = None
                cdi.error_message = None
                await db.commit()
                await db.refresh(cai)
                await db.refresh(cdi)
                await db.refresh(agent)
                return _make_view(agent, cai, cdi)
            _ensure_provisioning_metadata(db, cai, agent)
            cai.status = "provisioning"
            cai.error_code = None
            cai.error_message = None
            cdi.error_code = None
            cdi.error_message = None
            await db.commit()
            launch_token = _cloud_daemon_launch_token_for_start(cdi)
            handle = await provider.create_or_resume(
                cloud_daemon_instance_id=cdi.id,
                daemon_instance_id=cdi.daemon_instance_id,
                user_id=str(user_id),
                runtime=cai.runtime,
                provider_sandbox_id=cdi.provider_sandbox_id,
                extra_env=runtime_env,
                launch_token=launch_token,
            )
            _apply_handle_to_rows(cdi, handle)
            cdi.last_started_at = _now()
            if handle.status == "failed":
                cai.status = "failed"
                cai.error_code = handle.error_code
                cai.error_message = handle.error_message
            elif handle.status == "ready":
                cai.status = "ready"
                cai.error_code = None
                cai.error_message = None
            else:
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
        else:
            cai.status = "ready"
            cai.error_code = None
            cai.error_message = None
        await db.commit()
        await db.refresh(cai)
        await db.refresh(cdi)
        return _make_view(agent, cai, cdi)

    async def _ensure_agent_loaded_in_online_daemon(
        self,
        db: AsyncSession,
        cai: CloudAgentInstance,
        agent: Agent,
        cdi: CloudDaemonInstance,
    ) -> bool:
        """Ensure an online cloud daemon has the target agent channel loaded.

        Cloud sandboxes boot with an empty daemon config. A resumed daemon can
        therefore be online while the Hub DB still says the agent is ``ready``.
        Probe the live daemon before treating resume as complete; if the agent
        is missing, rotate provisioning metadata and dispatch ``provision_agent``.

        Returns ``False`` only when the live-agent probe failed, in which case
        callers keep the previous best-effort behavior instead of risking a
        duplicate install on a merely flaky control channel.
        """
        if _cloud_daemon_pending_launch_token(cdi):
            return True

        live_agent_ids = await self._list_cloud_daemon_agent_ids(cdi.id)
        if live_agent_ids is None:
            return False

        if cai.agent_id in live_agent_ids:
            cai.status = "ready"
            cai.error_code = None
            cai.error_message = None
            _scrub_provisioning_metadata(cai)
            if cdi.status != "ready":
                cdi.status = "ready"
                cdi.last_started_at = _now()
                cdi.last_seen_at = _now()
            await db.commit()
            return True

        _ensure_provisioning_metadata(db, cai, agent)
        cai.status = "provisioning"
        cai.error_code = None
        cai.error_message = None
        await db.flush()
        await self._provision_one(db, cai, agent, cdi)
        return True

    async def restart_cloud_daemon(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        daemon_instance_id: str,
    ) -> None:
        """Restart the cloud daemon/sandbox owned by ``user_id``.

        This is a daemon-level operation: one cloud daemon can host multiple
        Cloud Agents, so all ready/provisioning agents on the sandbox are
        marked for reprovisioning before the provider relaunches the process.
        """
        self._require_feature_enabled()
        await _lock_cloud_daemon_lifecycle(db, user_id)
        row = (
            await db.execute(
                select(CloudDaemonInstance, DaemonInstance)
                .join(
                    DaemonInstance,
                    DaemonInstance.id == CloudDaemonInstance.daemon_instance_id,
                )
                .where(
                    CloudDaemonInstance.daemon_instance_id == daemon_instance_id,
                    CloudDaemonInstance.user_id == user_id,
                    DaemonInstance.user_id == user_id,
                )
            )
        ).one_or_none()
        if row is None:
            raise CloudAgentError(
                "not_found",
                f"cloud daemon for daemon instance {daemon_instance_id!r} not found",
                http_status=404,
            )
        cdi, daemon_row = row
        if cdi.status in {"deleted", "deleting"}:
            raise CloudAgentError(
                "invalid_state",
                f"cannot restart cloud daemon in status {cdi.status!r}",
                http_status=409,
            )
        if await self._cloud_daemon_has_active_run(db, cdi.id):
            raise CloudAgentError(
                "active_run",
                "cannot restart cloud daemon while a cloud agent run is active",
                http_status=409,
            )
        await _ensure_no_other_active_cloud_daemon(
            db,
            user_id=user_id,
            cloud_daemon_instance_id=cdi.id,
        )

        agent_rows = (
            await db.execute(
                select(CloudAgentInstance, Agent)
                .join(Agent, Agent.agent_id == CloudAgentInstance.agent_id)
                .where(
                    CloudAgentInstance.cloud_daemon_instance_id == cdi.id,
                    CloudAgentInstance.user_id == user_id,
                    CloudAgentInstance.status.notin_(("deleted", "deleting")),
                )
            )
        ).all()
        if not agent_rows:
            raise CloudAgentError(
                "no_agents",
                "cloud daemon has no active agents to restart",
                http_status=409,
            )

        runtime_env = await self._runtime_env_for_user(db, user_id=user_id)

        original_daemon_state = _snapshot_cloud_daemon_state(cdi)
        original_agent_state_by_id = {
            cai.agent_id: _snapshot_cloud_agent_state(cai)
            for cai, _agent in agent_rows
        }
        launch_token = _begin_cloud_daemon_relaunch(
            cdi,
            provisioning_agents=[cai for cai, _agent in agent_rows],
        )
        for cai, agent in agent_rows:
            if cai.status in {"ready", "provisioning", "failed", "paused"}:
                _ensure_provisioning_metadata(db, cai, agent)
                _tag_provisioning_for_cloud_daemon_launch(cai, launch_token)
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
        cdi.status = "starting"
        cdi.error_code = None
        cdi.error_message = None
        await db.commit()

        provider = self._get_provider()
        try:
            handle = await provider.create_or_resume(
                cloud_daemon_instance_id=cdi.id,
                daemon_instance_id=daemon_row.id,
                user_id=str(user_id),
                runtime=cdi.runtime,
                provider_sandbox_id=cdi.provider_sandbox_id,
                extra_env=runtime_env,
                launch_token=launch_token,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "cloud daemon restart failed: cloud=%s err=%s",
                cdi.id,
                exc,
            )
            _restore_cloud_daemon_state(cdi, original_daemon_state)
            for cai, _agent in agent_rows:
                _restore_cloud_agent_state(
                    cai,
                    original_agent_state_by_id[cai.agent_id],
                )
            _clear_cloud_daemon_pending_launch(cdi)
            await db.commit()
            raise CloudAgentError(
                "provider_restart_failed",
                f"cloud daemon provider failed: {exc}",
                http_status=502,
            ) from exc
        _apply_handle_to_rows(cdi, handle)
        cdi.last_started_at = _now()
        if handle.status in {"ready", "starting"}:
            if handle.status == "ready":
                cdi.status = "starting"
            _promote_cloud_daemon_pending_launch(cdi, launch_token=launch_token)
        elif handle.status == "failed":
            _restore_cloud_daemon_state(cdi, original_daemon_state)
            for cai, _agent in agent_rows:
                _restore_cloud_agent_state(
                    cai,
                    original_agent_state_by_id[cai.agent_id],
                )
            _clear_cloud_daemon_pending_launch(cdi)
        await db.commit()

        if handle.status == "failed":
            raise CloudAgentError(
                handle.error_code or "provider_restart_failed",
                handle.error_message
                or "cloud daemon provider reported restart failure",
                http_status=502,
            )

    async def delete_cloud_agent(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> CloudAgentView:
        cai, agent, cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        if cai.status == "deleted":
            return _make_view(agent, cai, cdi)

        cai.status = "deleting"
        agent.status = "deleted"
        agent.deleted_at = _now()
        agent.agent_token = None
        agent.token_expires_at = None
        keys = (
            await db.execute(
                select(SigningKey).where(
                    SigningKey.agent_id == cai.agent_id,
                    SigningKey.state == KeyState.active,
                )
            )
        ).scalars().all()
        for key in keys:
            key.state = KeyState.revoked
        cdi.active_agent_count = max((cdi.active_agent_count or 0) - 1, 0)
        _scrub_provisioning_metadata(cai)

        # Refund any in-flight reservations so the user's quota recovers
        # immediately on delete. Best-effort: a failure here would block
        # an important destructive op, so we log and continue.
        try:
            await self._usage.release_for_agent(db, agent_id=cai.agent_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "release_for_agent failed during delete: agent=%s err=%s",
                cai.agent_id,
                exc,
            )

        await db.flush()

        # Best-effort revoke on the daemon. Failure here doesn't block
        # delete — the sandbox cleanup below also wipes credentials.
        if is_cloud_daemon_online(cdi.id):
            try:
                await send_cloud_control_frame(
                    cdi.id,
                    "revoke_agent",
                    {"agentId": cai.agent_id},
                    timeout_ms=10000,
                )
            except CloudDaemonDispatchError as exc:
                logger.warning(
                    "revoke_agent dispatch failed: agent=%s cloud=%s err=%s",
                    cai.agent_id,
                    cdi.id,
                    exc,
                )

        provider = self._get_provider()
        # Tear down the underlying sandbox once every agent on it is gone.
        if cdi.active_agent_count == 0:
            handle = await provider.cleanup(
                cloud_daemon_instance_id=cdi.id,
                provider_sandbox_id=cdi.provider_sandbox_id,
            )
            _apply_handle_to_rows(cdi, handle)
            cdi.status = "deleted"

        cai.status = "deleted"
        await db.commit()
        await db.refresh(cai)
        await db.refresh(cdi)
        await db.refresh(agent)
        return _make_view(agent, cai, cdi)

    async def get_usage(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        limit: int = 50,
    ) -> CloudAgentUsageView:
        """Return current-period Cloud Credit balance and recent events."""
        cai, _agent, _cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        balance = await self._usage.get_or_create_balance(db, user_id=user_id)
        rows = (
            await db.execute(
                select(UsageEvent)
                .where(UsageEvent.agent_id == cai.agent_id)
                .order_by(UsageEvent.created_at.desc(), UsageEvent.id.desc())
                .limit(max(1, min(limit, 100)))
            )
        ).scalars().all()
        await db.commit()
        return CloudAgentUsageView(
            agent_id=cai.agent_id,
            period_start=balance.period_start,
            period_end=balance.period_end,
            included_credits=balance.included_credits,
            used_credits=balance.used_credits,
            reserved_credits=balance.reserved_credits,
            available_credits=(
                balance.included_credits - balance.used_credits - balance.reserved_credits
            ),
            included_sandbox_seconds=balance.included_sandbox_seconds,
            used_sandbox_seconds=balance.used_sandbox_seconds,
            reserved_sandbox_seconds=balance.reserved_sandbox_seconds,
            available_sandbox_seconds=(
                balance.included_sandbox_seconds
                - balance.used_sandbox_seconds
                - balance.reserved_sandbox_seconds
            ),
            events=[
                CloudAgentUsageEventView(
                    run_id=row.run_id,
                    provider=row.provider,
                    model=row.model,
                    input_cache_hit_tokens=row.input_cache_hit_tokens,
                    input_cache_miss_tokens=row.input_cache_miss_tokens,
                    output_tokens=row.output_tokens,
                    sandbox_seconds=row.sandbox_seconds,
                    credits_charged=row.credits_charged,
                    idempotency_key=row.idempotency_key,
                    created_at=row.created_at,
                )
                for row in rows
            ],
        )

    async def get_run(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        run_id: str,
    ) -> CloudAgentRunStatusView:
        """Best-effort run status from the usage ledger.

        No dedicated run-state table exists; status is inferred from the
        per-run reservation and any settled usage event. Raises
        ``CloudAgentError`` if the run is unknown for this owned agent.
        """
        self._require_feature_enabled()
        # Ownership gate — raises not_found (404) if the user doesn't own it.
        await self._load_owned(db, user_id=user_id, agent_id=agent_id)

        reservation = await db.scalar(
            select(UsageReservation).where(UsageReservation.run_id == run_id)
        )
        event = await db.scalar(
            select(UsageEvent)
            .where(UsageEvent.run_id == run_id)
            .order_by(UsageEvent.created_at.desc(), UsageEvent.id.desc())
        )
        if reservation is None and event is None:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )
        # Cross-check the run actually belongs to this agent.
        if reservation is not None and reservation.agent_id != agent_id:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )
        if event is not None and event.agent_id != agent_id:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )

        return self._run_status_view(run_id, agent_id, reservation, event)

    async def cancel_run(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        run_id: str,
    ) -> CloudAgentRunStatusView:
        """Cancel an in-flight run: release its reservation and fail the
        still-queued trigger message (best-effort).

        Already-settled runs are returned as-is. Idempotent — cancelling a
        run twice is safe.
        """
        self._require_feature_enabled()
        await self._load_owned(db, user_id=user_id, agent_id=agent_id)

        reservation = await db.scalar(
            select(UsageReservation).where(UsageReservation.run_id == run_id)
        )
        event = await db.scalar(
            select(UsageEvent)
            .where(UsageEvent.run_id == run_id)
            .order_by(UsageEvent.created_at.desc(), UsageEvent.id.desc())
        )
        if reservation is None and event is None:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )
        if reservation is not None and reservation.agent_id != agent_id:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )
        if event is not None and event.agent_id != agent_id:
            raise CloudAgentError(
                "run_not_found", f"run {run_id!r} not found", http_status=404
            )

        # Only an active reservation (run not yet settled) can be cancelled.
        if event is None and reservation is not None and reservation.state == "active":
            await self._release_run_usage_reservation_durably(db, run_id=run_id)
            await self._fail_queued_run_message(db, agent_id=agent_id, run_id=run_id)
            reservation = await db.scalar(
                select(UsageReservation).where(UsageReservation.run_id == run_id)
            )

        return self._run_status_view(run_id, agent_id, reservation, event)

    @staticmethod
    def _run_status_view(
        run_id: str,
        agent_id: str,
        reservation: "UsageReservation | None",
        event: "UsageEvent | None",
    ) -> CloudAgentRunStatusView:
        if event is not None:
            status = "completed"
        elif reservation is not None and reservation.state == "active":
            status = "running"
        elif reservation is not None and reservation.state == "settled":
            status = "completed"
        elif reservation is not None and reservation.state == "released":
            status = "cancelled"
        else:
            status = "unknown"
        created_at = (
            event.created_at
            if event is not None
            else (reservation.created_at if reservation is not None else _now())
        )
        return CloudAgentRunStatusView(
            run_id=run_id,
            agent_id=agent_id,
            status=status,
            reserved_credits=(
                reservation.reserved_credits if reservation is not None else 0
            ),
            reserved_sandbox_seconds=(
                reservation.reserved_sandbox_seconds if reservation is not None else 0
            ),
            credits_charged=event.credits_charged if event is not None else None,
            created_at=created_at,
            settled_at=(reservation.settled_at if reservation is not None else None),
        )

    async def _fail_queued_run_message(
        self,
        db: AsyncSession,
        *,
        agent_id: str,
        run_id: str,
    ) -> None:
        """Mark the still-queued ``cloud_agent_run`` trigger message failed.

        Best-effort: the run_id lives inside ``envelope_json`` (not a column),
        so this scans the agent's queued cloud-run messages and matches on the
        parsed payload. If the daemon already dequeued it, there is nothing to
        fail and the released reservation is the meaningful cancellation.
        """
        rows = (
            await db.execute(
                select(MessageRecord).where(
                    MessageRecord.receiver_id == agent_id,
                    MessageRecord.source_type == "cloud_agent_run",
                    MessageRecord.state == MessageState.queued,
                )
            )
        ).scalars().all()
        changed = False
        for record in rows:
            try:
                envelope = json.loads(record.envelope_json or "{}")
                run = (envelope.get("payload") or {}).get("cloud_run") or {}
            except (ValueError, AttributeError):
                continue
            if run.get("run_id") == run_id:
                record.state = MessageState.failed
                changed = True
        if changed:
            await db.commit()

    async def _fail_pending_owner_chat_messages(
        self,
        db: AsyncSession,
        *,
        agent_id: str,
        code: str,
        internal_message: str,
        public_message: str = _OWNER_CHAT_CLOUD_AGENT_RETRY_MESSAGE,
    ) -> int:
        """Fail active owner-chat turns and notify live owner-chat clients.

        Owner-chat callers often wait synchronously on the WS for a terminal
        frame. Leaving the trigger message queued after a cloud-agent lifecycle
        failure makes those callers wait for their outer timeout instead of
        retrying immediately.
        """
        records = (
            await db.execute(
                select(MessageRecord).where(
                    MessageRecord.receiver_id == agent_id,
                    MessageRecord.source_type == "dashboard_user_chat",
                    MessageRecord.source_session_kind == "owner_chat",
                    MessageRecord.state.in_(
                        (MessageState.queued, MessageState.processing)
                    ),
                )
            )
        ).scalars().all()
        if not records:
            return 0

        for record in records:
            record.state = MessageState.failed
            record.last_error = code
        await db.flush()

        from hub.routers.owner_chat_ws import notify_oc_ws_error

        for record in records:
            if not record.room_id:
                continue
            await notify_oc_ws_error(
                room_id=record.room_id,
                hub_msg_id=record.hub_msg_id,
                trace_id=record.hub_msg_id,
                code=code,
                message=public_message,
                retryable=True,
            )

        logger.warning(
            "failed pending owner-chat messages for cloud agent: "
            "agent=%s code=%s count=%d err=%s",
            agent_id,
            code,
            len(records),
            internal_message,
        )
        return len(records)

    def _report_cloud_agent_terminal_error(
        self,
        *,
        agent_id: str,
        cloud_daemon_instance_id: str,
        code: str,
        message: str,
    ) -> None:
        with sentry_sdk.new_scope() as scope:
            scope.set_tag("component", "cloud_agent")
            scope.set_tag("cloud_agent.error_code", code)
            scope.set_tag("agent_id", agent_id)
            scope.set_tag("cloud_daemon_instance_id", cloud_daemon_instance_id)
            scope.set_context(
                "cloud_agent_failure",
                {
                    "agent_id": agent_id,
                    "cloud_daemon_instance_id": cloud_daemon_instance_id,
                    "code": code,
                    "message": message,
                },
            )
            sentry_sdk.capture_message(
                "cloud agent terminal provisioning failure",
                level="error",
            )

    async def provision_pending_for_cloud_daemon(
        self,
        db: AsyncSession,
        *,
        cloud_daemon_instance_id: str,
        cloud_daemon_launch_token: str | None = None,
    ) -> list[CloudAgentView]:
        """Dispatch ``provision_agent`` for agents missing from a connected daemon.

        Called from the ``/cloud/daemon/ws`` hello handler once the daemon is
        registered. A cloud daemon process always boots with an empty in-memory
        config, so a sandbox/process restart must re-provision ready agents
        before their BotCord inbox channels can drain queued messages. A plain
        control-WS reconnect, however, may still have live channels; we avoid
        duplicate installs by asking the daemon for ``list_agents`` first.
        """
        cdi_guard = await db.scalar(
            select(CloudDaemonInstance).where(
                CloudDaemonInstance.id == cloud_daemon_instance_id
            )
        )
        if cdi_guard is None:
            return []
        pending_launch_token = _cloud_daemon_pending_launch_token(cdi_guard)
        if (
            pending_launch_token
            and pending_launch_token != cloud_daemon_launch_token
        ):
            logger.info(
                "cloud daemon provision drain skipped stale launch: cloud=%s",
                cloud_daemon_instance_id,
            )
            return []

        list_probe = await self._probe_cloud_daemon_agent_ids(
            cloud_daemon_instance_id,
            cloud_daemon_launch_token=cloud_daemon_launch_token,
        )
        live_agent_ids = list_probe.agent_ids
        recover_verified_pending_launch = bool(
            pending_launch_token
            and pending_launch_token == cloud_daemon_launch_token
            and list_probe.failure_code in _VERIFIED_PENDING_LAUNCH_LIST_FAILURES
        )
        if (
            pending_launch_token
            and live_agent_ids is None
            and not recover_verified_pending_launch
        ):
            logger.info(
                "cloud daemon provision drain skipped unverified launch target: cloud=%s",
                cloud_daemon_instance_id,
            )
            return []
        if recover_verified_pending_launch:
            logger.warning(
                "cloud daemon list_agents failed for verified pending launch; "
                "continuing provision drain best-effort: cloud=%s code=%s",
                cloud_daemon_instance_id,
                list_probe.failure_code,
            )
        include_ready_rows = (
            live_agent_ids is not None or recover_verified_pending_launch
        )
        statuses = (
            ("provisioning", "ready") if include_ready_rows else ("provisioning",)
        )
        rows = (
            await db.execute(
                select(CloudAgentInstance, Agent, CloudDaemonInstance)
                .join(Agent, Agent.agent_id == CloudAgentInstance.agent_id)
                .join(
                    CloudDaemonInstance,
                    CloudDaemonInstance.id == CloudAgentInstance.cloud_daemon_instance_id,
                )
                .where(
                    CloudAgentInstance.cloud_daemon_instance_id == cloud_daemon_instance_id,
                    CloudAgentInstance.status.in_(statuses),
                )
            )
        ).all()
        if not rows:
            if (
                pending_launch_token
                and pending_launch_token == cloud_daemon_launch_token
                and not await _cloud_daemon_has_launch_tagged_provisioning(
                    db,
                    cloud_daemon_instance_id=cloud_daemon_instance_id,
                    launch_token=pending_launch_token,
                )
            ):
                _promote_cloud_daemon_pending_launch(
                    cdi_guard,
                    launch_token=pending_launch_token,
                )
                _clear_cloud_daemon_pending_launch(cdi_guard)
                await db.commit()
            return []

        results: list[CloudAgentView] = []
        for cai, agent, cdi in rows:
            if live_agent_ids is not None and cai.agent_id in live_agent_ids:
                cai.status = "ready"
                cai.error_code = None
                cai.error_message = None
                _scrub_provisioning_metadata(cai)
                if cdi.status != "ready":
                    cdi.status = "ready"
                    cdi.last_started_at = _now()
                    cdi.last_seen_at = _now()
                await db.commit()
                await db.refresh(cai)
                await db.refresh(cdi)
                await db.refresh(agent)
                results.append(_make_view(agent, cai, cdi))
                continue

            if cai.status == "ready":
                _ensure_provisioning_metadata(db, cai, agent)
                if (
                    pending_launch_token
                    and pending_launch_token == cloud_daemon_launch_token
                ):
                    _tag_provisioning_for_cloud_daemon_launch(
                        cai, pending_launch_token
                    )
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
                await db.flush()

            await self._provision_one(
                db,
                cai,
                agent,
                cdi,
                cloud_daemon_launch_token=cloud_daemon_launch_token,
            )
            # Columns with ``onupdate=func.now()`` get marked as needing
            # a refresh after commit even with expire_on_commit=False.
            await db.refresh(cai)
            await db.refresh(cdi)
            await db.refresh(agent)
            results.append(_make_view(agent, cai, cdi))
        if pending_launch_token and pending_launch_token == cloud_daemon_launch_token:
            tagged_still_pending = await _cloud_daemon_has_launch_tagged_provisioning(
                db,
                cloud_daemon_instance_id=cloud_daemon_instance_id,
                launch_token=pending_launch_token,
            )
            if not tagged_still_pending:
                _promote_cloud_daemon_pending_launch(
                    cdi_guard,
                    launch_token=pending_launch_token,
                )
                _clear_cloud_daemon_pending_launch(cdi_guard)
                await db.commit()
        return results

    async def _list_cloud_daemon_agent_ids(
        self,
        cloud_daemon_instance_id: str,
        *,
        cloud_daemon_launch_token: str | None = None,
    ) -> set[str] | None:
        probe = await self._probe_cloud_daemon_agent_ids(
            cloud_daemon_instance_id,
            cloud_daemon_launch_token=cloud_daemon_launch_token,
        )
        return probe.agent_ids

    async def _probe_cloud_daemon_agent_ids(
        self,
        cloud_daemon_instance_id: str,
        *,
        cloud_daemon_launch_token: str | None = None,
    ) -> _CloudDaemonAgentListProbe:
        """Return agent ids currently loaded in the connected cloud daemon.

        ``None`` means the probe failed. Most callers should avoid
        re-provisioning ready agents in that case because a transient
        control-plane failure is more likely than a clean process restart
        with no channels; verified pending-launch drains may still recover
        by provisioning the rows already tagged for that launch.
        """
        try:
            ack = await send_cloud_control_frame(
                cloud_daemon_instance_id,
                "list_agents",
                {},
                timeout_ms=10000,
                required_launch_token=cloud_daemon_launch_token,
            )
        except CloudDaemonDispatchError as exc:
            logger.warning(
                "cloud daemon list_agents failed: cloud=%s code=%s err=%s",
                cloud_daemon_instance_id,
                exc.code,
                exc.message,
            )
            return _CloudDaemonAgentListProbe(None, exc.code)

        if not ack.get("ok"):
            err = ack.get("error") or {}
            logger.warning(
                "cloud daemon list_agents rejected: cloud=%s code=%s err=%s",
                cloud_daemon_instance_id,
                err.get("code"),
                err.get("message"),
            )
            return _CloudDaemonAgentListProbe(
                None, "cloud_daemon_list_agents_rejected"
            )

        result = ack.get("result")
        agents = result.get("agents") if isinstance(result, dict) else None
        if not isinstance(agents, list):
            return _CloudDaemonAgentListProbe(set())

        out: set[str] = set()
        for entry in agents:
            if not isinstance(entry, dict):
                continue
            raw_id = entry.get("id") or entry.get("agentId")
            if isinstance(raw_id, str) and raw_id:
                out.add(raw_id)
        return _CloudDaemonAgentListProbe(out)

    async def create_run(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        body: CreateRunInput,
    ) -> CloudAgentRunView:
        """Inject a Cloud Agent run as a message into the agent's inbox.

        The run task itself rides on the existing message/inbox flow — the
        Cloud daemon picks it up via its agent inbox subscription, runs
        the configured runtime against it, and writes results back through
        the same flow.
        """
        self._require_feature_enabled()

        prompt = (body.prompt or "").strip()
        if not prompt:
            raise CloudAgentError(
                "invalid_prompt", "prompt is required", http_status=400
            )
        if len(prompt) > _RUN_PROMPT_MAX_CHARS:
            raise CloudAgentError(
                "prompt_too_long",
                f"prompt exceeds the {_RUN_PROMPT_MAX_CHARS}-char limit",
                http_status=413,
            )

        cai, agent, cdi = await self._load_owned(
            db, user_id=user_id, agent_id=agent_id
        )
        if cai.status in {"deleted", "deleting", "failed"}:
            raise CloudAgentError(
                "invalid_state",
                f"cannot run cloud agent in status {cai.status!r}",
                http_status=409,
            )
        if cai.status == "provisioning":
            # The daemon hasn't finished hooking up yet. Surface explicitly
            # so the caller can poll status before retrying.
            raise CloudAgentError(
                "not_ready",
                "cloud agent is still provisioning; retry once status is ready",
                http_status=409,
            )

        budget = body.budget or RunBudget()
        # Defensive clamp — a malicious or buggy client shouldn't be able
        # to push wall-time to the moon. The 4-hour ceiling is well above
        # the MVP's idle pause window so legitimate long runs still work.
        if budget.max_wall_time_seconds <= 0 or budget.max_wall_time_seconds > 14400:
            raise CloudAgentError(
                "invalid_budget",
                "max_wall_time_seconds must be between 1 and 14400",
                http_status=400,
            )
        if budget.max_tool_calls <= 0 or budget.max_tool_calls > 1000:
            raise CloudAgentError(
                "invalid_budget",
                "max_tool_calls must be between 1 and 1000",
                http_status=400,
            )

        await self._ensure_new_api_balance_for_run(db, user_id=user_id)

        run_id = generate_cloud_agent_run_id()
        reserved_credits = self._usage.estimate_run_credits(
            max_wall_time_seconds=budget.max_wall_time_seconds,
            max_tool_calls=budget.max_tool_calls,
        )
        reserved_sandbox_seconds = self._usage.estimate_run_sandbox_seconds(
            max_wall_time_seconds=budget.max_wall_time_seconds
        )
        try:
            await self._usage.reserve(
                db,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                credits=reserved_credits,
                sandbox_seconds=reserved_sandbox_seconds,
                metadata={
                    "source": "cloud_agent_run",
                    "max_wall_time_seconds": budget.max_wall_time_seconds,
                    "max_tool_calls": budget.max_tool_calls,
                },
            )
        except UsageError as exc:
            raise CloudAgentError(
                exc.code,
                exc.message,
                http_status=402,
            ) from exc

        try:
            # Auto-resume paused agents only after all quota preflights. A user
            # with exhausted quota must not wake a paused sandbox/provider.
            if cai.status == "paused":
                await self.resume_cloud_agent(db, user_id=user_id, agent_id=agent_id)
                cai, agent, cdi = await self._load_owned(
                    db, user_id=user_id, agent_id=agent_id
                )

            room_id = await self._resolve_run_room(
                db,
                user_id=user_id,
                agent_id=agent_id,
                agent_display_name=agent.display_name,
                preferred_room_id=body.room_id,
            )

            hub_msg_id = generate_hub_msg_id()
            msg_id = str(uuid.uuid4())
            ts = int(time.time())

            payload = {
                "text": prompt,
                "cloud_run": {
                    "run_id": run_id,
                    "settle_usage": True,
                    "budget": {
                        "max_wall_time_seconds": budget.max_wall_time_seconds,
                        "max_tool_calls": budget.max_tool_calls,
                    },
                },
            }
            envelope = {
                "v": "a2a/0.1",
                "msg_id": msg_id,
                "ts": ts,
                "from": agent_id,
                "to": agent_id,
                # ``cloud_run`` is a custom envelope type the daemon recognises
                # alongside the standard ``message`` flow. Keeping it distinct
                # from ``message`` lets the daemon route runs differently from
                # plain owner-chat without sniffing payload internals.
                "type": "cloud_run",
                "reply_to": None,
                "ttl_sec": budget.max_wall_time_seconds,
                "payload": payload,
                "payload_hash": "",
                "sig": {"alg": "ed25519", "key_id": "cloud-run", "value": ""},
                "topic": body.topic,
            }

            record = MessageRecord(
                hub_msg_id=hub_msg_id,
                msg_id=msg_id,
                sender_id=agent_id,
                receiver_id=agent_id,
                room_id=room_id,
                topic=body.topic,
                state=MessageState.queued,
                envelope_json=json.dumps(envelope),
                ttl_sec=budget.max_wall_time_seconds,
                mentioned=True,
                source_type="cloud_agent_run",
                source_user_id=str(user_id),
                source_session_kind="cloud_run",
            )
            db.add(record)
            cai.last_run_at = _now()

            await db.commit()
        except Exception:
            await self._release_run_usage_reservation_durably(db, run_id=run_id)
            raise

        # Wake the agent's inbox; cloud daemon's per-agent inbox session
        # picks the run up on the same channel as any other message.
        try:
            await _notify_inbox(agent_id, db)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "cloud agent run notify_inbox failed: agent=%s run=%s err=%s",
                agent_id,
                run_id,
                exc,
            )

        return CloudAgentRunView(
            run_id=run_id,
            agent_id=agent_id,
            hub_msg_id=hub_msg_id,
            room_id=room_id,
            status="queued",
            budget=budget,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _release_run_usage_reservation_durably(
        self,
        db: AsyncSession,
        *,
        run_id: str,
    ) -> None:
        try:
            await db.rollback()
            await self._usage.release(db, run_id=run_id)
            await db.commit()
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            logger.warning(
                "cloud agent run usage reservation release failed: run=%s err=%s",
                run_id,
                exc,
            )

    async def _resolve_run_room(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        agent_display_name: str,
        preferred_room_id: str | None,
    ) -> str:
        """Find (or create) the room that the run task lands in.

        Defaults to the deterministic owner-agent chat room so
        responses surface in the same place as ``/api/dashboard/chat``.
        Callers can override with ``room_id`` to drop a run into an
        existing multi-party room, but they must be a member of it.
        """
        # Late import to avoid pulling the hub.routers tree into this
        # service's import graph during module load.
        from hub.routers.dashboard_chat import _ensure_owner_chat_room

        if preferred_room_id:
            from hub.models import Room, RoomMember

            room = await db.scalar(
                select(Room).where(Room.room_id == preferred_room_id)
            )
            if room is None:
                raise CloudAgentError(
                    "room_not_found",
                    f"room {preferred_room_id!r} not found",
                    http_status=404,
                )
            member = await db.scalar(
                select(RoomMember).where(
                    RoomMember.room_id == preferred_room_id,
                    RoomMember.agent_id == agent_id,
                )
            )
            if member is None:
                raise CloudAgentError(
                    "room_forbidden",
                    f"agent {agent_id!r} is not a member of room {preferred_room_id!r}",
                    http_status=403,
                )
            return preferred_room_id

        return await _ensure_owner_chat_room(
            db, str(user_id), agent_id, agent_display_name
        )

    async def _provision_one(
        self,
        db: AsyncSession,
        cai: CloudAgentInstance,
        agent: Agent,
        cdi: CloudDaemonInstance,
        *,
        cloud_daemon_launch_token: str | None = None,
    ) -> None:
        """Dispatch a single ``provision_agent`` frame and persist the outcome."""
        pending_launch_token = _cloud_daemon_pending_launch_token(cdi)
        required_launch_token = cloud_daemon_launch_token
        if pending_launch_token:
            if pending_launch_token != cloud_daemon_launch_token:
                logger.info(
                    "provision_agent dispatch skipped until verified launch: "
                    "agent=%s cloud=%s",
                    cai.agent_id,
                    cdi.id,
                )
                cai.error_code = "cloud_daemon_launch_token_required"
                cai.error_message = (
                    "cloud daemon has a pending launch token; provisioning must "
                    "wait for the matching daemon session"
                )
                await db.commit()
                return
            required_launch_token = pending_launch_token

        provisioning = (cai.metadata_json or {}).get("provisioning") or {}
        private_key_b64 = provisioning.get("private_key_b64")
        key_id = provisioning.get("key_id")
        public_key_b64 = provisioning.get("public_key_b64")
        if not private_key_b64 or not key_id:
            code = "missing_credentials"
            message = "cloud_agent_instances.metadata_json lacks provisioning credentials"
            cai.status = "failed"
            cai.error_code = code
            cai.error_message = message
            await self._fail_pending_owner_chat_messages(
                db,
                agent_id=cai.agent_id,
                code=code,
                internal_message=message,
            )
            self._report_cloud_agent_terminal_error(
                agent_id=cai.agent_id,
                cloud_daemon_instance_id=cdi.id,
                code=code,
                message=message,
            )
            await db.commit()
            return

        token_expires_at = _agent_token_expires_at_seconds(agent.token_expires_at)
        params: dict[str, Any] = {
            "name": agent.display_name,
            "runtime": cai.runtime,
            "credentials": {
                "agentId": agent.agent_id,
                "keyId": key_id,
                "privateKey": private_key_b64,
                "publicKey": public_key_b64,
                "hubUrl": HUB_PUBLIC_BASE_URL,
                "displayName": agent.display_name,
                "token": agent.agent_token,
                "tokenExpiresAt": token_expires_at,
                "runtime": cai.runtime,
            },
        }
        params["defaultAttention"] = _attention_mode_value(agent.default_attention)
        params["attentionKeywords"] = _decode_attention_keywords(
            agent.attention_keywords
        )
        runtime_options = _cloud_agent_runtime_options(cai)
        runtime_model = runtime_options.get("runtime_model")
        reasoning_effort = runtime_options.get("reasoning_effort")
        thinking = runtime_options.get("thinking")
        if runtime_model:
            params["runtimeModel"] = runtime_model
            params["credentials"]["runtimeModel"] = runtime_model
        if reasoning_effort:
            params["reasoningEffort"] = reasoning_effort
            params["credentials"]["reasoningEffort"] = reasoning_effort
        if isinstance(thinking, bool):
            params["thinking"] = thinking
            params["credentials"]["thinking"] = thinking
        if agent.bio:
            params["bio"] = agent.bio

        try:
            ack = await send_cloud_control_frame(
                cdi.id,
                "provision_agent",
                params,
                timeout_ms=30000,
                required_launch_token=required_launch_token,
            )
        except CloudDaemonDispatchError as exc:
            logger.warning(
                "provision_agent dispatch failed: agent=%s cloud=%s err=%s",
                cai.agent_id,
                cdi.id,
                exc,
            )
            cai.error_code = exc.code
            cai.error_message = exc.message
            failed_count = await self._fail_pending_owner_chat_messages(
                db,
                agent_id=cai.agent_id,
                code=exc.code,
                internal_message=exc.message,
            )
            if failed_count:
                self._report_cloud_agent_terminal_error(
                    agent_id=cai.agent_id,
                    cloud_daemon_instance_id=cdi.id,
                    code=exc.code,
                    message=exc.message,
                )
            await db.commit()
            return

        if not ack.get("ok"):
            err = ack.get("error") or {}
            cai.error_code = err.get("code") or "provision_rejected"
            cai.error_message = err.get("message") or "daemon rejected provision_agent"
            failed_count = await self._fail_pending_owner_chat_messages(
                db,
                agent_id=cai.agent_id,
                code=cai.error_code,
                internal_message=cai.error_message,
            )
            if failed_count:
                self._report_cloud_agent_terminal_error(
                    agent_id=cai.agent_id,
                    cloud_daemon_instance_id=cdi.id,
                    code=cai.error_code,
                    message=cai.error_message,
                )
            await db.commit()
            return

        # Success: mark ready, mirror cloud daemon to ready, scrub key.
        cai.status = "ready"
        cai.error_code = None
        cai.error_message = None
        cai.last_run_at = None
        _scrub_provisioning_metadata(cai)
        if cdi.status != "ready":
            cdi.status = "ready"
            cdi.last_started_at = _now()
            cdi.last_seen_at = _now()
        await db.commit()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _get_provider(self) -> CloudDaemonProvider:
        if self._provider is not None:
            return self._provider
        return get_provider(self._provider_name)

    async def _runtime_env_for_user(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
    ) -> dict[str, str]:
        try:
            credential = await self._new_api.ensure_credential(db, user_id=user_id)
        except NewApiError as exc:
            raise CloudAgentError(
                exc.code,
                exc.message,
                http_status=502,
            ) from exc
        try:
            return self._new_api.runtime_env(credential)
        except NewApiError as exc:
            if exc.code == "new_api_api_key_decrypt_failed" and self._new_api.configured():
                try:
                    refreshed = await self._new_api.ensure_credential(
                        db, user_id=user_id, force_refresh=True
                    )
                    return self._new_api.runtime_env(refreshed)
                except NewApiError as refresh_exc:
                    raise CloudAgentError(
                        refresh_exc.code,
                        refresh_exc.message,
                        http_status=502,
                    ) from refresh_exc
            raise CloudAgentError(
                exc.code,
                exc.message,
                http_status=502,
            ) from exc

    async def _ensure_new_api_balance_for_run(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
    ) -> None:
        try:
            balance = await self._new_api.get_balance(db, user_id=user_id)
        except NewApiError as exc:
            raise CloudAgentError(
                exc.code,
                exc.message,
                http_status=502,
            ) from exc
        if not balance.configured:
            return
        if not balance.provisioned:
            raise CloudAgentError(
                "new_api_credential_missing",
                "new-api token is not provisioned for this user",
                http_status=402,
            )
        if balance.token_remain_quota <= 0:
            raise CloudAgentError(
                "new_api_balance_exhausted",
                "new-api token balance is exhausted",
                http_status=402,
            )

    def _require_feature_enabled(self) -> None:
        if not self._feature_enabled:
            raise CloudAgentError(
                "feature_disabled",
                "Cloud Agent feature is not enabled",
                http_status=403,
            )

    async def _pause_cloud_daemon_if_idle(
        self,
        db: AsyncSession,
        cdi: CloudDaemonInstance,
        *,
        cutoff: datetime.datetime,
        now: datetime.datetime,
    ) -> bool:
        agents_result = await db.execute(
            select(CloudAgentInstance).where(
                CloudAgentInstance.cloud_daemon_instance_id == cdi.id,
                CloudAgentInstance.status.in_(("provisioning", "ready")),
            )
        )
        agents = list(agents_result.scalars().all())
        if not agents:
            return False
        if any(agent.status == "provisioning" for agent in agents):
            return False
        if await self._cloud_daemon_has_active_run(
            db,
            cdi.id,
            include_owner_chat_inbox=True,
            now=now,
        ):
            return False

        for agent in agents:
            if _cloud_agent_last_activity_at(agent, cdi) > cutoff:
                return False

        provider = self._get_provider()
        handle = await provider.pause(
            cloud_daemon_instance_id=cdi.id,
            provider_sandbox_id=cdi.provider_sandbox_id,
        )
        if handle.status != "paused":
            raise CloudAgentError(
                handle.error_code or "cloud_daemon_pause_failed",
                handle.error_message or "cloud daemon provider did not confirm pause",
                http_status=502,
            )
        _apply_handle_to_rows(cdi, handle)
        cdi.last_paused_at = now
        cdi.metadata_json = {
            **(cdi.metadata_json or {}),
            "last_pause_reason": "idle_timeout",
        }
        flag_modified(cdi, "metadata_json")
        for agent in agents:
            agent.status = "paused"
            agent.error_code = None
            agent.error_message = None
        await db.commit()
        await disconnect_cloud_daemon_control(
            cdi.id,
            reason="cloud daemon idle-paused",
        )
        logger.info(
            "idle-paused cloud daemon %s after %d idle agent(s)",
            cdi.id,
            len(agents),
        )
        return True

    async def _cloud_daemon_has_active_run(
        self,
        db: AsyncSession,
        cloud_daemon_instance_id: str,
        *,
        include_owner_chat_inbox: bool = False,
        now: datetime.datetime | None = None,
    ) -> bool:
        agent_ids_subquery = (
            select(CloudAgentInstance.agent_id)
            .where(
                CloudAgentInstance.cloud_daemon_instance_id
                == cloud_daemon_instance_id
            )
            .subquery()
        )
        active_reservations = await db.scalar(
            select(func.count())
            .select_from(UsageReservation)
            .where(
                UsageReservation.agent_id.in_(select(agent_ids_subquery.c.agent_id)),
                UsageReservation.state == "active",
            )
        )
        if (active_reservations or 0) > 0:
            return True

        active_message_filters = [
            (
                (MessageRecord.source_type == "cloud_agent_run")
                & MessageRecord.state.notin_((MessageState.done, MessageState.failed))
            )
        ]
        if include_owner_chat_inbox:
            current = now or _now()
            owner_chat_lease_cutoff = current - datetime.timedelta(
                seconds=CLOUD_AGENT_OWNER_CHAT_RUN_LEASE_SECONDS
            )
            active_message_filters.append(
                (
                    (MessageRecord.source_type == "dashboard_user_chat")
                    & (MessageRecord.source_session_kind == "owner_chat")
                    & or_(
                        MessageRecord.state.in_(
                            (MessageState.queued, MessageState.processing)
                        ),
                        and_(
                            MessageRecord.state.in_(
                                (MessageState.delivered, MessageState.acked)
                            ),
                            func.coalesce(
                                MessageRecord.acked_at,
                                MessageRecord.delivered_at,
                                MessageRecord.created_at,
                            )
                            >= owner_chat_lease_cutoff,
                        ),
                    )
                )
            )

        active_messages = await db.scalar(
            select(func.count())
            .select_from(MessageRecord)
            .where(
                MessageRecord.receiver_id.in_(select(agent_ids_subquery.c.agent_id)),
                or_(*active_message_filters),
            )
        )
        return (active_messages or 0) > 0

    async def _enforce_per_user_quota(
        self,
        db: AsyncSession,
        user_id: uuid.UUID,
    ) -> None:
        count = await db.scalar(
            select(func.count())
            .select_from(CloudAgentInstance)
            .where(
                CloudAgentInstance.user_id == user_id,
                CloudAgentInstance.status != "deleted",
            )
        )
        if (count or 0) >= self._max_per_user:
            raise CloudAgentError(
                "quota_exceeded",
                f"你最多可以创建 {self._max_per_user} 个云端 Bot。请先删除不再使用的 Bot 后再创建。",
                http_status=400,
            )

    async def _allocate_or_create_cloud_daemon(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        runtime: str,
    ) -> tuple[CloudDaemonInstance, DaemonInstance]:
        """Find or create the user's single active cloud daemon sandbox.

        The product model is one cloud sandbox per user, with multiple Cloud
        Agents provisioned inside that sandbox. Future runtimes should share
        this sandbox instead of creating a second per-runtime sandbox; the
        per-agent runtime is still recorded on ``cloud_agent_instances``.
        """
        await _lock_cloud_daemon_lifecycle(db, user_id)
        await self._enforce_per_user_quota(db, user_id)

        stmt = (
            select(CloudDaemonInstance)
            .where(
                CloudDaemonInstance.user_id == user_id,
                CloudDaemonInstance.status.in_(_ACTIVE_CLOUD_DAEMON_STATUSES),
            )
            .order_by(CloudDaemonInstance.created_at.asc())
            .limit(1)
        )
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            stmt = stmt.with_for_update()
        candidate = await db.scalar(stmt)
        if candidate is not None:
            daemon_row = await db.scalar(
                select(DaemonInstance).where(
                    DaemonInstance.id == candidate.daemon_instance_id
                )
            )
            if daemon_row is None:
                # Inconsistent state: orphan cloud row without a daemon row.
                # Treat as unusable and fall through to create.
                logger.warning(
                    "orphan cloud daemon %s missing daemon_instances row",
                    candidate.id,
                )
            else:
                if (candidate.active_agent_count or 0) >= candidate.max_agents:
                    raise CloudAgentError(
                        "sandbox_capacity_exceeded",
                        f"当前云端运行环境最多可托管 {candidate.max_agents} 个 Bot。请先删除不再使用的 Bot 后再创建。",
                        http_status=400,
                    )
                return candidate, daemon_row

        daemon_row = DaemonInstance(
            id=generate_daemon_instance_id(),
            user_id=user_id,
            label=f"cloud-{runtime}",
            kind="cloud",
            refresh_token_hash=_placeholder_refresh_hash(),
        )
        db.add(daemon_row)
        await db.flush()
        cloud_row = CloudDaemonInstance(
            id=generate_cloud_daemon_instance_id(),
            user_id=user_id,
            daemon_instance_id=daemon_row.id,
            provider=self._provider_name,
            runtime=runtime,
            status="creating",
            max_agents=self._max_agents_per_daemon,
            active_agent_count=0,
        )
        db.add(cloud_row)
        await db.flush()
        return cloud_row, daemon_row

    async def _load_owned(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
    ) -> tuple[CloudAgentInstance, Agent, CloudDaemonInstance]:
        row = (
            await db.execute(
                select(CloudAgentInstance, Agent, CloudDaemonInstance)
                .join(Agent, Agent.agent_id == CloudAgentInstance.agent_id)
                .join(
                    CloudDaemonInstance,
                    CloudDaemonInstance.id == CloudAgentInstance.cloud_daemon_instance_id,
                )
                .where(
                    CloudAgentInstance.agent_id == agent_id,
                    CloudAgentInstance.user_id == user_id,
                )
            )
        ).one_or_none()
        if row is None:
            raise CloudAgentError(
                "not_found",
                f"cloud agent {agent_id!r} not found",
                http_status=404,
            )
        cai, agent, cdi = row
        return cai, agent, cdi


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _lock_cloud_daemon_lifecycle(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> None:
    """Serialize cloud daemon allocation/resume/restart per user on Postgres.

    The transaction-scoped advisory lock closes the race where two independent
    control paths both decide to relaunch the same sandbox. SQLite test runs
    skip it because they do not support advisory locks.
    """
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return
    await db.execute(
        sa_text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"cloud_agent_sandbox:{user_id}"},
    )


async def _ensure_no_other_active_cloud_daemon(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    cloud_daemon_instance_id: str,
) -> None:
    other = await db.scalar(
        select(CloudDaemonInstance.id)
        .where(
            CloudDaemonInstance.user_id == user_id,
            CloudDaemonInstance.id != cloud_daemon_instance_id,
            CloudDaemonInstance.status.in_(_ACTIVE_CLOUD_DAEMON_STATUSES),
        )
        .limit(1)
    )
    if other is not None:
        raise CloudAgentError(
            "active_sandbox_exists",
            "user already has another active cloud daemon sandbox",
            http_status=409,
        )


async def _notify_inbox(agent_id: str, db: AsyncSession) -> int:
    """Wake any inbox listeners on ``agent_id``.

    Late-imported so the service module stays loadable from background
    tasks (and tests) that don't touch ``hub.routers.hub``.
    """
    from hub.routers.hub import notify_inbox

    return await notify_inbox(agent_id, db=db, resume_cloud=False)


async def resume_cloud_agent_for_inbox(
    db: AsyncSession,
    agent_id: str,
    *,
    raise_on_error: bool = False,
) -> bool:
    """Best-effort wakeup for a cloud-hosted agent with queued inbox work.

    Returns ``True`` when ``agent_id`` is a cloud agent and the resume call
    completed. Non-cloud agents and failed resume attempts return ``False`` so
    callers can decide whether to retry on a later notification pass.
    """
    try:
        agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    except Exception as exc:  # noqa: BLE001
        logger.debug("cloud inbox resume lookup failed: agent=%s err=%s", agent_id, exc)
        if raise_on_error:
            raise
        return False

    if agent is None or agent.hosting_kind != "cloud" or agent.user_id is None:
        return False

    try:
        await CloudAgentService().resume_cloud_agent(
            db,
            user_id=agent.user_id,
            agent_id=agent_id,
        )
        return True
    except CloudAgentError as exc:
        logger.warning(
            "cloud inbox resume skipped: agent=%s code=%s err=%s",
            agent_id,
            exc.code,
            exc.message,
        )
        if raise_on_error:
            raise
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "cloud inbox resume failed: agent=%s err=%s",
            agent_id,
            exc,
            exc_info=True,
        )
        if raise_on_error:
            raise
    return False


def _scrub_provisioning_metadata(cai: CloudAgentInstance) -> None:
    """Remove the temporary private key from ``metadata_json``.

    Called once the daemon has acked ``provision_agent`` (or whenever a
    provision dispatch is abandoned). Keeps the column dict in place so
    callers can keep adding unrelated metadata in future PRs.
    """
    md = dict(cai.metadata_json or {})
    if "provisioning" not in md:
        return
    md.pop("provisioning", None)
    cai.metadata_json = md
    # SQLAlchemy needs an explicit dirty flag on mutable JSON columns
    # when we mutate-in-place; assigning a fresh dict above already
    # triggers it, but flag_modified is the safer pattern here.
    flag_modified(cai, "metadata_json")


def _snapshot_cloud_daemon_state(cdi: CloudDaemonInstance) -> dict[str, Any]:
    return {
        "status": cdi.status,
        "provider": cdi.provider,
        "provider_sandbox_id": cdi.provider_sandbox_id,
        "provider_template_id": cdi.provider_template_id,
        "region": cdi.region,
        "error_code": cdi.error_code,
        "error_message": cdi.error_message,
        "metadata_json": copy.deepcopy(cdi.metadata_json or {}),
        "last_started_at": cdi.last_started_at,
        "last_seen_at": cdi.last_seen_at,
    }


def _restore_cloud_daemon_state(
    cdi: CloudDaemonInstance,
    state: dict[str, Any],
) -> None:
    cdi.status = state.get("status")
    cdi.provider = state["provider"]
    cdi.provider_sandbox_id = state.get("provider_sandbox_id")
    cdi.provider_template_id = state.get("provider_template_id")
    cdi.region = state.get("region")
    cdi.error_code = state.get("error_code")
    cdi.error_message = state.get("error_message")
    cdi.metadata_json = copy.deepcopy(state.get("metadata_json") or {})
    cdi.last_started_at = state.get("last_started_at")
    cdi.last_seen_at = state.get("last_seen_at")
    flag_modified(cdi, "metadata_json")


def _snapshot_cloud_agent_state(cai: CloudAgentInstance) -> dict[str, Any]:
    return {
        "status": cai.status,
        "error_code": cai.error_code,
        "error_message": cai.error_message,
        "metadata_json": copy.deepcopy(cai.metadata_json or {}),
    }


def _restore_cloud_agent_state(
    cai: CloudAgentInstance,
    state: dict[str, Any],
) -> None:
    cai.status = state.get("status")
    cai.error_code = state.get("error_code")
    cai.error_message = state.get("error_message")
    cai.metadata_json = copy.deepcopy(state.get("metadata_json") or {})
    flag_modified(cai, "metadata_json")


def _decode_attention_keywords(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if isinstance(x, str)]


def _attention_mode_value(raw: Any) -> str:
    if raw is None:
        return "always"
    return raw.value if hasattr(raw, "value") else str(raw)


def _clean_runtime_option(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _runtime_options_metadata(
    *,
    runtime_model: str | None,
    reasoning_effort: str | None,
    thinking: bool | None,
) -> dict[str, dict[str, Any]]:
    options: dict[str, Any] = {}
    if runtime_model:
        options["runtime_model"] = runtime_model
    if reasoning_effort:
        options["reasoning_effort"] = reasoning_effort
    if isinstance(thinking, bool):
        options["thinking"] = thinking
    return {"runtime_options": options} if options else {}


def _cloud_agent_runtime_options(cai: CloudAgentInstance) -> dict[str, Any]:
    raw = (cai.metadata_json or {}).get("runtime_options")
    if not isinstance(raw, dict):
        return {}
    options: dict[str, Any] = {}
    runtime_model = _clean_runtime_option(raw.get("runtime_model"))
    reasoning_effort = _clean_runtime_option(raw.get("reasoning_effort"))
    if runtime_model:
        options["runtime_model"] = runtime_model
    if reasoning_effort:
        options["reasoning_effort"] = reasoning_effort
    if isinstance(raw.get("thinking"), bool):
        options["thinking"] = raw["thinking"]
    return options


def _new_cloud_daemon_launch_token() -> str:
    return secrets.token_urlsafe(24)


def _cloud_daemon_pending_launch_token(cdi: CloudDaemonInstance) -> str | None:
    raw = (cdi.metadata_json or {}).get(_CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY)
    return raw if isinstance(raw, str) and raw else None


def _cloud_daemon_current_launch_token(cdi: CloudDaemonInstance) -> str | None:
    raw = (cdi.metadata_json or {}).get(_CLOUD_DAEMON_CURRENT_LAUNCH_TOKEN_KEY)
    return raw if isinstance(raw, str) and raw else None


def _cloud_daemon_launch_token_for_start(cdi: CloudDaemonInstance) -> str | None:
    return _cloud_daemon_pending_launch_token(cdi) or _cloud_daemon_current_launch_token(
        cdi
    )


def _provisioning_launch_token(cai: CloudAgentInstance) -> str | None:
    provisioning = (cai.metadata_json or {}).get("provisioning")
    if not isinstance(provisioning, dict):
        return None
    raw = provisioning.get(_PROVISIONING_LAUNCH_TOKEN_KEY)
    return raw if isinstance(raw, str) and raw else None


async def _cloud_daemon_has_launch_tagged_provisioning(
    db: AsyncSession,
    *,
    cloud_daemon_instance_id: str,
    launch_token: str,
) -> bool:
    rows = (
        await db.execute(
            select(CloudAgentInstance).where(
                CloudAgentInstance.cloud_daemon_instance_id
                == cloud_daemon_instance_id,
                CloudAgentInstance.status == "provisioning",
            )
        )
    ).scalars()
    return any(_provisioning_launch_token(cai) == launch_token for cai in rows)


def _tag_provisioning_for_cloud_daemon_launch(
    cai: CloudAgentInstance,
    launch_token: str,
) -> None:
    md = dict(cai.metadata_json or {})
    provisioning = dict(md.get("provisioning") or {})
    provisioning[_PROVISIONING_LAUNCH_TOKEN_KEY] = launch_token
    md["provisioning"] = provisioning
    cai.metadata_json = md
    flag_modified(cai, "metadata_json")


def _begin_cloud_daemon_relaunch(
    cdi: CloudDaemonInstance,
    *,
    provisioning_agents: list[CloudAgentInstance],
) -> str:
    launch_token = _new_cloud_daemon_launch_token()
    cdi.metadata_json = {
        **(cdi.metadata_json or {}),
        _CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY: launch_token,
    }
    flag_modified(cdi, "metadata_json")
    for cai in provisioning_agents:
        _tag_provisioning_for_cloud_daemon_launch(cai, launch_token)
    return launch_token


def _promote_cloud_daemon_pending_launch(
    cdi: CloudDaemonInstance,
    *,
    launch_token: str | None = None,
) -> None:
    md = dict(cdi.metadata_json or {})
    pending_launch_token = md.get(_CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY)
    if launch_token is None:
        launch_token = (
            pending_launch_token
            if isinstance(pending_launch_token, str) and pending_launch_token
            else None
        )
    elif pending_launch_token != launch_token:
        return
    if not launch_token:
        return
    md[_CLOUD_DAEMON_CURRENT_LAUNCH_TOKEN_KEY] = launch_token
    cdi.metadata_json = md
    flag_modified(cdi, "metadata_json")


def _clear_cloud_daemon_pending_launch(cdi: CloudDaemonInstance) -> None:
    md = dict(cdi.metadata_json or {})
    if _CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY not in md:
        return
    md.pop(_CLOUD_DAEMON_PENDING_LAUNCH_TOKEN_KEY, None)
    cdi.metadata_json = md
    flag_modified(cdi, "metadata_json")


def _daemon_snapshot_accepts_runtime_options(
    instance: DaemonInstance,
    *,
    runtime: str,
    runtime_model: str | None,
    reasoning_effort: str | None,
    thinking: bool | None,
) -> bool:
    snap = instance.runtimes_json
    if not isinstance(snap, list) or not snap:
        return True
    for entry in snap:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") != runtime:
            continue
        if entry.get("available") is not True:
            return False
        return _runtime_snapshot_accepts_model_options(
            entry,
            runtime_model=runtime_model,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
        )
    return False


def _runtime_snapshot_accepts_model_options(
    entry: dict,
    *,
    runtime_model: str | None,
    reasoning_effort: str | None,
    thinking: bool | None,
) -> bool:
    selected_model: dict | None = None
    if runtime_model:
        models = entry.get("models")
        if isinstance(models, list) and models:
            for model in models:
                if isinstance(model, dict) and model.get("id") == runtime_model:
                    selected_model = model
                    break
            if selected_model is None:
                return False

    if reasoning_effort:
        param = _find_runtime_parameter(
            entry,
            selected_model,
            ("reasoning_effort", "effort"),
        )
        if param is not None:
            values = param.get("values")
            if isinstance(values, list) and values:
                return reasoning_effort in {str(v) for v in values}

    if thinking is not None:
        param = _find_runtime_parameter(entry, selected_model, ("thinking",))
        if param is None:
            return False
        if param.get("type") != "boolean":
            return False

    return True


def _find_runtime_parameter(
    entry: dict,
    model: dict | None,
    ids: tuple[str, ...],
) -> dict | None:
    for container in (model, entry):
        if not isinstance(container, dict):
            continue
        params = container.get("parameters")
        if not isinstance(params, list):
            continue
        for param in params:
            if isinstance(param, dict) and param.get("id") in ids:
                return param
    return None


def _ensure_provisioning_metadata(
    db: AsyncSession,
    cai: CloudAgentInstance,
    agent: Agent,
) -> None:
    """Ensure a cloud agent can be provisioned into a fresh sandbox.

    E2B sandboxes can disappear after their lifetime elapses. A restarted
    cloud daemon always boots with zero channels, so Hub must be able to send
    ``provision_agent`` again even for agents that were previously ready. If
    the one-time provisioning key was scrubbed, rotate in a new signing key for
    the same agent id and issue a fresh agent token.
    """
    provisioning = (cai.metadata_json or {}).get("provisioning") or {}
    if provisioning.get("private_key_b64") and provisioning.get("key_id"):
        return

    signing_key = NaClSigningKey.generate()
    pubkey_b64 = base64.b64encode(bytes(signing_key.verify_key)).decode("ascii")
    private_key_b64 = base64.b64encode(bytes(signing_key)).decode("ascii")
    key_id = generate_key_id()
    cai.metadata_json = {
        **(cai.metadata_json or {}),
        "provisioning": {
            "private_key_b64": private_key_b64,
            "public_key_b64": pubkey_b64,
            "key_id": key_id,
        },
    }
    db.add(
        SigningKey(
            agent_id=agent.agent_id,
            key_id=key_id,
            pubkey=f"ed25519:{pubkey_b64}",
            state=KeyState.active,
        )
    )
    agent_token, token_expires_at = create_agent_token(agent.agent_id)
    agent.agent_token = agent_token
    agent.token_expires_at = datetime.datetime.fromtimestamp(
        token_expires_at, tz=datetime.timezone.utc
    )
    flag_modified(cai, "metadata_json")


def _apply_handle_to_rows(
    cdi: CloudDaemonInstance,
    handle: CloudDaemonHandle,
) -> None:
    """Copy provider-reported state onto the cloud_daemon_instances row."""
    cdi.status = handle.status
    cdi.provider = handle.provider
    if handle.provider_sandbox_id is not None:
        cdi.provider_sandbox_id = handle.provider_sandbox_id
    if handle.provider_template_id is not None:
        cdi.provider_template_id = handle.provider_template_id
    if handle.region is not None:
        cdi.region = handle.region
    cdi.error_code = handle.error_code
    cdi.error_message = handle.error_message
    if handle.status == "ready":
        cdi.last_started_at = _now()
        cdi.last_seen_at = _now()


def _make_view(
    agent: Agent,
    cai: CloudAgentInstance,
    cdi: CloudDaemonInstance,
) -> CloudAgentView:
    runtime_options = _cloud_agent_runtime_options(cai)
    return CloudAgentView(
        cloud_agent_instance_id=cai.id,
        agent_id=cai.agent_id,
        name=agent.display_name,
        bio=agent.bio,
        avatar_url=agent.avatar_url,
        user_id=cai.user_id,
        hosting_kind=agent.hosting_kind or "cloud",
        runtime=cai.runtime,
        model_profile=cai.model_profile,
        status=cai.status,
        cloud_daemon_instance_id=cdi.id,
        cloud_daemon_status=cdi.status,
        provider=cdi.provider,
        provider_sandbox_id=cdi.provider_sandbox_id,
        created_at=cai.created_at,
        updated_at=cai.updated_at,
        last_run_at=cai.last_run_at,
        error_code=cai.error_code,
        error_message=cai.error_message,
        runtime_model=runtime_options.get("runtime_model"),
        reasoning_effort=runtime_options.get("reasoning_effort"),
        thinking=runtime_options.get("thinking"),
    )

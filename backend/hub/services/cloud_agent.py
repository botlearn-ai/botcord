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
from typing import Any

from nacl.signing import SigningKey as NaClSigningKey
from sqlalchemy import func, select, text as sa_text
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

logger = logging.getLogger(__name__)


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


@dataclass
class CreateCloudAgentInput:
    name: str
    bio: str | None = None
    model_profile: str | None = None
    runtime: str | None = None


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
        model_profile = (body.model_profile or CLOUD_AGENT_DEFAULT_MODEL_PROFILE).strip()

        await self._enforce_per_user_quota(db, user_id)

        # Find an existing cloud daemon with free capacity, or provision a
        # fresh one. The schema supports >=1 Cloud Agent per cloud daemon
        # so this is the slot-allocation knob.
        cloud_daemon, daemon_row = await self._allocate_or_create_cloud_daemon(
            db,
            user_id=user_id,
            runtime=runtime,
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
                "provisioning": {
                    "private_key_b64": private_key_b64,
                    "public_key_b64": pubkey_b64,
                    "key_id": key_id,
                }
            },
        )
        db.add(cloud_agent)
        cloud_daemon.active_agent_count = (cloud_daemon.active_agent_count or 0) + 1
        await db.flush()

        # Hand off to the provider. The fake provider returns ready
        # synchronously; the E2B provider will return ``starting`` and
        # transition to ``ready`` once the daemon's hello frame lands.
        try:
            handle = await provider.create_or_resume(
                cloud_daemon_instance_id=cloud_daemon.id,
                daemon_instance_id=daemon_row.id,
                user_id=str(user_id),
                runtime=cloud_daemon.runtime,
                provider_sandbox_id=cloud_daemon.provider_sandbox_id,
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
        await db.commit()
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
            try:
                if await self._pause_cloud_daemon_if_idle(
                    db, cdi, cutoff=cutoff, now=current
                ):
                    paused += 1
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                logger.warning(
                    "idle pause failed: cloud=%s sandbox=%s err=%s",
                    cdi.id,
                    cdi.provider_sandbox_id,
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
        cai, agent, cdi = await self._load_owned(db, user_id=user_id, agent_id=agent_id)
        if cai.status in {"deleted", "deleting"}:
            raise CloudAgentError(
                "invalid_state",
                f"cannot resume cloud agent in status {cai.status!r}",
                http_status=409,
            )
        daemon_online = is_cloud_daemon_online(cdi.id)
        if cai.status == "ready" and daemon_online:
            return _make_view(agent, cai, cdi)

        provider = self._get_provider()
        if cdi.status != "ready" or not daemon_online:
            if not daemon_online:
                _ensure_provisioning_metadata(db, cai, agent)
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
                await db.commit()
            handle = await provider.create_or_resume(
                cloud_daemon_instance_id=cdi.id,
                daemon_instance_id=cdi.daemon_instance_id,
                user_id=str(user_id),
                runtime=cai.runtime,
                provider_sandbox_id=cdi.provider_sandbox_id,
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

    async def provision_pending_for_cloud_daemon(
        self,
        db: AsyncSession,
        *,
        cloud_daemon_instance_id: str,
    ) -> list[CloudAgentView]:
        """Dispatch ``provision_agent`` for agents missing from a connected daemon.

        Called from the ``/cloud/daemon/ws`` hello handler once the daemon is
        registered. A cloud daemon process always boots with an empty in-memory
        config, so a sandbox/process restart must re-provision ready agents
        before their BotCord inbox channels can drain queued messages. A plain
        control-WS reconnect, however, may still have live channels; we avoid
        duplicate installs by asking the daemon for ``list_agents`` first.
        """
        live_agent_ids = await self._list_cloud_daemon_agent_ids(
            cloud_daemon_instance_id
        )
        statuses = (
            ("provisioning", "ready")
            if live_agent_ids is not None
            else ("provisioning",)
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
                cai.status = "provisioning"
                cai.error_code = None
                cai.error_message = None
                await db.flush()

            await self._provision_one(db, cai, agent, cdi)
            # Columns with ``onupdate=func.now()`` get marked as needing
            # a refresh after commit even with expire_on_commit=False.
            await db.refresh(cai)
            await db.refresh(cdi)
            await db.refresh(agent)
            results.append(_make_view(agent, cai, cdi))
        return results

    async def _list_cloud_daemon_agent_ids(
        self,
        cloud_daemon_instance_id: str,
    ) -> set[str] | None:
        """Return agent ids currently loaded in the connected cloud daemon.

        ``None`` means the probe failed; callers should avoid re-provisioning
        already-ready agents in that case because a transient control-plane
        failure is more likely than a clean process restart with no channels.
        """
        try:
            ack = await send_cloud_control_frame(
                cloud_daemon_instance_id,
                "list_agents",
                {},
                timeout_ms=10000,
            )
        except CloudDaemonDispatchError as exc:
            logger.warning(
                "cloud daemon list_agents failed: cloud=%s code=%s err=%s",
                cloud_daemon_instance_id,
                exc.code,
                exc.message,
            )
            return None

        if not ack.get("ok"):
            err = ack.get("error") or {}
            logger.warning(
                "cloud daemon list_agents rejected: cloud=%s code=%s err=%s",
                cloud_daemon_instance_id,
                err.get("code"),
                err.get("message"),
            )
            return None

        result = ack.get("result")
        agents = result.get("agents") if isinstance(result, dict) else None
        if not isinstance(agents, list):
            return set()

        out: set[str] = set()
        for entry in agents:
            if not isinstance(entry, dict):
                continue
            raw_id = entry.get("id") or entry.get("agentId")
            if isinstance(raw_id, str) and raw_id:
                out.add(raw_id)
        return out

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
        DeepSeek-TUI against it, and writes results back through the same
        flow. The run_id, budget, and source_type allow PR 7 to settle
        usage against this single run.
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

        # Auto-resume paused agents — runs imply intent to use the sandbox.
        if cai.status == "paused":
            await self.resume_cloud_agent(db, user_id=user_id, agent_id=agent_id)
            cai, agent, cdi = await self._load_owned(
                db, user_id=user_id, agent_id=agent_id
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

        # Preflight + reserve before any side effects so a quota
        # rejection never leaves orphan rows behind.
        estimated_credits = self._usage.estimate_run_credits(
            max_wall_time_seconds=budget.max_wall_time_seconds,
            max_tool_calls=budget.max_tool_calls,
        )
        estimated_sandbox_seconds = self._usage.estimate_run_sandbox_seconds(
            max_wall_time_seconds=budget.max_wall_time_seconds
        )
        try:
            await self._usage.preflight(
                db,
                user_id=user_id,
                estimated_credits=estimated_credits,
                estimated_sandbox_seconds=estimated_sandbox_seconds,
            )
        except UsageError as exc:
            raise CloudAgentError(
                exc.code, exc.message, http_status=402
            ) from exc

        run_id = generate_cloud_agent_run_id()
        try:
            await self._usage.reserve(
                db,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                credits=estimated_credits,
                sandbox_seconds=estimated_sandbox_seconds,
                metadata={
                    "budget": {
                        "max_wall_time_seconds": budget.max_wall_time_seconds,
                        "max_tool_calls": budget.max_tool_calls,
                    },
                },
            )
        except UsageError as exc:
            raise CloudAgentError(
                exc.code, exc.message, http_status=402
            ) from exc

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

        reservation = await self._usage.reserve(
            db,
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            credits=estimated_credits,
            sandbox_seconds=estimated_sandbox_seconds,
            metadata={},
        )
        reservation.metadata_json = {
            **(reservation.metadata_json or {}),
            "hub_msg_id": hub_msg_id,
        }
        flag_modified(reservation, "metadata_json")
        await db.commit()

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
    ) -> None:
        """Dispatch a single ``provision_agent`` frame and persist the outcome."""
        provisioning = (cai.metadata_json or {}).get("provisioning") or {}
        private_key_b64 = provisioning.get("private_key_b64")
        key_id = provisioning.get("key_id")
        public_key_b64 = provisioning.get("public_key_b64")
        if not private_key_b64 or not key_id:
            cai.status = "failed"
            cai.error_code = "missing_credentials"
            cai.error_message = (
                "cloud_agent_instances.metadata_json lacks provisioning credentials"
            )
            await db.commit()
            return

        token_expires_at_ms = (
            int(agent.token_expires_at.timestamp() * 1000)
            if agent.token_expires_at is not None
            else None
        )
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
                "tokenExpiresAt": token_expires_at_ms,
                "runtime": cai.runtime,
            },
        }
        if agent.bio:
            params["bio"] = agent.bio

        try:
            ack = await send_cloud_control_frame(
                cdi.id,
                "provision_agent",
                params,
                timeout_ms=30000,
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
            await db.commit()
            return

        if not ack.get("ok"):
            err = ack.get("error") or {}
            cai.error_code = err.get("code") or "provision_rejected"
            cai.error_message = err.get("message") or "daemon rejected provision_agent"
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
        if await self._cloud_daemon_has_active_run(db, cdi.id):
            return False

        for agent in agents:
            if _cloud_agent_last_activity_at(agent, cdi) > cutoff:
                return False

        provider = self._get_provider()
        handle = await provider.pause(
            cloud_daemon_instance_id=cdi.id,
            provider_sandbox_id=cdi.provider_sandbox_id,
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
        logger.info(
            "idle-paused cloud daemon %s after %d idle agent(s)",
            cdi.id,
            len(agents),
        )
        return True

    async def _cloud_daemon_has_active_run(
        self, db: AsyncSession, cloud_daemon_instance_id: str
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

        active_messages = await db.scalar(
            select(func.count())
            .select_from(MessageRecord)
            .where(
                MessageRecord.receiver_id.in_(select(agent_ids_subquery.c.agent_id)),
                MessageRecord.source_type == "cloud_agent_run",
                MessageRecord.state.notin_((MessageState.done, MessageState.failed)),
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
                f"Cloud Agent quota exceeded (max {self._max_per_user})",
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
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            await db.execute(
                sa_text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
                {"lock_key": f"cloud_agent_sandbox:{user_id}"},
            )
        await self._enforce_per_user_quota(db, user_id)

        stmt = (
            select(CloudDaemonInstance)
            .where(
                CloudDaemonInstance.user_id == user_id,
                CloudDaemonInstance.status.in_(
                    ("creating", "starting", "ready", "paused")
                ),
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
                        f"Cloud sandbox capacity exceeded (max {candidate.max_agents})",
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


async def _notify_inbox(agent_id: str, db: AsyncSession) -> int:
    """Wake any inbox listeners on ``agent_id``.

    Late-imported so the service module stays loadable from background
    tasks (and tests) that don't touch ``hub.routers.hub``.
    """
    from hub.routers.hub import notify_inbox

    return await notify_inbox(agent_id, db=db)


async def resume_cloud_agent_for_inbox(
    db: AsyncSession,
    agent_id: str,
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
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "cloud inbox resume failed: agent=%s err=%s",
            agent_id,
            exc,
            exc_info=True,
        )
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
    )

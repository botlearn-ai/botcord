"""E2B-backed :class:`CloudDaemonProvider` implementation.

The provider does three things:

1. Create / resume an E2B sandbox from the configured template.
2. Inject the cloud-daemon-access JWT, Hub URL, ids and the DeepSeek
   provider key as environment variables.
3. Launch ``botcord-daemon start --foreground`` inside the sandbox so it
   dials home over ``/cloud/daemon/ws``.

The actual E2B SDK calls go through a small :class:`E2BSandboxClient`
Protocol so tests can swap in a :class:`FakeE2BSandboxClient` without
touching the network. The real implementation (:class:`_E2BSdkClient`)
lazy-imports the ``e2b`` Python SDK so the rest of the Hub keeps booting
without the SDK installed.

Pre-decisions captured here (see docs/cloud-agent-technical-design.md §7.3
"待 PR 4 前确认"):

- DeepSeek key lives as a Hub env var (``DEEPSEEK_API_KEY``) and is forwarded
  to the sandbox at boot. Migrating to a secret manager is a production
  hardening task tracked separately.
- Template defaults to the Gate-0-verified Ubuntu 24.04 / glibc 2.39
  image, overridable via ``E2B_TEMPLATE_ID``.
- Daemon startup uses ``botcord-daemon start --foreground``.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

from hub.config import (
    CLOUD_DAEMON_NPM_SPEC,
    CLOUD_DAEMON_STARTUP_COMMAND,
    DEEPSEEK_API_KEY,
    E2B_API_KEY,
    E2B_DEFAULT_REGION,
    E2B_SANDBOX_TIMEOUT_SECONDS,
    E2B_TEMPLATE_ID,
    HUB_PUBLIC_BASE_URL,
)
from hub.routers.cloud_daemon_control import _create_cloud_daemon_access_token
from hub.services.cloud_daemon_provider import CloudDaemonHandle

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sandbox client abstraction
# ---------------------------------------------------------------------------


@dataclass
class SandboxRunResult:
    """Outcome of starting (or restarting) the daemon process in a sandbox."""

    sandbox_id: str
    template_id: str
    region: str | None
    started: bool


class E2BSandboxClient(Protocol):
    """Tiny surface against the E2B SDK so the provider stays mockable."""

    async def create_sandbox(
        self,
        *,
        template_id: str,
        env: dict[str, str],
        region: str | None,
        timeout_seconds: int,
        lifecycle: dict[str, Any] | None,
    ) -> SandboxRunResult:
        ...

    async def resume_sandbox(
        self,
        *,
        sandbox_id: str,
        env: dict[str, str],
        timeout_seconds: int,
    ) -> SandboxRunResult:
        ...

    async def run_command(
        self,
        *,
        sandbox_id: str,
        command: str,
        env: dict[str, str],
        background: bool = True,
    ) -> None:
        ...

    async def pause_sandbox(self, *, sandbox_id: str) -> None:
        ...

    async def kill_sandbox(self, *, sandbox_id: str) -> None:
        ...


# ---------------------------------------------------------------------------
# Real implementation (lazy import of e2b SDK)
# ---------------------------------------------------------------------------


class _E2BSdkClient:
    """Thin adapter onto the ``e2b`` Python SDK.

    Imported lazily so unit tests and CI environments without the SDK can
    still load this module — only instantiating ``_E2BSdkClient`` triggers
    the import.

    The adapter is stateless: every method looks the sandbox up by id via
    :meth:`e2b.AsyncSandbox.connect`. SDK-specific exceptions
    (``SandboxNotFoundException`` etc.) are translated into the contract
    expected by :class:`E2BCloudDaemonProvider`:

    - "sandbox not found" → :class:`LookupError`
    - everything else     → :class:`RuntimeError`
    """

    def __init__(self, api_key: str) -> None:
        try:
            import e2b  # noqa: F401 — lazy import
        except ImportError as exc:  # pragma: no cover — exercised in deploy
            raise RuntimeError(
                "e2b SDK is not installed. Add 'e2b' to backend dependencies "
                "before enabling the e2b cloud daemon provider."
            ) from exc
        self._api_key = api_key
        self._e2b = e2b

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _api_opts(self) -> dict[str, Any]:
        """Kwargs forwarded to every SDK call so the API key is explicit."""
        return {"api_key": self._api_key}

    async def _connect(self, sandbox_id: str, *, timeout_seconds: int):
        """Return a live :class:`AsyncSandbox` handle for ``sandbox_id``.

        ``AsyncSandbox.connect`` auto-resumes a paused sandbox. Raises
        :class:`LookupError` if E2B doesn't recognise the id.
        """
        try:
            return await self._e2b.AsyncSandbox.connect(
                sandbox_id,
                timeout=timeout_seconds,
                **self._api_opts(),
            )
        except self._e2b.SandboxNotFoundException as exc:
            raise LookupError(str(exc)) from exc
        except self._e2b.SandboxException as exc:
            raise RuntimeError(str(exc)) from exc

    # ------------------------------------------------------------------
    # E2BSandboxClient protocol
    # ------------------------------------------------------------------

    async def create_sandbox(
        self,
        *,
        template_id: str,
        env: dict[str, str],
        region: str | None,
        timeout_seconds: int,
        lifecycle: dict[str, Any] | None,
    ) -> SandboxRunResult:
        try:
            sandbox = await self._e2b.AsyncSandbox.create(
                template=template_id,
                timeout=timeout_seconds,
                envs=env,
                lifecycle=lifecycle,
                **self._api_opts(),
            )
        except self._e2b.SandboxException as exc:
            raise RuntimeError(str(exc)) from exc

        return SandboxRunResult(
            sandbox_id=sandbox.sandbox_id,
            template_id=template_id,
            region=region,
            started=True,
        )

    async def resume_sandbox(
        self,
        *,
        sandbox_id: str,
        env: dict[str, str],
        timeout_seconds: int,
    ) -> SandboxRunResult:
        # ``connect`` auto-resumes a paused sandbox. Env vars for the
        # next daemon launch are applied by ``run_command`` (which the
        # provider always calls right after this); we don't need to mutate
        # the sandbox's own env here.
        sandbox = await self._connect(sandbox_id, timeout_seconds=timeout_seconds)
        return SandboxRunResult(
            sandbox_id=sandbox.sandbox_id,
            template_id="",
            region=None,
            started=True,
        )

    async def run_command(
        self,
        *,
        sandbox_id: str,
        command: str,
        env: dict[str, str],
        background: bool = True,
    ) -> None:
        sandbox = await self._connect(sandbox_id, timeout_seconds=0)
        try:
            if background:
                # ``timeout=0`` keeps envd's process stream open indefinitely.
                # The SDK default (60s) closes the stream once the Python
                # provider returns, and envd then terminates the orphaned
                # background process — sandbox keeps running, but the cloud
                # daemon dies exactly one minute after boot.
                await sandbox.commands.run(
                    command, background=True, envs=env, timeout=0
                )
            else:
                await sandbox.commands.run(command, envs=env)
        except self._e2b.SandboxNotFoundException as exc:
            raise LookupError(str(exc)) from exc
        except self._e2b.SandboxException as exc:
            raise RuntimeError(str(exc)) from exc

    async def pause_sandbox(self, *, sandbox_id: str) -> None:
        try:
            await self._e2b.AsyncSandbox.pause(sandbox_id, **self._api_opts())
        except self._e2b.SandboxNotFoundException as exc:
            raise LookupError(str(exc)) from exc
        except self._e2b.SandboxException as exc:
            raise RuntimeError(str(exc)) from exc

    async def kill_sandbox(self, *, sandbox_id: str) -> None:
        # ``AsyncSandbox.kill`` returns False if the sandbox is already
        # gone — treat that as success (idempotent cleanup).
        try:
            killed = await self._e2b.AsyncSandbox.kill(
                sandbox_id, **self._api_opts()
            )
        except self._e2b.SandboxException as exc:
            raise RuntimeError(str(exc)) from exc
        if not killed:
            logger.info(
                "e2b kill_sandbox: sandbox %s was already gone; treating as success",
                sandbox_id,
            )


# ---------------------------------------------------------------------------
# Fake — used by service tests and any local dev that doesn't talk to E2B.
# ---------------------------------------------------------------------------


@dataclass
class _FakeSandboxCommand:
    command: str
    env: dict[str, str]
    background: bool


@dataclass
class _FakeSandboxRecord:
    sandbox_id: str
    template_id: str
    region: str | None
    env: dict[str, str]
    lifecycle: dict[str, Any]
    status: str  # running | paused | killed
    commands: list[str] = field(default_factory=list)
    command_runs: list[_FakeSandboxCommand] = field(default_factory=list)


class FakeE2BSandboxClient:
    """In-memory E2B sandbox client for tests and local dev."""

    def __init__(
        self,
        *,
        fail_on: str | None = None,
    ) -> None:
        # ``fail_on`` may be one of ``create``/``resume``/``run_command``/
        # ``pause``/``kill``; tests use it to assert error mapping.
        self._fail_on = fail_on
        self._sandboxes: dict[str, _FakeSandboxRecord] = {}
        self._lock = asyncio.Lock()
        self._next_id = 0

    # ------------------------------------------------------------------
    # Test introspection
    # ------------------------------------------------------------------

    def get(self, sandbox_id: str) -> _FakeSandboxRecord | None:
        return self._sandboxes.get(sandbox_id)

    def all(self) -> list[_FakeSandboxRecord]:
        return list(self._sandboxes.values())

    # ------------------------------------------------------------------
    # E2BSandboxClient protocol
    # ------------------------------------------------------------------

    async def create_sandbox(
        self,
        *,
        template_id: str,
        env: dict[str, str],
        region: str | None,
        timeout_seconds: int,
        lifecycle: dict[str, Any] | None,
    ) -> SandboxRunResult:
        if self._fail_on == "create":
            raise RuntimeError("fake e2b create failure")
        async with self._lock:
            self._next_id += 1
            sandbox_id = f"sbx_fake_{self._next_id:04d}"
            self._sandboxes[sandbox_id] = _FakeSandboxRecord(
                sandbox_id=sandbox_id,
                template_id=template_id,
                region=region,
                env=dict(env),
                lifecycle=dict(lifecycle or {}),
                status="running",
            )
            return SandboxRunResult(
                sandbox_id=sandbox_id,
                template_id=template_id,
                region=region,
                started=True,
            )

    async def resume_sandbox(
        self,
        *,
        sandbox_id: str,
        env: dict[str, str],
        timeout_seconds: int,
    ) -> SandboxRunResult:
        if self._fail_on == "resume":
            raise RuntimeError("fake e2b resume failure")
        async with self._lock:
            sb = self._sandboxes.get(sandbox_id)
            if sb is None:
                raise LookupError(f"unknown sandbox {sandbox_id!r}")
            sb.status = "running"
            return SandboxRunResult(
                sandbox_id=sb.sandbox_id,
                template_id=sb.template_id,
                region=sb.region,
                started=True,
            )

    async def run_command(
        self,
        *,
        sandbox_id: str,
        command: str,
        env: dict[str, str],
        background: bool = True,
    ) -> None:
        if self._fail_on == "run_command":
            raise RuntimeError("fake e2b run_command failure")
        async with self._lock:
            sb = self._sandboxes.get(sandbox_id)
            if sb is None:
                raise LookupError(f"unknown sandbox {sandbox_id!r}")
            sb.commands.append(command)
            sb.command_runs.append(
                _FakeSandboxCommand(
                    command=command,
                    env=dict(env),
                    background=background,
                )
            )

    async def pause_sandbox(self, *, sandbox_id: str) -> None:
        if self._fail_on == "pause":
            raise RuntimeError("fake e2b pause failure")
        async with self._lock:
            sb = self._sandboxes.get(sandbox_id)
            if sb is None:
                raise LookupError(f"unknown sandbox {sandbox_id!r}")
            sb.status = "paused"

    async def kill_sandbox(self, *, sandbox_id: str) -> None:
        if self._fail_on == "kill":
            raise RuntimeError("fake e2b kill failure")
        async with self._lock:
            sb = self._sandboxes.get(sandbox_id)
            if sb is None:
                # Idempotent — kill of a never-seen sandbox is fine.
                return
            sb.status = "killed"


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class E2BCloudDaemonProvider:
    """E2B-backed cloud daemon provider."""

    PROVIDER_NAME = "e2b"

    def __init__(
        self,
        *,
        client: E2BSandboxClient,
        template_id: str = E2B_TEMPLATE_ID,
        default_region: str | None = E2B_DEFAULT_REGION,
        sandbox_timeout_seconds: int = E2B_SANDBOX_TIMEOUT_SECONDS,
        hub_public_base_url: str = HUB_PUBLIC_BASE_URL,
        deepseek_api_key: str | None = None,
        startup_command: str = CLOUD_DAEMON_STARTUP_COMMAND,
        daemon_npm_spec: str = CLOUD_DAEMON_NPM_SPEC,
        sandbox_lifecycle: dict[str, Any] | None = None,
    ) -> None:
        self._client = client
        self._template_id = template_id
        self._default_region = default_region
        self._sandbox_timeout_seconds = sandbox_timeout_seconds
        self._hub_public_base_url = hub_public_base_url
        self._startup_command = startup_command
        self._daemon_npm_spec = daemon_npm_spec
        self._sandbox_lifecycle = (
            dict(sandbox_lifecycle)
            if sandbox_lifecycle is not None
            else {"on_timeout": "pause", "auto_resume": False}
        )
        # Allow tests to inject a key; otherwise default to Hub config.
        self._deepseek_api_key = (
            deepseek_api_key if deepseek_api_key is not None else DEEPSEEK_API_KEY
        )

    # ------------------------------------------------------------------
    # CloudDaemonProvider protocol
    # ------------------------------------------------------------------

    async def create_or_resume(
        self,
        *,
        cloud_daemon_instance_id: str,
        daemon_instance_id: str,
        user_id: str,
        runtime: str,
        region: str | None = None,
        provider_sandbox_id: str | None = None,
        extra_env: dict[str, str] | None = None,
        launch_token: str | None = None,
    ) -> CloudDaemonHandle:
        # A fresh cloud-daemon-access token on every start/resume so a
        # leaked token expires quickly; the daemon picks it up from the
        # environment on (re)boot.
        token, _ = _create_cloud_daemon_access_token(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id=daemon_instance_id,
            user_id=user_id,
            launch_token=launch_token,
        )
        env = self._build_env(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id=daemon_instance_id,
            access_token=token,
            extra_env=extra_env,
        )

        chosen_region = region or self._default_region

        try:
            if provider_sandbox_id is not None:
                # Existing sandbox: try resume first; fall back to create
                # if E2B reports the sandbox is gone.
                try:
                    run = await self._client.resume_sandbox(
                        sandbox_id=provider_sandbox_id,
                        env=env,
                        timeout_seconds=self._sandbox_timeout_seconds,
                    )
                except LookupError:
                    logger.info(
                        "e2b sandbox %s gone; recreating", provider_sandbox_id
                    )
                    run = await self._client.create_sandbox(
                        template_id=self._template_id,
                        env=env,
                        region=chosen_region,
                        timeout_seconds=self._sandbox_timeout_seconds,
                        lifecycle=self._sandbox_lifecycle,
                    )
            else:
                run = await self._client.create_sandbox(
                    template_id=self._template_id,
                    env=env,
                    region=chosen_region,
                    timeout_seconds=self._sandbox_timeout_seconds,
                    lifecycle=self._sandbox_lifecycle,
                )

            # Launch (or relaunch) the daemon as a background process. This
            # is required even when E2B resumes an already-running sandbox:
            # the daemon's singleton startup path stops the old process and
            # the new process reconnects with the fresh JWT/launch token.
            await self._client.run_command(
                sandbox_id=run.sandbox_id,
                command=self._startup_command,
                env=env,
                background=True,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "e2b create_or_resume failed: cloud=%s err=%s",
                cloud_daemon_instance_id,
                exc,
            )
            return CloudDaemonHandle(
                cloud_daemon_instance_id=cloud_daemon_instance_id,
                daemon_instance_id=daemon_instance_id,
                provider=self.PROVIDER_NAME,
                status="failed",
                runtime=runtime,
                region=chosen_region,
                provider_sandbox_id=provider_sandbox_id,
                provider_template_id=self._template_id,
                error_code="e2b_create_failed",
                error_message=str(exc),
            )

        # The sandbox is up. The Cloud Agent is not "ready" until the
        # daemon's hello frame lands on /cloud/daemon/ws — PR 5 transitions
        # ``starting`` → ``ready`` from the WS handler.
        return CloudDaemonHandle(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id=daemon_instance_id,
            provider=self.PROVIDER_NAME,
            status="starting",
            runtime=runtime,
            region=chosen_region,
            provider_sandbox_id=run.sandbox_id,
            provider_template_id=run.template_id,
        )

    async def pause(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        if not provider_sandbox_id:
            return CloudDaemonHandle(
                cloud_daemon_instance_id=cloud_daemon_instance_id,
                daemon_instance_id="",
                provider=self.PROVIDER_NAME,
                status="paused",
                runtime="",
            )
        try:
            await self._client.pause_sandbox(sandbox_id=provider_sandbox_id)
        except LookupError:
            logger.warning(
                "e2b pause of missing sandbox %s; treating as already-paused",
                provider_sandbox_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "e2b pause failed: sandbox=%s err=%s", provider_sandbox_id, exc
            )
            return CloudDaemonHandle(
                cloud_daemon_instance_id=cloud_daemon_instance_id,
                daemon_instance_id="",
                provider=self.PROVIDER_NAME,
                status="failed",
                runtime="",
                provider_sandbox_id=provider_sandbox_id,
                error_code="e2b_pause_failed",
                error_message=str(exc),
            )
        return CloudDaemonHandle(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id="",
            provider=self.PROVIDER_NAME,
            status="paused",
            runtime="",
            provider_sandbox_id=provider_sandbox_id,
        )

    async def cleanup(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        if provider_sandbox_id:
            try:
                await self._client.kill_sandbox(sandbox_id=provider_sandbox_id)
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "e2b kill failed: sandbox=%s err=%s",
                    provider_sandbox_id,
                    exc,
                )
                # Cleanup is best-effort: surface the error but keep state
                # heading toward deleted so the user isn't stuck with a
                # zombie row.
                return CloudDaemonHandle(
                    cloud_daemon_instance_id=cloud_daemon_instance_id,
                    daemon_instance_id="",
                    provider=self.PROVIDER_NAME,
                    status="deleted",
                    runtime="",
                    provider_sandbox_id=provider_sandbox_id,
                    error_code="e2b_kill_failed",
                    error_message=str(exc),
                )
        return CloudDaemonHandle(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id="",
            provider=self.PROVIDER_NAME,
            status="deleted",
            runtime="",
            provider_sandbox_id=provider_sandbox_id,
        )

    async def status(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        # PR 4 does not probe E2B for state — callers use the persisted
        # row + WS last_seen_at. Stub returns ``starting`` if we have a
        # sandbox id, else ``deleted``.
        status = "starting" if provider_sandbox_id else "deleted"
        return CloudDaemonHandle(
            cloud_daemon_instance_id=cloud_daemon_instance_id,
            daemon_instance_id="",
            provider=self.PROVIDER_NAME,
            status=status,
            runtime="",
            provider_sandbox_id=provider_sandbox_id,
        )

    # ------------------------------------------------------------------
    # Env builder
    # ------------------------------------------------------------------

    def _build_env(
        self,
        *,
        cloud_daemon_instance_id: str,
        daemon_instance_id: str,
        access_token: str,
        extra_env: dict[str, str] | None = None,
    ) -> dict[str, str]:
        env: dict[str, str] = {
            "BOTCORD_HUB_URL": self._hub_public_base_url,
            "BOTCORD_CLOUD_DAEMON_INSTANCE_ID": cloud_daemon_instance_id,
            "BOTCORD_DAEMON_INSTANCE_ID": daemon_instance_id,
            "BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN": access_token,
            "CLOUD_DAEMON_NPM_SPEC": self._daemon_npm_spec,
        }
        if self._deepseek_api_key:
            env["DEEPSEEK_API_KEY"] = self._deepseek_api_key
        if extra_env:
            env.update({key: value for key, value in extra_env.items() if value})
        return env


# ---------------------------------------------------------------------------
# Factory used by the provider registry
# ---------------------------------------------------------------------------


def build_default_e2b_provider() -> E2BCloudDaemonProvider:
    """Construct the production E2B provider.

    Raises ``RuntimeError`` if ``E2B_API_KEY`` isn't set — the caller (the
    registry) treats that as "this environment can't run e2b" and surfaces
    a clear error if someone tries to use the provider.
    """
    if not E2B_API_KEY:
        raise RuntimeError(
            "E2B_API_KEY is not set; cannot construct E2BCloudDaemonProvider"
        )
    client = _E2BSdkClient(api_key=E2B_API_KEY)
    return E2BCloudDaemonProvider(client=client)

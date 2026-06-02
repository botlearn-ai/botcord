"""Cloud daemon provider interface + in-memory fake implementation.

The provider is the only place that talks to a sandbox vendor (E2B in the
real deployment, an in-memory map in tests / local dev). Everything above
this layer — the API router, the service, the WS dispatch — sees only
``CloudDaemonHandle`` and the small protocol below.

See ``docs/cloud-agent-technical-design.md`` §7.2 / §7.3.
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class CloudDaemonHandle:
    """Provider-level view of a cloud daemon's current state.

    Mirrors a subset of the ``cloud_daemon_instances`` columns the service
    persists; the service treats the provider's view as authoritative on
    every transition.
    """

    cloud_daemon_instance_id: str
    daemon_instance_id: str
    provider: str
    status: str  # creating | starting | ready | paused | failed | deleted
    runtime: str
    provider_sandbox_id: str | None = None
    provider_template_id: str | None = None
    region: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class CloudDaemonProvider(Protocol):
    """Lifecycle hooks for a cloud daemon sandbox.

    Implementations must be idempotent: calling ``create_or_resume`` twice
    for the same ``cloud_daemon_instance_id`` must yield the same sandbox,
    not a new one. Same for ``pause`` / ``cleanup`` — re-entering an
    already-terminal state is a no-op.
    """

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
    ) -> CloudDaemonHandle:
        ...

    async def pause(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        ...

    async def cleanup(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        ...

    async def status(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        ...


# ---------------------------------------------------------------------------
# In-memory fake — used by PR 3 service tests, PR 5 service tests, and any
# local dev environment without an E2B account.
# ---------------------------------------------------------------------------


@dataclass
class _FakeSandbox:
    """Mutable in-memory record for a fake sandbox."""

    handle: CloudDaemonHandle
    create_calls: int = 0
    pause_calls: int = 0
    cleanup_calls: int = 0


class FakeCloudDaemonProvider:
    """In-memory cloud daemon provider for tests and local dev.

    The provider name is intentionally ``fake`` so accidentally pointing a
    production stack at it shows up clearly in ``cloud_daemon_instances``
    rows (``provider`` column).
    """

    PROVIDER_NAME = "fake"

    def __init__(
        self,
        *,
        force_create_failure: bool = False,
        force_create_status: str = "ready",
    ) -> None:
        # Knobs are kept simple — tests that need richer behavior can swap
        # the instance for a subclass or monkeypatch a single method.
        self._force_create_failure = force_create_failure
        self._force_create_status = force_create_status
        self._sandboxes: dict[str, _FakeSandbox] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Test introspection
    # ------------------------------------------------------------------

    def calls(self, cloud_daemon_instance_id: str) -> dict[str, int]:
        sb = self._sandboxes.get(cloud_daemon_instance_id)
        if sb is None:
            return {"create": 0, "pause": 0, "cleanup": 0}
        return {
            "create": sb.create_calls,
            "pause": sb.pause_calls,
            "cleanup": sb.cleanup_calls,
        }

    def all_sandboxes(self) -> dict[str, CloudDaemonHandle]:
        return {k: v.handle for k, v in self._sandboxes.items()}

    # ------------------------------------------------------------------
    # Provider protocol
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
    ) -> CloudDaemonHandle:
        # ``provider_sandbox_id`` is accepted for protocol parity with the
        # E2B provider — the in-memory map already keys on cloud id.
        async with self._lock:
            sb = self._sandboxes.get(cloud_daemon_instance_id)
            if sb is not None:
                sb.create_calls += 1
                # Resume: clear paused/failed and bring it back to ready.
                if sb.handle.status in {"paused", "failed"}:
                    sb.handle.status = "ready"
                    sb.handle.error_code = None
                    sb.handle.error_message = None
                return sb.handle

            if self._force_create_failure:
                handle = CloudDaemonHandle(
                    cloud_daemon_instance_id=cloud_daemon_instance_id,
                    daemon_instance_id=daemon_instance_id,
                    provider=self.PROVIDER_NAME,
                    status="failed",
                    runtime=runtime,
                    region=region,
                    error_code="fake_create_failed",
                    error_message="FakeCloudDaemonProvider was configured to fail create_or_resume",
                )
            else:
                handle = CloudDaemonHandle(
                    cloud_daemon_instance_id=cloud_daemon_instance_id,
                    daemon_instance_id=daemon_instance_id,
                    provider=self.PROVIDER_NAME,
                    status=self._force_create_status,
                    runtime=runtime,
                    region=region,
                    provider_sandbox_id=f"fake_sb_{secrets.token_hex(8)}",
                    provider_template_id="fake_template_default",
                )
            self._sandboxes[cloud_daemon_instance_id] = _FakeSandbox(
                handle=handle, create_calls=1
            )
            return handle

    async def pause(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        async with self._lock:
            sb = self._sandboxes.get(cloud_daemon_instance_id)
            if sb is None:
                raise LookupError(
                    f"unknown cloud daemon {cloud_daemon_instance_id!r}"
                )
            sb.pause_calls += 1
            if sb.handle.status not in {"deleted", "deleting"}:
                sb.handle.status = "paused"
            return sb.handle

    async def cleanup(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        async with self._lock:
            sb = self._sandboxes.get(cloud_daemon_instance_id)
            if sb is None:
                # Idempotent: cleanup of a never-seen sandbox returns a
                # synthetic "deleted" handle so callers can mark rows
                # without reaching into provider internals.
                return CloudDaemonHandle(
                    cloud_daemon_instance_id=cloud_daemon_instance_id,
                    daemon_instance_id="",
                    provider=self.PROVIDER_NAME,
                    status="deleted",
                    runtime="",
                )
            sb.cleanup_calls += 1
            sb.handle.status = "deleted"
            return sb.handle

    async def status(
        self,
        *,
        cloud_daemon_instance_id: str,
        provider_sandbox_id: str | None = None,
    ) -> CloudDaemonHandle:
        sb = self._sandboxes.get(cloud_daemon_instance_id)
        if sb is None:
            raise LookupError(
                f"unknown cloud daemon {cloud_daemon_instance_id!r}"
            )
        return sb.handle


# ---------------------------------------------------------------------------
# Provider registry — picked up by the service at runtime via config.
# ---------------------------------------------------------------------------

_PROVIDERS: dict[str, CloudDaemonProvider] = {}


def register_provider(name: str, provider: CloudDaemonProvider) -> None:
    """Register/replace a provider implementation by name."""
    _PROVIDERS[name] = provider


def get_provider(name: str) -> CloudDaemonProvider:
    """Look up a provider by name, lazy-creating standard implementations."""
    if name not in _PROVIDERS:
        if name == FakeCloudDaemonProvider.PROVIDER_NAME:
            _PROVIDERS[name] = FakeCloudDaemonProvider()
        elif name == "e2b":
            # Lazy import: the e2b module pulls in the SDK on construction,
            # which we don't want to do at hub.main import time.
            from hub.services.cloud_daemon_provider_e2b import (
                build_default_e2b_provider,
            )

            _PROVIDERS[name] = build_default_e2b_provider()
        else:
            raise KeyError(
                f"no CloudDaemonProvider registered for {name!r}; "
                "available: " + ", ".join(sorted(_PROVIDERS)) or "<none>"
            )
    return _PROVIDERS[name]


def reset_providers_for_tests() -> None:
    """Test-only: drop the registry so the next ``get_provider`` lazy-creates."""
    _PROVIDERS.clear()

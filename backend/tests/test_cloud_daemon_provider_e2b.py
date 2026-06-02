"""Tests for the E2B cloud daemon provider — PR 4."""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import Base, CloudDaemonInstance
from hub.routers.cloud_daemon_control import (
    _create_cloud_daemon_access_token,
    _verify_cloud_daemon_access_token,
)
from hub.services.cloud_agent import (
    CloudAgentService,
    CreateCloudAgentInput,
)
from hub.services.cloud_daemon_provider_e2b import (
    CLOUD_DAEMON_STARTUP_COMMAND,
    E2BCloudDaemonProvider,
    FakeE2BSandboxClient,
    _E2BSdkClient,
)
from tests.test_app.conftest import create_test_engine


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


def _make_provider(
    *,
    client: FakeE2BSandboxClient | None = None,
    deepseek_api_key: str | None = "ds-secret",
    startup_command: str = CLOUD_DAEMON_STARTUP_COMMAND,
    daemon_npm_spec: str = "@botcord/daemon@latest",
) -> tuple[E2BCloudDaemonProvider, FakeE2BSandboxClient]:
    client = client or FakeE2BSandboxClient()
    provider = E2BCloudDaemonProvider(
        client=client,
        template_id="tpl_test_default",
        default_region="us-east-1",
        sandbox_timeout_seconds=120,
        hub_public_base_url="https://hub.test",
        deepseek_api_key=deepseek_api_key,
        startup_command=startup_command,
        daemon_npm_spec=daemon_npm_spec,
    )
    return provider, client


# ---------------------------------------------------------------------------
# create_or_resume
# ---------------------------------------------------------------------------


def test_default_startup_command_prefers_configured_npm_spec():
    """Default launch should not prefer a stale daemon baked into the template."""
    # Shell-level `ps | grep | kill` is intentionally NOT present: its
    # grep pattern matches the wrapping shell's own command line, so it
    # ends up killing its own parent. The daemon's in-process singleton
    # (`packages/daemon/src/daemon-singleton.ts`) is the source of truth.
    assert "old_pids=" not in CLOUD_DAEMON_STARTUP_COMMAND
    assert "kill -TERM" not in CLOUD_DAEMON_STARTUP_COMMAND
    assert "npm_config_prefer_online=true" in CLOUD_DAEMON_STARTUP_COMMAND
    assert "case \"${CLOUD_DAEMON_NPM_SPEC:-}\"" in CLOUD_DAEMON_STARTUP_COMMAND
    assert "exec npm exec --yes --package @botcord/daemon@latest --" in (
        CLOUD_DAEMON_STARTUP_COMMAND
    )
    assert "exec npm exec --yes --package \"$CLOUD_DAEMON_NPM_SPEC\" --" in (
        CLOUD_DAEMON_STARTUP_COMMAND
    )
    assert "bundled)" in CLOUD_DAEMON_STARTUP_COMMAND
    assert "\"\") if command -v botcord-daemon" not in CLOUD_DAEMON_STARTUP_COMMAND


@pytest.mark.asyncio
async def test_create_or_resume_starts_sandbox_and_injects_env():
    """Provider creates a sandbox, injects token + DeepSeek key, runs daemon."""
    provider, client = _make_provider()
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_aaa",
        daemon_instance_id="dm_bbb",
        user_id=str(uuid.uuid4()),
        runtime="deepseek-tui",
    )
    assert handle.status == "starting"
    assert handle.provider == "e2b"
    assert handle.provider_sandbox_id is not None
    assert handle.provider_template_id == "tpl_test_default"
    assert handle.region == "us-east-1"

    sandbox = client.get(handle.provider_sandbox_id)
    assert sandbox is not None
    assert sandbox.template_id == "tpl_test_default"
    assert sandbox.lifecycle == {"on_timeout": "pause", "auto_resume": False}
    assert sandbox.commands == [CLOUD_DAEMON_STARTUP_COMMAND]
    assert len(sandbox.command_runs) == 1
    assert sandbox.command_runs[0].command == CLOUD_DAEMON_STARTUP_COMMAND
    assert sandbox.command_runs[0].background is True

    # Env vars carry the WS connection info + secrets.
    env = sandbox.env
    assert env["BOTCORD_HUB_URL"] == "https://hub.test"
    assert env["BOTCORD_CLOUD_DAEMON_INSTANCE_ID"] == "cloud_dm_aaa"
    assert env["BOTCORD_DAEMON_INSTANCE_ID"] == "dm_bbb"
    assert env["DEEPSEEK_API_KEY"] == "ds-secret"
    assert env["CLOUD_DAEMON_NPM_SPEC"] == "@botcord/daemon@latest"

    # And the injected access token is a valid cloud-daemon-access JWT.
    claims = _verify_cloud_daemon_access_token(env["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"])
    assert claims["cloud_daemon_instance_id"] == "cloud_dm_aaa"
    assert claims["daemon_instance_id"] == "dm_bbb"
    assert sandbox.command_runs[0].env == env


@pytest.mark.asyncio
async def test_create_or_resume_uses_configured_startup_command():
    """Provider can launch a purpose-built image with a custom entrypoint."""
    provider, client = _make_provider(
        startup_command="/usr/local/bin/start-cloud-daemon"
    )
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_cmd",
        daemon_instance_id="dm_cmd",
        user_id=str(uuid.uuid4()),
        runtime="deepseek-tui",
    )

    sandbox = client.get(handle.provider_sandbox_id)
    assert sandbox is not None
    assert sandbox.commands == ["/usr/local/bin/start-cloud-daemon"]


@pytest.mark.asyncio
async def test_create_or_resume_skips_deepseek_env_when_no_key():
    """If DEEPSEEK_API_KEY isn't set, don't push an empty value into the env."""
    provider, client = _make_provider(deepseek_api_key=None)
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_nokey",
        daemon_instance_id="dm_nokey",
        user_id=str(uuid.uuid4()),
        runtime="deepseek-tui",
    )
    sandbox = client.get(handle.provider_sandbox_id)
    assert sandbox is not None
    assert "DEEPSEEK_API_KEY" not in sandbox.env


@pytest.mark.asyncio
async def test_create_or_resume_injects_extra_runtime_env():
    """Per-user runtime env is forwarded to the sandbox and can override fallbacks."""
    provider, client = _make_provider(deepseek_api_key="fallback-ds-key")
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_newapi",
        daemon_instance_id="dm_newapi",
        user_id=str(uuid.uuid4()),
        runtime="deepseek-tui",
        extra_env={
            "OPENAI_API_KEY": "sk-user",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
            "DEEPSEEK_API_KEY": "sk-user",
        },
    )
    sandbox = client.get(handle.provider_sandbox_id)
    assert sandbox is not None
    assert sandbox.env["OPENAI_API_KEY"] == "sk-user"
    assert sandbox.env["OPENAI_BASE_URL"] == "https://new-api.test/v1"
    assert sandbox.env["DEEPSEEK_API_KEY"] == "sk-user"


@pytest.mark.asyncio
async def test_create_or_resume_injects_launch_token_claim():
    provider, client = _make_provider()
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_launch",
        daemon_instance_id="dm_launch",
        user_id=str(uuid.uuid4()),
        runtime="deepseek-tui",
        launch_token="launch-token-1",
    )

    sandbox = client.get(handle.provider_sandbox_id)
    assert sandbox is not None
    claims = _verify_cloud_daemon_access_token(
        sandbox.env["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
    )
    assert claims["cloud_daemon_launch_token"] == "launch-token-1"


@pytest.mark.asyncio
async def test_resume_uses_existing_sandbox_when_provider_sandbox_id_supplied():
    """Same cloud_daemon_id + existing sandbox id triggers resume, not create."""
    provider, client = _make_provider()
    first = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_res",
        daemon_instance_id="dm_res",
        user_id="u",
        runtime="deepseek-tui",
    )
    second = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_res",
        daemon_instance_id="dm_res",
        user_id="u",
        runtime="deepseek-tui",
        provider_sandbox_id=first.provider_sandbox_id,
    )
    assert second.provider_sandbox_id == first.provider_sandbox_id
    # Only one sandbox record exists — resume reuses it.
    assert len(client.all()) == 1
    sandbox = client.get(first.provider_sandbox_id)
    assert sandbox is not None
    # Resume still relaunches the daemon in the existing sandbox so it can
    # replace the paused process with the currently published npm package.
    assert sandbox.commands == [
        CLOUD_DAEMON_STARTUP_COMMAND,
        CLOUD_DAEMON_STARTUP_COMMAND,
    ]


@pytest.mark.asyncio
async def test_relaunch_token_restarts_existing_sandbox_with_fresh_jwt():
    """A tokened relaunch reuses the sandbox but starts a fresh daemon process."""
    provider, client = _make_provider()
    first = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_relaunch",
        daemon_instance_id="dm_relaunch",
        user_id="u",
        runtime="deepseek-tui",
    )
    second = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_relaunch",
        daemon_instance_id="dm_relaunch",
        user_id="u",
        runtime="deepseek-tui",
        provider_sandbox_id=first.provider_sandbox_id,
        launch_token="launch-token-2",
    )

    assert second.status == "starting"
    assert second.provider_sandbox_id == first.provider_sandbox_id
    assert len(client.all()) == 1
    sandbox = client.get(first.provider_sandbox_id)
    assert sandbox is not None
    assert sandbox.commands == [
        CLOUD_DAEMON_STARTUP_COMMAND,
        CLOUD_DAEMON_STARTUP_COMMAND,
    ]
    assert len(sandbox.command_runs) == 2

    first_command_env = sandbox.command_runs[0].env
    relaunch_command_env = sandbox.command_runs[1].env
    assert relaunch_command_env != first_command_env
    assert (
        relaunch_command_env["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
        != first_command_env["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
    )
    # The fake intentionally keeps the sandbox-level env from the original
    # create call, matching existing E2B sandboxes that may preserve stale env.
    # The restarted daemon must therefore receive the fresh token through the
    # run_command envs, not by relying on mutating sandbox.env.
    assert sandbox.env == first_command_env
    claims = _verify_cloud_daemon_access_token(
        relaunch_command_env["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
    )
    assert claims["cloud_daemon_launch_token"] == "launch-token-2"


@pytest.mark.asyncio
async def test_resume_falls_back_to_create_when_sandbox_missing():
    """If E2B has lost the sandbox, the provider transparently recreates."""
    provider, client = _make_provider()
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_lost",
        daemon_instance_id="dm_lost",
        user_id="u",
        runtime="deepseek-tui",
        provider_sandbox_id="sbx_does_not_exist",
    )
    assert handle.status == "starting"
    assert handle.provider_sandbox_id is not None
    assert handle.provider_sandbox_id != "sbx_does_not_exist"


@pytest.mark.asyncio
async def test_create_failure_returns_failed_handle():
    """SDK error on create maps to a failed handle, not a raise."""
    client = FakeE2BSandboxClient(fail_on="create")
    provider, _ = _make_provider(client=client)
    handle = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_fail",
        daemon_instance_id="dm_fail",
        user_id="u",
        runtime="deepseek-tui",
    )
    assert handle.status == "failed"
    assert handle.error_code == "e2b_create_failed"


# ---------------------------------------------------------------------------
# pause / cleanup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pause_marks_sandbox_paused():
    provider, client = _make_provider()
    created = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_pause",
        daemon_instance_id="dm_pause",
        user_id="u",
        runtime="deepseek-tui",
    )
    paused = await provider.pause(
        cloud_daemon_instance_id="cloud_dm_pause",
        provider_sandbox_id=created.provider_sandbox_id,
    )
    assert paused.status == "paused"
    assert client.get(created.provider_sandbox_id).status == "paused"


@pytest.mark.asyncio
async def test_pause_without_sandbox_id_is_noop():
    provider, client = _make_provider()
    paused = await provider.pause(cloud_daemon_instance_id="cloud_dm_x")
    assert paused.status == "paused"
    assert client.all() == []


@pytest.mark.asyncio
async def test_cleanup_kills_sandbox():
    provider, client = _make_provider()
    created = await provider.create_or_resume(
        cloud_daemon_instance_id="cloud_dm_kill",
        daemon_instance_id="dm_kill",
        user_id="u",
        runtime="deepseek-tui",
    )
    deleted = await provider.cleanup(
        cloud_daemon_instance_id="cloud_dm_kill",
        provider_sandbox_id=created.provider_sandbox_id,
    )
    assert deleted.status == "deleted"
    assert client.get(created.provider_sandbox_id).status == "killed"


@pytest.mark.asyncio
async def test_cleanup_without_sandbox_id_is_idempotent():
    provider, _ = _make_provider()
    handle = await provider.cleanup(cloud_daemon_instance_id="cloud_dm_unused")
    assert handle.status == "deleted"


# ---------------------------------------------------------------------------
# Service-level integration — CloudAgentService driving the e2b provider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_service_create_then_pause_then_resume_with_e2b_provider(db_session):
    """Round-trip the full lifecycle through the e2b provider + fake SDK."""
    client = FakeE2BSandboxClient()
    e2b_provider, _ = _make_provider(client=client)
    service = CloudAgentService(
        provider=e2b_provider,
        feature_enabled=True,
        max_per_user=2,
        max_agents_per_daemon=1,
    )

    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="Cloud Bot")
    )
    # The e2b provider reports ``starting`` after create; PR 5 will
    # transition to ``ready`` once the WS hello lands. For PR 4 we accept
    # the persisted state as starting.
    assert view.cloud_daemon_status == "starting"
    assert view.provider == "e2b"
    assert view.provider_sandbox_id is not None

    # Pause uses the persisted provider_sandbox_id.
    paused = await service.pause_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert paused.cloud_daemon_status == "paused"
    assert client.get(view.provider_sandbox_id).status == "paused"

    # Resume re-enters create_or_resume with the persisted sandbox id —
    # the fake SDK round-trips the same sandbox record.
    resumed = await service.resume_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert resumed.cloud_daemon_status == "starting"
    assert resumed.provider_sandbox_id == view.provider_sandbox_id
    assert client.get(view.provider_sandbox_id).status == "running"

    # Delete tears the sandbox down.
    deleted = await service.delete_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert deleted.cloud_daemon_status == "deleted"
    assert client.get(view.provider_sandbox_id).status == "killed"


@pytest.mark.asyncio
async def test_service_persists_provider_sandbox_id(db_session):
    """The sandbox id returned by the provider must land on the row."""
    client = FakeE2BSandboxClient()
    e2b_provider, _ = _make_provider(client=client)
    service = CloudAgentService(
        provider=e2b_provider,
        feature_enabled=True,
        max_per_user=1,
    )
    view = await service.create_cloud_agent(
        db_session, user_id=uuid.uuid4(), body=CreateCloudAgentInput(name="A")
    )

    from sqlalchemy import select

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert cdi is not None
    assert cdi.provider_sandbox_id == view.provider_sandbox_id
    assert cdi.provider_template_id == "tpl_test_default"
    assert cdi.region == "us-east-1"


# ---------------------------------------------------------------------------
# _E2BSdkClient — real SDK adapter, exercised with a faked ``e2b`` module
# ---------------------------------------------------------------------------


class _FakeAsyncSandboxHandle:
    """Minimal stand-in for ``e2b.AsyncSandbox`` instances."""

    def __init__(self, sandbox_id: str, commands: "_FakeCommands") -> None:
        self.sandbox_id = sandbox_id
        self.commands = commands


class _FakeCommands:
    def __init__(self, record: list[dict]) -> None:
        self._record = record

    async def run(self, cmd, background=None, envs=None, timeout=None, **_kwargs):
        self._record.append(
            {"cmd": cmd, "background": background, "envs": envs, "timeout": timeout}
        )
        # Background commands return a handle without waiting; we just
        # return a sentinel — _E2BSdkClient discards the value.
        return object()


class _FakeAsyncSandboxClass:
    """Replacement for ``e2b.AsyncSandbox`` with class-level methods."""

    create_calls: list[dict] = []
    connect_calls: list[dict] = []
    pause_calls: list[dict] = []
    kill_calls: list[dict] = []
    command_calls: list[dict] = []

    # Behavior toggles set by tests.
    next_create_id: str = "sbx_real_001"
    connect_raises_not_found: bool = False
    kill_returns_false: bool = False
    pause_raises_not_found: bool = False
    create_raises: Exception | None = None

    @classmethod
    def reset(cls) -> None:
        cls.create_calls = []
        cls.connect_calls = []
        cls.pause_calls = []
        cls.kill_calls = []
        cls.command_calls = []
        cls.next_create_id = "sbx_real_001"
        cls.connect_raises_not_found = False
        cls.kill_returns_false = False
        cls.pause_raises_not_found = False
        cls.create_raises = None

    @classmethod
    async def create(cls, *, template=None, timeout=None, envs=None, **opts):
        cls.create_calls.append(
            {"template": template, "timeout": timeout, "envs": envs, "opts": opts}
        )
        if cls.create_raises is not None:
            raise cls.create_raises
        return _FakeAsyncSandboxHandle(
            sandbox_id=cls.next_create_id, commands=_FakeCommands(cls.command_calls)
        )

    @classmethod
    async def connect(cls, sandbox_id, timeout=None, **opts):
        cls.connect_calls.append(
            {"sandbox_id": sandbox_id, "timeout": timeout, "opts": opts}
        )
        if cls.connect_raises_not_found:
            raise _FakeSandboxNotFoundException(f"sandbox {sandbox_id} not found")
        return _FakeAsyncSandboxHandle(
            sandbox_id=sandbox_id, commands=_FakeCommands(cls.command_calls)
        )

    @classmethod
    async def pause(cls, sandbox_id, **opts):
        cls.pause_calls.append({"sandbox_id": sandbox_id, "opts": opts})
        if cls.pause_raises_not_found:
            raise _FakeSandboxNotFoundException(f"sandbox {sandbox_id} not found")

    @classmethod
    async def kill(cls, sandbox_id, **opts) -> bool:
        cls.kill_calls.append({"sandbox_id": sandbox_id, "opts": opts})
        return not cls.kill_returns_false


class _FakeSandboxException(Exception):
    pass


class _FakeSandboxNotFoundException(_FakeSandboxException):
    pass


class _FakeE2BModule:
    """Object with the same surface ``_E2BSdkClient`` reaches into."""

    AsyncSandbox = _FakeAsyncSandboxClass
    SandboxException = _FakeSandboxException
    SandboxNotFoundException = _FakeSandboxNotFoundException


@pytest.fixture
def fake_e2b_sdk_client(monkeypatch):
    """Patch ``_E2BSdkClient`` to consult our ``_FakeE2BModule``."""
    _FakeAsyncSandboxClass.reset()
    client = _E2BSdkClient.__new__(_E2BSdkClient)
    client._api_key = "ek_test_apikey"  # type: ignore[attr-defined]
    client._e2b = _FakeE2BModule  # type: ignore[attr-defined]
    return client


@pytest.mark.asyncio
async def test_sdk_client_create_sandbox_forwards_args(fake_e2b_sdk_client):
    """create_sandbox → AsyncSandbox.create with template / timeout / envs / api_key."""
    _FakeAsyncSandboxClass.next_create_id = "sbx_alpha"
    run = await fake_e2b_sdk_client.create_sandbox(
        template_id="tpl-x",
        env={"FOO": "bar"},
        region="us-east-1",
        timeout_seconds=600,
        lifecycle={"on_timeout": "pause", "auto_resume": False},
    )
    assert run.sandbox_id == "sbx_alpha"
    assert run.template_id == "tpl-x"
    assert run.region == "us-east-1"
    assert run.started is True

    assert len(_FakeAsyncSandboxClass.create_calls) == 1
    call = _FakeAsyncSandboxClass.create_calls[0]
    assert call["template"] == "tpl-x"
    assert call["timeout"] == 600
    assert call["envs"] == {"FOO": "bar"}
    assert call["opts"]["lifecycle"] == {
        "on_timeout": "pause",
        "auto_resume": False,
    }
    assert call["opts"]["api_key"] == "ek_test_apikey"


@pytest.mark.asyncio
async def test_sdk_client_run_command_forwards_envs(fake_e2b_sdk_client):
    """run_command forwards fresh per-command envs to the SDK command runner."""
    token_1, _ = _create_cloud_daemon_access_token(
        "cloud_dm_sdk", "dm_sdk", "user", launch_token="launch-token-1"
    )
    token_2, _ = _create_cloud_daemon_access_token(
        "cloud_dm_sdk", "dm_sdk", "user", launch_token="launch-token-2"
    )
    env_1 = {
        "BOTCORD_HUB_URL": "https://hub.test",
        "BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN": token_1,
    }
    env_2 = {
        "BOTCORD_HUB_URL": "https://hub.test",
        "BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN": token_2,
    }

    await fake_e2b_sdk_client.run_command(
        sandbox_id="sbx_alpha",
        command=CLOUD_DAEMON_STARTUP_COMMAND,
        env=env_1,
        background=True,
    )
    await fake_e2b_sdk_client.run_command(
        sandbox_id="sbx_alpha",
        command=CLOUD_DAEMON_STARTUP_COMMAND,
        env=env_2,
        background=True,
    )

    assert len(_FakeAsyncSandboxClass.connect_calls) == 2
    assert _FakeAsyncSandboxClass.connect_calls[0]["sandbox_id"] == "sbx_alpha"
    assert _FakeAsyncSandboxClass.connect_calls[0]["timeout"] == 0
    assert _FakeAsyncSandboxClass.connect_calls[1]["sandbox_id"] == "sbx_alpha"
    assert _FakeAsyncSandboxClass.connect_calls[1]["timeout"] == 0

    assert len(_FakeAsyncSandboxClass.command_calls) == 2
    first_cmd = _FakeAsyncSandboxClass.command_calls[0]
    second_cmd = _FakeAsyncSandboxClass.command_calls[1]
    assert first_cmd["cmd"] == CLOUD_DAEMON_STARTUP_COMMAND
    assert second_cmd["cmd"] == CLOUD_DAEMON_STARTUP_COMMAND
    assert first_cmd["background"] is True
    assert second_cmd["background"] is True
    assert first_cmd["envs"] == env_1
    assert second_cmd["envs"] == env_2
    assert first_cmd["envs"] != second_cmd["envs"]
    first_claims = _verify_cloud_daemon_access_token(
        first_cmd["envs"]["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
    )
    second_claims = _verify_cloud_daemon_access_token(
        second_cmd["envs"]["BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN"]
    )
    assert first_claims["cloud_daemon_launch_token"] == "launch-token-1"
    assert second_claims["cloud_daemon_launch_token"] == "launch-token-2"
    # Background daemons must outlive the SDK-side connection; the e2b SDK's
    # default 60s connection timeout would otherwise have envd terminate the
    # orphaned process exactly one minute after boot.
    assert first_cmd["timeout"] == 0
    assert second_cmd["timeout"] == 0


@pytest.mark.asyncio
async def test_sdk_client_resume_returns_handle(fake_e2b_sdk_client):
    """resume_sandbox connects through to the SDK and returns the same id."""
    run = await fake_e2b_sdk_client.resume_sandbox(
        sandbox_id="sbx_beta",
        env={"X": "1"},
        timeout_seconds=120,
    )
    assert run.sandbox_id == "sbx_beta"
    assert run.started is True
    assert _FakeAsyncSandboxClass.connect_calls[0]["sandbox_id"] == "sbx_beta"
    assert _FakeAsyncSandboxClass.connect_calls[0]["timeout"] == 120


@pytest.mark.asyncio
async def test_sdk_client_resume_raises_lookup_error_when_missing(fake_e2b_sdk_client):
    """resume_sandbox maps SandboxNotFoundException → LookupError."""
    _FakeAsyncSandboxClass.connect_raises_not_found = True
    with pytest.raises(LookupError):
        await fake_e2b_sdk_client.resume_sandbox(
            sandbox_id="sbx_gone",
            env={},
            timeout_seconds=120,
        )


@pytest.mark.asyncio
async def test_sdk_client_kill_is_idempotent_when_already_gone(fake_e2b_sdk_client):
    """kill_sandbox returns cleanly even when the SDK reports 'already gone'."""
    _FakeAsyncSandboxClass.kill_returns_false = True
    # Must not raise.
    await fake_e2b_sdk_client.kill_sandbox(sandbox_id="sbx_zombie")
    assert _FakeAsyncSandboxClass.kill_calls[0]["sandbox_id"] == "sbx_zombie"


@pytest.mark.asyncio
async def test_sdk_client_pause_maps_missing_to_lookup_error(fake_e2b_sdk_client):
    """pause_sandbox surfaces a missing sandbox as LookupError for the provider."""
    _FakeAsyncSandboxClass.pause_raises_not_found = True
    with pytest.raises(LookupError):
        await fake_e2b_sdk_client.pause_sandbox(sandbox_id="sbx_gone")


@pytest.mark.asyncio
async def test_sdk_client_create_wraps_sdk_exception(fake_e2b_sdk_client):
    """A generic SDK error becomes RuntimeError so it can't leak out."""
    _FakeAsyncSandboxClass.create_raises = _FakeSandboxException("api down")
    with pytest.raises(RuntimeError, match="api down"):
        await fake_e2b_sdk_client.create_sandbox(
            template_id="tpl-x",
            env={},
            region=None,
            timeout_seconds=60,
            lifecycle={"on_timeout": "pause", "auto_resume": False},
        )

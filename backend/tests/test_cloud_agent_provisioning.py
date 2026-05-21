"""PR 5: tests for the create→provision→ready closure.

Covers the path where the E2B provider returns ``starting`` and the
agent only flips to ``ready`` after a successful ``provision_agent``
ack on ``/cloud/daemon/ws``.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
)
from hub.routers.cloud_daemon_control import (
    CloudDaemonDispatchError,
    _CloudDaemonConn,
    _registry_for_tests,
    send_cloud_control_frame,
)
from hub.services.cloud_agent import (
    CloudAgentService,
    CreateCloudAgentInput,
)
from hub.services.cloud_daemon_provider_e2b import (
    E2BCloudDaemonProvider,
    FakeE2BSandboxClient,
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeWS:
    """Stand-in for the cloud daemon's WebSocket."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed_with: tuple[int, str] | None = None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


async def _register_fake_conn(
    cloud_daemon_instance_id: str,
    daemon_instance_id: str,
) -> tuple[_CloudDaemonConn, _FakeWS]:
    ws = _FakeWS()
    conn = _CloudDaemonConn(
        ws=ws,
        user_id="u",
        cloud_daemon_instance_id=cloud_daemon_instance_id,
        daemon_instance_id=daemon_instance_id,
    )
    await _registry_for_tests().register(conn)
    return conn, ws


async def _ack_frame_when_sent(
    conn: _CloudDaemonConn,
    ws: _FakeWS,
    *,
    ack_ok: bool = True,
    error: dict | None = None,
    expected_type: str | None = None,
) -> dict:
    """Wait for a frame to land on the fake WS, then resolve its ack future."""
    for _ in range(100):
        if ws.sent:
            break
        await asyncio.sleep(0.01)
    assert ws.sent, "no frame was dispatched"
    sent = json.loads(ws.sent[-1])
    if expected_type:
        assert sent["type"] == expected_type
    fut = conn.pending_acks.get(sent["id"])
    assert fut is not None, "frame has no pending ack future"
    payload: dict = {"id": sent["id"], "ok": ack_ok}
    if not ack_ok and error is not None:
        payload["error"] = error
    fut.set_result(payload)
    return sent


def _make_e2b_service(*, max_agents_per_daemon: int = 2) -> CloudAgentService:
    return CloudAgentService(
        provider=E2BCloudDaemonProvider(
            client=FakeE2BSandboxClient(),
            template_id="tpl_test",
            default_region="us-east-1",
            sandbox_timeout_seconds=120,
            hub_public_base_url="https://hub.test",
            deepseek_api_key=None,
        ),
        feature_enabled=True,
        max_per_user=5,
        max_agents_per_daemon=max_agents_per_daemon,
    )


# ---------------------------------------------------------------------------
# Frame dispatcher
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_cloud_control_frame_offline_raises():
    """Dispatch must raise when no cloud daemon is connected."""
    with pytest.raises(CloudDaemonDispatchError) as excinfo:
        await send_cloud_control_frame(
            "cloud_dm_does_not_exist", "ping", {}, timeout_ms=100
        )
    assert excinfo.value.code == "cloud_daemon_offline"


@pytest.mark.asyncio
async def test_send_cloud_control_frame_round_trips_ack():
    conn, ws = await _register_fake_conn("cloud_dm_round", "dm_round")
    try:
        async def _resolver():
            await _ack_frame_when_sent(conn, ws, expected_type="ping")

        resolver = asyncio.create_task(_resolver())
        ack = await send_cloud_control_frame(
            "cloud_dm_round", "ping", {"hello": "world"}, timeout_ms=2000
        )
        await resolver
        assert ack["ok"] is True
        sent_frame = json.loads(ws.sent[0])
        assert sent_frame["type"] == "ping"
        assert sent_frame["params"] == {"hello": "world"}
        assert "sig" in sent_frame
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_send_cloud_control_frame_timeout_raises():
    conn, _ = await _register_fake_conn("cloud_dm_timeout", "dm_timeout")
    try:
        with pytest.raises(CloudDaemonDispatchError) as excinfo:
            await send_cloud_control_frame(
                "cloud_dm_timeout", "ping", {}, timeout_ms=100
            )
        assert excinfo.value.code == "cloud_daemon_ack_timeout"
        # Pending future was cleared so the next frame can be dispatched.
        assert not conn.pending_acks
    finally:
        await _registry_for_tests().unregister(conn)


# ---------------------------------------------------------------------------
# Service create + provision flow (E2B provider returns ``starting``)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2b_create_leaves_agent_provisioning_with_stashed_key(db_session):
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    assert view.status == "provisioning"
    assert view.cloud_daemon_status == "starting"

    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    assert cai is not None
    provisioning = (cai.metadata_json or {}).get("provisioning")
    assert isinstance(provisioning, dict)
    assert provisioning["private_key_b64"]
    assert provisioning["public_key_b64"]
    assert provisioning["key_id"]


@pytest.mark.asyncio
async def test_provision_pending_dispatches_provision_agent_and_marks_ready(
    db_session,
):
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    conn, ws = await _register_fake_conn(
        view.cloud_daemon_instance_id, "dm_unused"
    )
    try:
        # Drive the provision_agent dispatch + ack concurrently.
        async def _ack_when_sent():
            sent = await _ack_frame_when_sent(
                conn, ws, expected_type="provision_agent"
            )
            params = sent["params"]
            # Frame must carry the full credential envelope.
            creds = params["credentials"]
            assert creds["agentId"] == view.agent_id
            assert creds["privateKey"]
            assert creds["publicKey"]
            assert creds["keyId"]
            assert creds["hubUrl"].startswith("http")
            assert creds["token"]
            assert creds["runtime"] == "deepseek-tui"
            assert params["runtime"] == "deepseek-tui"
            assert params["name"] == "A"

        ack_task = asyncio.create_task(_ack_when_sent())
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        await ack_task

        refreshed = await service.get_cloud_agent(
            db_session, user_id=user_id, agent_id=view.agent_id
        )
        assert refreshed.status == "ready"
        assert refreshed.cloud_daemon_status == "ready"

        # Private key was scrubbed.
        cai = await db_session.scalar(
            select(CloudAgentInstance).where(
                CloudAgentInstance.agent_id == view.agent_id
            )
        )
        assert "provisioning" not in (cai.metadata_json or {})
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_provision_dispatch_ack_false_leaves_provisioning(db_session):
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    conn, ws = await _register_fake_conn(view.cloud_daemon_instance_id, "dm_x")
    try:
        async def _ack():
            await _ack_frame_when_sent(
                conn,
                ws,
                ack_ok=False,
                error={"code": "deepseek_unavailable", "message": "no key"},
                expected_type="provision_agent",
            )

        t = asyncio.create_task(_ack())
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        await t

        refreshed = await service.get_cloud_agent(
            db_session, user_id=user_id, agent_id=view.agent_id
        )
        assert refreshed.status == "provisioning"
        assert refreshed.error_code == "deepseek_unavailable"
        assert refreshed.error_message == "no key"
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_resume_ready_agent_offline_rotates_key_for_reprovision(db_session):
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    conn, ws = await _register_fake_conn(view.cloud_daemon_instance_id, "dm_resume")
    try:
        t = asyncio.create_task(
            _ack_frame_when_sent(conn, ws, expected_type="provision_agent")
        )
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        await t
    finally:
        await _registry_for_tests().unregister(conn)

    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    assert cai is not None
    assert "provisioning" not in (cai.metadata_json or {})

    resumed = await service.resume_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert resumed.status == "provisioning"
    assert resumed.cloud_daemon_status == "starting"

    refreshed = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    provisioning = (refreshed.metadata_json or {}).get("provisioning")
    assert provisioning["private_key_b64"]
    assert provisioning["public_key_b64"]
    assert provisioning["key_id"]


@pytest.mark.asyncio
async def test_provision_dispatch_offline_records_error(db_session):
    """provision drain with no daemon connected stamps an error, no exception."""
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    # No conn registered -> dispatch raises CloudDaemonDispatchError ->
    # service records error and returns.
    await service.provision_pending_for_cloud_daemon(
        db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
    )
    refreshed = await service.get_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert refreshed.status == "provisioning"
    assert refreshed.error_code == "cloud_daemon_offline"


@pytest.mark.asyncio
async def test_provision_pending_multi_agent_round_trip(db_session):
    """Two Cloud Agents on the same daemon both reach ready (§11)."""
    service = _make_e2b_service(max_agents_per_daemon=3)
    user_id = uuid.uuid4()
    a = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id

    conn, ws = await _register_fake_conn(a.cloud_daemon_instance_id, "dm_y")
    try:
        async def _ack_two():
            seen: set[str] = set()
            for _ in range(2):
                for _ in range(100):
                    pending = [
                        f for f in ws.sent if json.loads(f)["id"] not in seen
                    ]
                    if pending:
                        break
                    await asyncio.sleep(0.01)
                else:
                    raise AssertionError("expected a second provision_agent frame")
                sent = json.loads(pending[0])
                assert sent["type"] == "provision_agent"
                seen.add(sent["id"])
                fut = conn.pending_acks.get(sent["id"])
                assert fut is not None
                fut.set_result({"id": sent["id"], "ok": True})

        task = asyncio.create_task(_ack_two())
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=a.cloud_daemon_instance_id
        )
        await task

        ra = await service.get_cloud_agent(
            db_session, user_id=user_id, agent_id=a.agent_id
        )
        rb = await service.get_cloud_agent(
            db_session, user_id=user_id, agent_id=b.agent_id
        )
        assert ra.status == "ready"
        assert rb.status == "ready"
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_provision_drain_is_noop_when_nothing_pending(db_session):
    """The drain must tolerate cloud daemons with no provisioning agents."""
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    conn, ws = await _register_fake_conn(view.cloud_daemon_instance_id, "dm_z")
    try:
        # Provision once.
        t = asyncio.create_task(
            _ack_frame_when_sent(conn, ws, expected_type="provision_agent")
        )
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        await t
        ws.sent.clear()

        # Second drain should send nothing.
        results = await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        assert results == []
        assert ws.sent == []
    finally:
        await _registry_for_tests().unregister(conn)


# ---------------------------------------------------------------------------
# Delete + revoke_agent dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_dispatches_revoke_agent_when_daemon_online(db_session):
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    # Bring the agent to ready first so delete operates on a stable state.
    conn, ws = await _register_fake_conn(view.cloud_daemon_instance_id, "dm_d")
    try:
        prov_task = asyncio.create_task(
            _ack_frame_when_sent(conn, ws, expected_type="provision_agent")
        )
        await service.provision_pending_for_cloud_daemon(
            db_session, cloud_daemon_instance_id=view.cloud_daemon_instance_id
        )
        await prov_task
        ws.sent.clear()

        # Delete now: expect revoke_agent frame with the right agentId.
        del_ack = asyncio.create_task(
            _ack_frame_when_sent(conn, ws, expected_type="revoke_agent")
        )
        deleted = await service.delete_cloud_agent(
            db_session, user_id=user_id, agent_id=view.agent_id
        )
        await del_ack
        assert deleted.status == "deleted"
        sent = json.loads(ws.sent[-1])
        assert sent["params"]["agentId"] == view.agent_id
    finally:
        await _registry_for_tests().unregister(conn)


@pytest.mark.asyncio
async def test_delete_is_resilient_when_daemon_offline(db_session):
    """Delete must not require an online daemon."""
    service = _make_e2b_service()
    user_id = uuid.uuid4()
    view = await service.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    deleted = await service.delete_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert deleted.status == "deleted"
    assert deleted.cloud_daemon_status == "deleted"

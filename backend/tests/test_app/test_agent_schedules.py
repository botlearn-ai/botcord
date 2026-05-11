import datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import AgentSchedule
from hub.services.agent_schedules import compute_next_fire_at

from .test_app_user_agents import client, db_engine, db_session, seed_user  # noqa: F401


@pytest.mark.asyncio
async def test_dashboard_can_create_patch_run_and_delete_schedule(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    token = seed_user["token"]
    headers = {"Authorization": f"Bearer {token}"}

    create_resp = await client.post(
        "/api/agents/ag_agent001/schedules",
        headers=headers,
        json={
            "name": "botcord-auto",
            "enabled": True,
            "schedule": {"kind": "every", "every_ms": 300000},
            "payload": {
                "kind": "agent_turn",
                "message": "【BotCord 自主任务】执行本轮工作目标。",
            },
        },
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["name"] == "botcord-auto"
    assert created["schedule"]["every_ms"] == 300000
    assert created["next_fire_at"]

    list_resp = await client.get("/api/agents/ag_agent001/schedules", headers=headers)
    assert list_resp.status_code == 200
    assert [row["id"] for row in list_resp.json()["schedules"]] == [created["id"]]

    patch_resp = await client.patch(
        f"/api/agents/ag_agent001/schedules/{created['id']}",
        headers=headers,
        json={"enabled": False},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["enabled"] is False
    assert patch_resp.json()["next_fire_at"] is None

    run_resp = await client.post(
        f"/api/agents/ag_agent001/schedules/{created['id']}/run",
        headers=headers,
    )
    assert run_resp.status_code == 200
    run = run_resp.json()
    assert run["status"] == "failed"
    assert run["error"] == "agent_not_hosted"

    runs_resp = await client.get(
        f"/api/agents/ag_agent001/schedules/{created['id']}/runs",
        headers=headers,
    )
    assert runs_resp.status_code == 200
    assert runs_resp.json()["runs"][0]["id"] == run["id"]

    delete_resp = await client.delete(
        f"/api/agents/ag_agent001/schedules/{created['id']}",
        headers=headers,
    )
    assert delete_resp.status_code == 204
    remaining = (await db_session.execute(select(AgentSchedule))).scalars().all()
    assert remaining == []


@pytest.mark.asyncio
async def test_schedule_rejects_too_short_interval(
    client: AsyncClient,
    seed_user: dict,
):
    resp = await client.post(
        "/api/agents/ag_agent001/schedules",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
        json={
            "name": "too-fast",
            "enabled": True,
            "schedule": {"kind": "every", "every_ms": 60000},
            "payload": {"kind": "agent_turn", "message": "tick"},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "schedule_interval_too_short"


@pytest.mark.asyncio
async def test_dashboard_can_create_daily_calendar_schedule(
    client: AsyncClient,
    seed_user: dict,
):
    resp = await client.post(
        "/api/agents/ag_agent001/schedules",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
        json={
            "name": "daily-brief",
            "enabled": True,
            "schedule": {
                "kind": "calendar",
                "frequency": "daily",
                "time": "09:30",
                "timezone": "Asia/Shanghai",
            },
            "payload": {"kind": "agent_turn", "message": "brief"},
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["schedule"] == {
        "kind": "calendar",
        "frequency": "daily",
        "time": "09:30",
        "timezone": "Asia/Shanghai",
    }
    assert body["next_fire_at"]


def test_compute_next_fire_at_for_daily_calendar_schedule():
    base = datetime.datetime(2026, 5, 11, 0, 0, tzinfo=datetime.timezone.utc)
    next_fire = compute_next_fire_at(
        {
            "kind": "calendar",
            "frequency": "daily",
            "time": "09:30",
            "timezone": "Asia/Shanghai",
        },
        base=base,
    )
    assert next_fire == datetime.datetime(2026, 5, 11, 1, 30, tzinfo=datetime.timezone.utc)


def test_compute_next_fire_at_for_weekly_calendar_schedule():
    base = datetime.datetime(2026, 5, 11, 2, 0, tzinfo=datetime.timezone.utc)
    next_fire = compute_next_fire_at(
        {
            "kind": "calendar",
            "frequency": "weekly",
            "time": "09:30",
            "timezone": "Asia/Shanghai",
            "weekdays": [0, 2],
        },
        base=base,
    )
    assert next_fire == datetime.datetime(2026, 5, 13, 1, 30, tzinfo=datetime.timezone.utc)


@pytest.mark.asyncio
async def test_manual_run_records_failed_ack(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
    monkeypatch,
):
    import hub.routers.openclaw_control as openclaw_control

    async def fake_send_host_control_frame(*_args, **_kwargs):
        return {
            "id": "frame_1",
            "ok": False,
            "error": {"code": "agent_not_loaded", "message": "not loaded"},
        }

    monkeypatch.setattr(openclaw_control, "send_host_control_frame", fake_send_host_control_frame)
    seed_user["agent1"].hosting_kind = "plugin"
    seed_user["agent1"].openclaw_host_id = "oc_test"
    await db_session.commit()

    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create_resp = await client.post(
        "/api/agents/ag_agent001/schedules",
        headers=headers,
        json={
            "name": "botcord-auto",
            "enabled": True,
            "schedule": {"kind": "every", "every_ms": 300000},
            "payload": {"kind": "agent_turn", "message": "tick"},
        },
    )
    assert create_resp.status_code == 201
    schedule_id = create_resp.json()["id"]

    run_resp = await client.post(
        f"/api/agents/ag_agent001/schedules/{schedule_id}/run",
        headers=headers,
    )
    assert run_resp.status_code == 200
    body = run_resp.json()
    assert body["status"] == "failed"
    assert body["error"] == "agent_not_loaded: not loaded"

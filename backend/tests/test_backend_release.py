"""Deployment ordering and failure recovery without cloud access."""
from types import SimpleNamespace

import pytest

from scripts import deploy_backend as release


def setup_release(monkeypatch, *, migrate=True, fail=None):
    calls = []
    runtime = SimpleNamespace(old_image="old", tag="runtime", env={})
    runtime.stop = lambda: calls.append("stop")
    runtime.start = lambda: calls.append("start")

    def verify(image):
        calls.append(f"verify:{image}")
        if fail == "health" and image == "new":
            raise RuntimeError("unhealthy")

    def gate(image, mode, runtime, state):
        calls.append(f"gate:{image}:{mode}")
        if mode == fail:
            raise RuntimeError("gate failed")
        return {"needs_migration": migrate}

    runtime.verify = verify
    monkeypatch.setattr(release, "gate", gate)
    monkeypatch.setattr(release, "promote", lambda image, tag: calls.append(f"promote:{image}"))
    return calls, runtime


def test_first_upgrade_stops_writers_before_schema_and_promotes_after_backfill(monkeypatch, tmp_path):
    calls, runtime = setup_release(monkeypatch)
    release.deploy(runtime, "new", tmp_path)
    assert calls == ["gate:new:preflight", "gate:old:validate", "stop", "gate:new:snapshot", "gate:new:apply",
                     "promote:new", "start", "verify:new"]


def test_already_migrated_runtime_does_not_take_maintenance_window(monkeypatch, tmp_path):
    calls, runtime = setup_release(monkeypatch, migrate=False)
    release.deploy(runtime, "new", tmp_path)
    assert calls == ["gate:new:preflight", "promote:new", "start", "verify:new"]


@pytest.mark.parametrize("failure", ["apply", "health"])
def test_failed_upgrade_restores_old_capture_and_backfills_before_restart(monkeypatch, tmp_path, failure):
    calls, runtime = setup_release(monkeypatch, fail=failure)
    with pytest.raises(RuntimeError):
        release.deploy(runtime, "new", tmp_path)
    assert calls[-6:] == ["stop", "gate:new:restore", "gate:old:backfill-old", "promote:old", "start", "verify:old"]


@pytest.mark.parametrize("failure", ["preflight", "validate", "snapshot"])
def test_pre_migration_failures_never_restore_nonexistent_snapshot(monkeypatch, tmp_path, failure):
    calls, runtime = setup_release(monkeypatch, fail=failure)
    with pytest.raises(RuntimeError):
        release.deploy(runtime, "new", tmp_path)
    assert "gate:new:apply" not in calls and "gate:new:restore" not in calls
    if failure in {"preflight", "validate"}:
        assert "stop" not in calls
    else:
        assert calls[-3:] == ["promote:old", "start", "verify:old"]


@pytest.mark.parametrize("image", [release.REPO + ":prod", "other@sha256:" + "a" * 64,
                                  release.REPO + "@sha256:bad"])
def test_rejects_mutable_or_unregistered_image(image):
    with pytest.raises(RuntimeError):
        release.validate_image(image)


def test_accepts_fixed_repository_digest():
    release.validate_image(release.REPO + "@sha256:" + "a" * 64)


def test_generic_sql_runner_refuses_uncoordinated_018(monkeypatch, tmp_path, capsys):
    from scripts import run_sql_migrations as migrations
    (tmp_path / "018_incremental_conversation_projection.sql").write_text("SELECT 1;")
    cursor = SimpleNamespace(execute=lambda *a: None, fetchall=lambda: [], close=lambda: None)
    connection = SimpleNamespace(cursor=lambda: cursor, close=lambda: None)
    monkeypatch.setattr(migrations, "MIGRATIONS_DIR", tmp_path)
    monkeypatch.setattr(migrations.psycopg2, "connect", lambda *a: connection)
    monkeypatch.setattr(migrations, "_run_psql_file", lambda *a: pytest.fail("018 must not execute here"))
    with pytest.raises(SystemExit) as error:
        migrations.main()
    assert error.value.code == 1
    assert "coordinated backend deployment gate" in capsys.readouterr().err


def test_subprocess_failure_logs_only_safe_gate_diagnostic(monkeypatch, capsys):
    result = SimpleNamespace(returncode=1, stdout="private-source-value",
        stderr="private-connection-value\nConversation release gate failed: GateError: Unsupported baseline\n")
    monkeypatch.setattr(release.subprocess, "run", lambda *args, **kwargs: result)
    with pytest.raises(RuntimeError):
        release.run("docker", "run", "candidate", input="private-runtime-config")
    output = capsys.readouterr()
    assert "Unsupported baseline" in output.err
    assert "private" not in output.err + output.out

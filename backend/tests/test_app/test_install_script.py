"""Smoke + integration tests for backend/static/openclaw/install.sh.

The script itself is bash + an embedded Node.js block that talks to the
hub. We don't run the full hub here (Phase 1 covers that); instead we
stand up a stub HTTP server that mimics ``/api/users/me/agents/install-claim``
and assert the script's *client-side* behaviour:

- argument parsing
- Ed25519 keygen + nonce signing
- request body shape sent to the server
- credentials.json contents and 0600 mode
- openclaw.json patch shape (with and without --account)

Skipped when ``node`` is not on PATH.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

INSTALL_SH = Path(__file__).resolve().parents[2] / "static" / "openclaw" / "install.sh"
DAEMON_INSTALL_SH = Path(__file__).resolve().parents[2] / "static" / "daemon" / "install.sh"


# ---------------------------------------------------------------------------
# Bash-only sanity checks (always run)
# ---------------------------------------------------------------------------


def test_install_sh_syntax_ok():
    assert INSTALL_SH.is_file(), f"missing {INSTALL_SH}"
    proc = subprocess.run(
        ["bash", "-n", str(INSTALL_SH)], capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr


def test_install_sh_help_exits_zero():
    proc = subprocess.run(
        ["bash", str(INSTALL_SH), "--help"], capture_output=True, text=True
    )
    assert proc.returncode == 0
    assert "--bind-code" in proc.stdout
    assert "--bind-nonce" in proc.stdout


def test_install_sh_missing_args_exits_nonzero(tmp_path: Path):
    proc = subprocess.run(
        ["bash", str(INSTALL_SH)],
        capture_output=True,
        text=True,
        env={"HOME": str(tmp_path), "PATH": os.environ["PATH"]},
    )
    assert proc.returncode != 0
    assert "--bind-code" in proc.stderr or "--bind-code" in proc.stdout


def test_daemon_install_sh_syntax_ok():
    assert DAEMON_INSTALL_SH.is_file(), f"missing {DAEMON_INSTALL_SH}"
    proc = subprocess.run(
        ["bash", "-n", str(DAEMON_INSTALL_SH)], capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr


def test_daemon_install_sh_help_exits_zero():
    proc = subprocess.run(
        ["sh", str(DAEMON_INSTALL_SH), "--help"], capture_output=True, text=True
    )
    assert proc.returncode == 0
    assert "--hub" in proc.stdout
    assert "@botcord/daemon@latest" in proc.stdout


# ---------------------------------------------------------------------------
# Stub server fixture
# ---------------------------------------------------------------------------


class _StubServerState:
    last_path: str | None = None
    last_method: str | None = None
    last_body: dict | None = None
    response_body: dict
    response_status: int


def _make_stub_handler(state: _StubServerState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args, **kwargs):  # silence
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length", "0") or "0")
            raw = self.rfile.read(length) if length else b""
            try:
                state.last_body = json.loads(raw.decode()) if raw else {}
            except json.JSONDecodeError:
                state.last_body = {"_raw": raw.decode("utf-8", "replace")}
            state.last_path = self.path
            state.last_method = "POST"

            payload = json.dumps(state.response_body).encode()
            self.send_response(state.response_status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


@pytest.fixture
def stub_server():
    if shutil.which("node") is None:
        pytest.skip("node not available")
    state = _StubServerState()
    state.response_status = 201
    state.response_body = {}

    # Bind to an OS-assigned free port on localhost.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    server = HTTPServer(("127.0.0.1", port), _make_stub_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"state": state, "url": f"http://127.0.0.1:{port}", "port": port}
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# Full client-side flow (skip plugin install + restart so we don't need
# npm registry access, openclaw, or a real HOME).
# ---------------------------------------------------------------------------


def _sample_claim_response(agent_id: str = "ag_stub00000001") -> dict:
    return {
        "agent_id": agent_id,
        "key_id": "k_stubkey00001",
        "agent_token": "stub.jwt.token",
        "token_expires_at": 1900000000,
        "hub_url": "https://hub.example",
        "ws_url": "wss://hub.example/ws",
        "display_name": "Stub Agent",
    }


def _run_install_sh(
    *,
    server_url: str,
    bind_code: str,
    bind_nonce: str,
    home: Path,
    config_path: Path,
    extra: list[str] | None = None,
) -> subprocess.CompletedProcess:
    env = {
        **os.environ,
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "OPENCLAW_BIN": "/bin/false",  # force file-based config path
        "OPENCLAW_CONFIG_PATH": str(config_path),
    }
    (home / "tmp").mkdir(parents=True, exist_ok=True)
    args = [
        "bash",
        str(INSTALL_SH),
        "--bind-code", bind_code,
        "--bind-nonce", bind_nonce,
        "--server-url", server_url,
        "--skip-plugin-install",
        "--skip-restart",
    ]
    if extra:
        args.extend(extra)
    return subprocess.run(args, capture_output=True, text=True, env=env)


def test_install_sh_happy_path_writes_credentials_and_config(
    stub_server, tmp_path: Path
):
    state = stub_server["state"]
    state.response_status = 201
    state.response_body = _sample_claim_response()

    bind_code = "bd_" + uuid.uuid4().hex[:12]
    bind_nonce = base64.b64encode(os.urandom(32)).decode()
    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw" / "openclaw.json"

    proc = _run_install_sh(
        server_url=stub_server["url"],
        bind_code=bind_code,
        bind_nonce=bind_nonce,
        home=home,
        config_path=config_path,
    )
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"

    # 1. The script hit the right endpoint with the expected request shape.
    assert state.last_path == "/api/users/me/agents/install-claim"
    body = state.last_body
    assert body is not None
    assert body["bind_code"] == bind_code
    assert body["pubkey"].startswith("ed25519:")
    assert body["proof"]["nonce"] == bind_nonce
    # Signature is base64; decoded length is 64 bytes for Ed25519.
    sig_raw = base64.b64decode(body["proof"]["sig"])
    assert len(sig_raw) == 64

    # 2. Credentials file written, mode 0600, with all expected fields.
    cred_path = home / ".botcord" / "credentials" / "ag_stub00000001.json"
    assert cred_path.is_file()
    mode = cred_path.stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"

    cred = json.loads(cred_path.read_text())
    assert cred["agentId"] == "ag_stub00000001"
    assert cred["keyId"] == "k_stubkey00001"
    assert cred["hubUrl"] == "https://hub.example"
    assert cred["token"] == "stub.jwt.token"
    assert cred["displayName"] == "Stub Agent"
    # Private key must be a 32-byte base64-encoded Ed25519 seed.
    assert len(base64.b64decode(cred["privateKey"])) == 32
    # And it must derive the pubkey we sent to the server.
    assert f"ed25519:{cred['publicKey']}" == body["pubkey"]

    # 3. openclaw.json patched with channels.botcord.* keys.
    cfg = json.loads(config_path.read_text())
    botcord_cfg = cfg["channels"]["botcord"]
    assert botcord_cfg["enabled"] is True
    assert botcord_cfg["credentialsFile"] == str(cred_path)
    assert botcord_cfg["deliveryMode"] == "websocket"


def test_install_sh_account_namespacing(stub_server, tmp_path: Path):
    state = stub_server["state"]
    state.response_status = 201
    state.response_body = _sample_claim_response("ag_acct000000002")

    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw.json"

    proc = _run_install_sh(
        server_url=stub_server["url"],
        bind_code="bd_" + uuid.uuid4().hex[:12],
        bind_nonce=base64.b64encode(os.urandom(32)).decode(),
        home=home,
        config_path=config_path,
        extra=["--account", "work"],
    )
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"

    cfg = json.loads(config_path.read_text())
    work = cfg["channels"]["botcord"]["accounts"]["work"]
    assert work["enabled"] is True
    assert work["credentialsFile"].endswith("ag_acct000000002.json")
    assert work["deliveryMode"] == "websocket"


def test_install_sh_server_rejects_bind_code(stub_server, tmp_path: Path):
    """When the hub returns 400 INVALID_BIND_CODE the script must abort."""
    state = stub_server["state"]
    state.response_status = 400
    state.response_body = {"detail": "INVALID_BIND_CODE", "error": "INVALID_BIND_CODE"}

    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw.json"

    proc = _run_install_sh(
        server_url=stub_server["url"],
        bind_code="bd_expired00001",
        bind_nonce=base64.b64encode(os.urandom(32)).decode(),
        home=home,
        config_path=config_path,
    )
    assert proc.returncode != 0
    # Nothing should have been written to disk.
    assert not (home / ".botcord" / "credentials").exists() or not any(
        (home / ".botcord" / "credentials").iterdir()
    )
    assert not config_path.exists()


def test_install_sh_claim_failure_preserves_existing_plugin(
    stub_server, tmp_path: Path
):
    """A 400 from install-claim must not displace the user's existing plugin.

    Reproduces the scenario flagged in code review: previously the script
    swapped staging into TARGET_DIR before calling claim, so an expired
    bind code would leave the live install pointing at a fresh checkout
    with no credentials. Now the swap only happens after claim succeeds.
    """
    state = stub_server["state"]
    state.response_status = 400
    state.response_body = {"detail": "INVALID_BIND_CODE", "error": "INVALID_BIND_CODE"}

    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw.json"

    target_dir = home / ".openclaw" / "extensions" / "botcord"
    target_dir.mkdir(parents=True)
    sentinel = target_dir / "package.json"
    sentinel.write_text('{"name": "@botcord/botcord", "version": "previous"}\n')

    # Need to actually exercise the npm-install/swap path, which means we
    # must NOT pass --skip-plugin-install. But we don't want to hit the
    # real npm registry, so feed it an empty tarball via --tgz-path.
    fake_pkg = tmp_path / "fake-pkg"
    (fake_pkg / "package").mkdir(parents=True)
    (fake_pkg / "package" / "package.json").write_text(
        '{"name": "@botcord/botcord", "version": "0.0.0-test"}\n'
    )
    fake_tgz = tmp_path / "fake.tgz"
    subprocess.run(
        ["tar", "-czf", str(fake_tgz), "-C", str(fake_pkg), "package"], check=True
    )

    env = {
        **os.environ,
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "OPENCLAW_BIN": "/bin/false",
        "OPENCLAW_CONFIG_PATH": str(config_path),
    }
    (home / "tmp").mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "bash",
            str(INSTALL_SH),
            "--bind-code", "bd_expired00001",
            "--bind-nonce", base64.b64encode(os.urandom(32)).decode(),
            "--server-url", stub_server["url"],
            "--tgz-path", str(fake_tgz),
            "--force-reinstall",
            "--target-dir", str(target_dir),
            "--skip-restart",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode != 0, "expected non-zero exit on rejected bind code"

    # Live plugin must still be the one we started with.
    assert sentinel.is_file(), "previous plugin install was destroyed"
    assert "previous" in sentinel.read_text()

    # No backup should have been created since we never swapped.
    backups = list(target_dir.parent.glob("botcord.bak.*"))
    assert backups == [], f"unexpected backup created: {backups}"

    # And nothing should have been written to credentials/config either.
    creds_dir = home / ".botcord" / "credentials"
    assert not creds_dir.exists() or not any(creds_dir.iterdir())
    assert not config_path.exists()


def test_install_sh_swap_failure_restores_backup(stub_server, tmp_path: Path):
    """If the second mv (staging → TARGET_DIR) fails, on_exit must
    restore the backup so the user is never left with a missing plugin.

    We trigger the failure with BOTCORD_INSTALL_FAULT=after-backup, a
    test-only hook in install.sh that exits after stashing the existing
    plugin into ``.bak.<ts>`` but before moving staging into place.
    """
    state = stub_server["state"]
    state.response_status = 201
    state.response_body = _sample_claim_response("ag_swapfail000001")

    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw.json"

    # Pre-existing plugin install at TARGET_DIR with a sentinel so we
    # can prove it survives.
    target_dir = home / ".openclaw" / "extensions" / "botcord"
    target_dir.mkdir(parents=True)
    sentinel = target_dir / "package.json"
    sentinel.write_text('{"name": "@botcord/botcord", "version": "previous"}\n')

    # Build a tiny tarball so the script's plugin-install step succeeds.
    fake_pkg = tmp_path / "fake-pkg"
    (fake_pkg / "package").mkdir(parents=True)
    (fake_pkg / "package" / "package.json").write_text(
        '{"name": "@botcord/botcord", "version": "0.0.0-test"}\n'
    )
    fake_tgz = tmp_path / "fake.tgz"
    subprocess.run(
        ["tar", "-czf", str(fake_tgz), "-C", str(fake_pkg), "package"], check=True
    )

    env = {
        **os.environ,
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "OPENCLAW_BIN": "/bin/false",
        "OPENCLAW_CONFIG_PATH": str(config_path),
        "BOTCORD_INSTALL_FAULT": "after-backup",
    }
    (home / "tmp").mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "bash",
            str(INSTALL_SH),
            "--bind-code", "bd_" + uuid.uuid4().hex[:12],
            "--bind-nonce", base64.b64encode(os.urandom(32)).decode(),
            "--server-url", stub_server["url"],
            "--tgz-path", str(fake_tgz),
            "--force-reinstall",
            "--target-dir", str(target_dir),
            "--skip-restart",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode != 0, "fault-injected install must exit non-zero"

    # The user's previous plugin must be back at TARGET_DIR.
    assert sentinel.is_file(), (
        f"sentinel missing after rollback. stdout={proc.stdout}\nstderr={proc.stderr}"
    )
    assert "previous" in sentinel.read_text()

    # And no leftover .bak.* should remain — the rollback moves it back.
    backups = list(target_dir.parent.glob("botcord.bak.*"))
    assert backups == [], f"backup not consumed by rollback: {backups}"


def test_install_sh_passes_intended_name_override(stub_server, tmp_path: Path):
    state = stub_server["state"]
    state.response_status = 201
    state.response_body = _sample_claim_response()

    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "openclaw.json"

    proc = _run_install_sh(
        server_url=stub_server["url"],
        bind_code="bd_" + uuid.uuid4().hex[:12],
        bind_nonce=base64.b64encode(os.urandom(32)).decode(),
        home=home,
        config_path=config_path,
        extra=["--name", "laptop-bot"],
    )
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert state.last_body["name"] == "laptop-bot"

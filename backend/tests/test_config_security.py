"""Startup configuration safety checks isolated from the test process."""

from __future__ import annotations

import os
import subprocess
import sys


def _import_config(**environment: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(environment)
    env.pop("INTERNAL_API_SECRET", None)
    env.pop("BOTCORD_HUB_CONTROL_PRIVATE_KEY", None)
    env.update(environment)
    return subprocess.run(
        [sys.executable, "-c", "import hub.config"],
        capture_output=True,
        check=False,
        env=env,
        text=True,
    )


def test_private_endpoints_require_internal_api_secret():
    result = _import_config(ALLOW_PRIVATE_ENDPOINTS="true")

    assert result.returncode != 0
    assert "ALLOW_PRIVATE_ENDPOINTS requires INTERNAL_API_SECRET" in result.stderr


def test_private_endpoints_accept_configured_internal_api_secret():
    result = _import_config(
        ALLOW_PRIVATE_ENDPOINTS="true",
        INTERNAL_API_SECRET="test-only-internal-secret",
        BOTCORD_HUB_CONTROL_PRIVATE_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    )

    assert result.returncode == 0, result.stderr


def test_legacy_hub_control_private_key_is_rejected():
    result = _import_config(
        ALLOW_PRIVATE_ENDPOINTS="false",
        BOTCORD_HUB_CONTROL_PRIVATE_KEY="R9yHQWAP+oLdwuXW67TGSi/RWbkYPGf1a31by04W1zA=",
    )

    assert result.returncode != 0
    assert "must not use the insecure default seed" in result.stderr


def test_unset_hub_control_private_key_is_rejected():
    result = _import_config(ALLOW_PRIVATE_ENDPOINTS="false")

    assert result.returncode != 0
    assert "BOTCORD_HUB_CONTROL_PRIVATE_KEY must be set" in result.stderr

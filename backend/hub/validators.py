"""Shared validation helpers."""

import base64
import ipaddress
import logging
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from hub.config import ALLOW_PRIVATE_ENDPOINTS, ENDPOINT_PROBE_ENABLED, ENDPOINT_PROBE_TIMEOUT_SECONDS
from hub.schemas import EndpointProbeReport, ProbePathResult

logger = logging.getLogger(__name__)

_BLOCKED_HOSTNAME_SUFFIXES = (".local", ".internal", ".localhost")


def check_agent_ownership(path_agent_id: str, token_agent_id: str) -> None:
    """Verify that the path agent_id matches the JWT agent_id."""
    if path_agent_id != token_agent_id:
        raise HTTPException(status_code=403, detail="Agent ID mismatch")


def parse_pubkey(pubkey: str) -> str:
    """Parse 'ed25519:<base64>' format and return the base64 part.

    Raises HTTPException if format is invalid.
    """
    if not pubkey.startswith("ed25519:"):
        raise HTTPException(status_code=400, detail="pubkey must start with 'ed25519:'")
    b64_part = pubkey[len("ed25519:"):]
    try:
        decoded = base64.b64decode(b64_part)
    except Exception:
        raise HTTPException(status_code=400, detail="pubkey base64 is invalid")
    if len(decoded) != 32:
        raise HTTPException(status_code=400, detail="Ed25519 public key must be 32 bytes")
    return b64_part


def validate_endpoint_url(url: str) -> None:
    """Validate endpoint URL: must be http/https.

    When ``ALLOW_PRIVATE_ENDPOINTS`` is False, also blocks private/loopback IPs
    and known internal hostnames (localhost, *.local, *.internal, *.localhost).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https scheme")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="URL must have a hostname")

    if ALLOW_PRIVATE_ENDPOINTS:
        return

    hostname = parsed.hostname.lower()

    if hostname == "localhost" or any(
        hostname.endswith(suffix) for suffix in _BLOCKED_HOSTNAME_SUFFIXES
    ):
        raise HTTPException(
            status_code=400,
            detail="Private/internal hostnames are not allowed",
        )

    try:
        addr = ipaddress.ip_address(hostname)
        if addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            raise HTTPException(
                status_code=400,
                detail="Private/internal IP addresses are not allowed",
            )
    except ValueError:
        pass


def _hint_for_status(status_code: int) -> str | None:
    """Return an actionable hint for a given HTTP status code."""
    if status_code == 401:
        return "Check that webhook_token matches your OpenClaw hooks.token configuration"
    if status_code == 403:
        return "Check webhook_token permissions and OpenClaw hooks.token configuration"
    if status_code == 404:
        return "Check hooks.mappings in openclaw.json — the path may not be registered"
    if status_code == 400:
        return "Check allowRequestSessionKey and allowedSessionKeyPrefixes in openclaw.json"
    if 500 <= status_code < 600:
        return "Target service returned a server error — check OpenClaw health and logs"
    return None


async def _probe_single_path(
    url: str,
    sub_path: str,
    webhook_token: str,
    timeout: float,
) -> ProbePathResult:
    """Probe a single webhook sub-path. Returns a structured result (never raises)."""
    probe_url = f"{url.rstrip('/')}{sub_path}"
    headers = {"Authorization": f"Bearer {webhook_token}"}
    http_timeout = httpx.Timeout(timeout)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                probe_url,
                json={"probe": True},
                headers=headers,
                timeout=http_timeout,
            )
        if 200 <= resp.status_code < 300:
            logger.info("Probe OK: POST %s -> %d", probe_url, resp.status_code)
            return ProbePathResult(
                path=sub_path,
                ok=True,
                status_code=resp.status_code,
            )
        hint = _hint_for_status(resp.status_code)
        logger.warning("Probe FAIL: POST %s -> %d", probe_url, resp.status_code)
        return ProbePathResult(
            path=sub_path,
            ok=False,
            status_code=resp.status_code,
            error=f"HTTP {resp.status_code}",
            hint=hint,
        )
    except httpx.ConnectError as exc:
        logger.warning("Probe ERROR: POST %s -> ConnectError: %s", probe_url, exc)
        return ProbePathResult(
            path=sub_path,
            ok=False,
            error="Connection refused",
            hint="Check that the target service is running and the URL is reachable",
        )
    except httpx.TimeoutException as exc:
        logger.warning("Probe ERROR: POST %s -> Timeout: %s", probe_url, exc)
        return ProbePathResult(
            path=sub_path,
            ok=False,
            error=f"Timeout after {timeout}s",
            hint="Check network connectivity and target service responsiveness",
        )
    except Exception as exc:
        logger.warning("Probe ERROR: POST %s -> %s: %s", probe_url, type(exc).__name__, exc)
        return ProbePathResult(
            path=sub_path,
            ok=False,
            error=type(exc).__name__,
            hint="Unexpected error — check the endpoint URL format and network",
        )


async def probe_endpoint_detailed(
    url: str, webhook_token: str
) -> EndpointProbeReport:
    """Probe BOTH /botcord_inbox/agent and /botcord_inbox/wake paths.

    Always runs (ignores ENDPOINT_PROBE_ENABLED). Returns a structured report.
    """
    timeout = float(ENDPOINT_PROBE_TIMEOUT_SECONDS)
    agent_result = await _probe_single_path(
        url, "/botcord_inbox/agent", webhook_token, timeout
    )
    wake_result = await _probe_single_path(
        url, "/botcord_inbox/wake", webhook_token, timeout
    )
    all_ok = agent_result.ok and wake_result.ok

    if all_ok:
        summary = "Both paths are reachable and responding correctly"
    elif agent_result.ok and not wake_result.ok:
        summary = f"/botcord_inbox/agent OK, but /botcord_inbox/wake failed: {wake_result.error}"
    elif not agent_result.ok and wake_result.ok:
        summary = f"/botcord_inbox/wake OK, but /botcord_inbox/agent failed: {agent_result.error}"
    else:
        summary = f"Both paths failed — agent: {agent_result.error}, wake: {wake_result.error}"

    return EndpointProbeReport(
        url=url,
        agent_path=agent_result,
        wake_path=wake_result,
        all_ok=all_ok,
        summary=summary,
    )


async def probe_endpoint(url: str, webhook_token: str) -> EndpointProbeReport | None:
    """Probe the endpoint and raise HTTPException(422) on failure.

    Returns None when probing is disabled, EndpointProbeReport on success.
    Raises HTTPException(422) with detailed error+hints on failure.
    """
    if not ENDPOINT_PROBE_ENABLED:
        return None

    report = await probe_endpoint_detailed(url, webhook_token)
    if not report.all_ok:
        # Build detailed error message with hints
        details = [f"Endpoint probe failed: {report.summary}"]
        for result in (report.agent_path, report.wake_path):
            if not result.ok:
                detail = f"  {result.path}: {result.error}"
                if result.hint:
                    detail += f" — {result.hint}"
                details.append(detail)
        raise HTTPException(status_code=422, detail="\n".join(details))

    return report

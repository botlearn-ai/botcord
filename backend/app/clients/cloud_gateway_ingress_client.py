"""
[INPUT]: agent_id / provider / user_id / request_id + provider-specific body
[OUTPUT]: parsed JSON dict from gateway-ingress, or HTTPException on failure
[POS]: Hub→gateway-ingress setup/CRUD client (Phase 2). Replaces the cloud
       daemon control-frame path for ``hosting_kind == "cloud"`` agents.
[PROTOCOL]: see docs/cloud-gateway-ingress-remediation-plan.md §4 + §10.
            The Hub stays the BFF — it forwards only safe envelope fields
            (user_id, hosting_kind, request_id) and never persists raw
            provider secrets returned by the ingress.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx
from fastapi import HTTPException

from hub import config as hub_config

logger = logging.getLogger(__name__)

# Default request timeouts. ingress login/status are short polls (not long
# polls) so 10s is enough headroom for a cold provider call.
DEFAULT_TIMEOUT_SECONDS = 10.0

# Test override hook — pytest injects a fake httpx client here so we avoid
# real network I/O. Production code path always goes through
# ``_default_client_factory`` which builds a fresh AsyncClient per call.
_test_http_client: httpx.AsyncClient | None = None


def set_http_client(client: httpx.AsyncClient | None) -> None:
    """Override the AsyncClient used for ingress calls (test seam)."""
    global _test_http_client
    _test_http_client = client


def _new_request_id() -> str:
    return uuid.uuid4().hex


def _ingress_base_url() -> str:
    base = hub_config.CLOUD_GATEWAY_INGRESS_BASE_URL
    secret = hub_config.CLOUD_GATEWAY_INGRESS_SECRET
    if not base or not secret:
        # 503 (not 500) — operators can repair this with config; it's not a
        # bug in the request. Clean code so the dashboard can show a useful
        # banner instead of "internal error".
        raise HTTPException(
            status_code=503,
            detail="cloud_gateway_ingress_not_configured",
        )
    return base.rstrip("/")


def _ingress_secret() -> str:
    # Guaranteed non-None by ``_ingress_base_url`` having run first.
    secret = hub_config.CLOUD_GATEWAY_INGRESS_SECRET
    assert secret is not None  # for mypy / runtime sanity
    return secret


def _common_envelope(
    *,
    user_id: Any,
    request_id: str | None,
    body: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the canonical request body envelope expected by ingress."""
    payload: dict[str, Any] = dict(body or {})
    payload["user_id"] = str(user_id)
    payload["hosting_kind"] = "cloud"
    payload["request_id"] = request_id or _new_request_id()
    return payload


def _raise_for_ingress_error(
    *,
    method: str,
    path: str,
    response: httpx.Response,
) -> None:
    """Translate ingress error responses into FastAPI HTTPException.

    4xx → propagate the ingress code at the same status. Expected provider
    dependency outages from ingress are mapped to 424 so they do not look like
    Hub/ingress availability incidents. Other 5xx → 502 with a fixed
    ``cloud_gateway_ingress_unavailable`` code.
    """
    parsed: dict[str, Any] | None = None
    try:
        parsed = response.json()
    except Exception:  # pragma: no cover — defensive
        parsed = None

    code = None
    message = None
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            code = err.get("code") if isinstance(err.get("code"), str) else None
            message = err.get("message") if isinstance(err.get("message"), str) else None

    if 400 <= response.status_code < 500:
        # Honor the ingress-chosen status. The detail dict is shaped like the
        # daemon-path error vocabulary (`{"code", "ingress_message"}`) so the
        # frontend can branch on .code uniformly. Falls back to a string
        # detail when the ingress payload was unparseable.
        detail: Any = (
            {"code": code, "ingress_message": message}
            if code is not None
            else "cloud_gateway_ingress_error"
        )
        logger.info(
            "cloud-gateway ingress 4xx: %s %s -> %d code=%s",
            method,
            path,
            response.status_code,
            code,
        )
        raise HTTPException(status_code=response.status_code, detail=detail)

    if code == "provider_unreachable":
        logger.info(
            "cloud-gateway provider unreachable via ingress: %s %s -> %d",
            method,
            path,
            response.status_code,
        )
        raise HTTPException(
            status_code=424,
            detail={"code": "provider_unreachable", "ingress_message": message},
        )

    logger.warning(
        "cloud-gateway ingress 5xx: %s %s -> %d code=%s",
        method,
        path,
        response.status_code,
        code,
    )
    raise HTTPException(
        status_code=502,
        detail={"code": "cloud_gateway_ingress_unavailable", "ingress_code": code},
    )


async def _request(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Perform a single async HTTPS round-trip against gateway-ingress.

    Auth header carries the shared ingress bearer. Never logs the
    Authorization header or any returned secret-shaped field; loggers see
    only the path, method, status code, and ingress error code.
    """
    base = _ingress_base_url()
    secret = _ingress_secret()
    url = f"{base}{path}"
    headers = {"Authorization": f"Bearer {secret}"}

    logger.info("cloud-gateway ingress %s %s", method, path)

    try:
        if _test_http_client is not None:
            response = await _test_http_client.request(
                method, url, headers=headers, json=json_body, timeout=timeout
            )
        else:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.request(
                    method, url, headers=headers, json=json_body
                )
    except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as exc:
        logger.warning(
            "cloud-gateway ingress unreachable: %s %s err=%s",
            method,
            path,
            exc.__class__.__name__,
        )
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        ) from exc
    except httpx.HTTPError as exc:  # pragma: no cover — defensive
        logger.warning(
            "cloud-gateway ingress http error: %s %s err=%s",
            method,
            path,
            exc.__class__.__name__,
        )
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        ) from exc

    if response.status_code >= 400:
        _raise_for_ingress_error(method=method, path=path, response=response)

    try:
        parsed = response.json() if response.content else {}
    except Exception as exc:  # pragma: no cover
        logger.warning(
            "cloud-gateway ingress non-JSON body: %s %s", method, path
        )
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        )
    return parsed


# ---------------------------------------------------------------------------
# Setup (login / discover) endpoints
# ---------------------------------------------------------------------------


async def login_start(
    agent_id: str,
    provider: str,
    *,
    user_id: Any,
    request_id: str | None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=body)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/login/start"
    return await _request("POST", path, json_body=payload)


async def login_status(
    agent_id: str,
    provider: str,
    *,
    user_id: Any,
    request_id: str | None,
    login_id: str,
) -> dict[str, Any]:
    payload = _common_envelope(
        user_id=user_id, request_id=request_id, body={"loginId": login_id}
    )
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/login/status"
    return await _request("POST", path, json_body=payload)


async def discover(
    agent_id: str,
    provider: str,
    *,
    user_id: Any,
    request_id: str | None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=body)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/discover"
    return await _request("POST", path, json_body=payload)


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------


async def create_gateway(
    agent_id: str,
    *,
    user_id: Any,
    request_id: str | None,
    body: dict[str, Any],
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=body)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways"
    return await _request("POST", path, json_body=payload)


async def patch_gateway(
    agent_id: str,
    gateway_id: str,
    *,
    user_id: Any,
    request_id: str | None,
    body: dict[str, Any],
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=body)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}"
    return await _request("PATCH", path, json_body=payload)


async def delete_gateway(
    agent_id: str,
    gateway_id: str,
    *,
    user_id: Any,
    request_id: str | None,
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=None)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}"
    return await _request("DELETE", path, json_body=payload)


async def test_gateway(
    agent_id: str,
    gateway_id: str,
    *,
    user_id: Any,
    request_id: str | None,
) -> dict[str, Any]:
    payload = _common_envelope(user_id=user_id, request_id=request_id, body=None)
    path = f"/internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}/test"
    return await _request("POST", path, json_body=payload)

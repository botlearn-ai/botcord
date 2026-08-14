import hashlib
import re
import secrets

from fastapi import Request


_CORRELATION_ID = re.compile(r"^[a-f0-9]{32}$")
_AGENT_ID = re.compile(r"^ag_[a-z0-9]{8,64}$")
_KEY_ID = re.compile(r"^k_[a-z0-9]{8,64}$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$")
_CALLERS = frozenset({"protocol-core"})


def _matching_header(request: Request, name: str, pattern: re.Pattern[str]) -> str | None:
    value = request.headers.get(name)
    return value if value and pattern.fullmatch(value) else None


def _caller_hint(request: Request) -> str | None:
    value = request.headers.get("x-botcord-caller")
    return value if value in _CALLERS else None


def _user_agent_hash(request: Request) -> str | None:
    """Retain equality correlation without logging caller-controlled UA text."""
    value = request.headers.get("user-agent")
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:16]


def request_id_for(request: Request) -> str:
    existing = getattr(request.state, "request_id", None)
    if isinstance(existing, str):
        return existing
    # This is an authoritative server request id. Never let an untrusted
    # header choose it; the caller value is retained separately as a hint.
    request_id = secrets.token_hex(16)
    request.state.request_id = request_id
    return request_id


def auth_failure_context(request: Request, failure: str) -> dict[str, str | None]:
    client = request.client
    return {
        "failure": failure,
        "request_id": request_id_for(request),
        "client_request_id": _matching_header(request, "x-botcord-request-id", _CORRELATION_ID),
        "method": request.method,
        "path": request.url.path,
        "source_ip": client.host if client else None,
        "caller": _caller_hint(request),
        "caller_version": _matching_header(request, "x-botcord-caller-version", _VERSION),
        "agent_id_hint": _matching_header(request, "x-botcord-agent-id", _AGENT_ID),
        # Set only after the Hub has verified the JWT signature and claims.
        # Unlike agent_id_hint, this value is never accepted from a header.
        "verified_agent_id": getattr(request.state, "verified_agent_id", None),
        "credential_key_id": _matching_header(request, "x-botcord-credential-key-id", _KEY_ID),
        "user_agent_hash": _user_agent_hash(request),
    }


def rate_limit_context(request: Request) -> dict[str, str | None]:
    """Safe correlation metadata for a server-issued 429.

    Caller-supplied values are diagnostic hints only; authorization never
    consumes them. Repeated request IDs can therefore identify retries
    without creating a header-trust boundary.
    """
    context = auth_failure_context(request, "rate_limited")
    context["failure"] = "rate_limited"
    context["authenticated_agent_id"] = getattr(
        request.state, "authenticated_agent_id", None
    )
    context["rate_limit_reason"] = getattr(request.state, "rate_limit_reason", None)
    return context

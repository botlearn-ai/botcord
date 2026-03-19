import datetime
import hmac
import json
import secrets
from hashlib import sha256
from base64 import urlsafe_b64decode, urlsafe_b64encode

from hub.config import JWT_SECRET


def _b64url_encode(raw: bytes) -> str:
    return urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _b64url_decode(encoded: str) -> bytes:
    pad = "=" * (-len(encoded) % 4)
    return urlsafe_b64decode((encoded + pad).encode("utf-8"))


def _sign(payload_part: str) -> str:
    mac = hmac.new(JWT_SECRET.encode("utf-8"), payload_part.encode("utf-8"), sha256).digest()
    return _b64url_encode(mac)


def issue_claim_link_token(
    agent_id: str,
    display_name: str,
    ttl_seconds: int = 300,
) -> tuple[str, int]:
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    payload = {
        "aid": agent_id,
        "dn": display_name,
        "iat": now,
        "exp": now + ttl_seconds,
        "jti": secrets.token_hex(12),
    }
    payload_part = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig_part = _sign(payload_part)
    return f"{payload_part}.{sig_part}", payload["exp"]


def verify_claim_link_token(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("invalid_token_format")

    payload_part, sig_part = parts
    expected = _sign(payload_part)
    if not hmac.compare_digest(sig_part, expected):
        raise ValueError("invalid_token_signature")

    try:
        payload = json.loads(_b64url_decode(payload_part).decode("utf-8"))
    except Exception as exc:
        raise ValueError("invalid_token_payload") from exc

    exp = int(payload.get("exp", 0))
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    if exp <= 0 or now > exp:
        raise ValueError("token_expired")

    aid = payload.get("aid")
    if not isinstance(aid, str) or not aid.startswith("ag_"):
        raise ValueError("invalid_agent_id")

    dn = payload.get("dn")
    if not isinstance(dn, str) or not dn.strip():
        payload["dn"] = f"Agent {aid[-6:]}"

    return payload

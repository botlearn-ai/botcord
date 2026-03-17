from __future__ import annotations

import base64
import hashlib
import os
import time

import jcs
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from hub.schemas import Signature


# ---------------------------------------------------------------------------
# Challenge helpers (existing)
# ---------------------------------------------------------------------------


def generate_challenge() -> str:
    """Generate a 32-byte random nonce, return as base64."""
    return base64.b64encode(os.urandom(32)).decode()


def verify_challenge_sig(pubkey_b64: str, challenge_b64: str, sig_b64: str) -> bool:
    """Verify an Ed25519 signature of the challenge bytes."""
    try:
        pubkey_bytes = base64.b64decode(pubkey_b64)
        challenge_bytes = base64.b64decode(challenge_b64)
        sig_bytes = base64.b64decode(sig_b64)
        vk = VerifyKey(pubkey_bytes)
        vk.verify(challenge_bytes, sig_bytes)
        return True
    except (BadSignatureError, ValueError, TypeError):
        return False


# ---------------------------------------------------------------------------
# JCS / payload hash
# ---------------------------------------------------------------------------


def jcs_canonicalize(obj: dict) -> bytes:
    """Return the JCS (RFC 8785) canonical form of *obj*."""
    return jcs.canonicalize(obj)


def compute_payload_hash(payload: dict) -> str:
    """JCS-canonicalize *payload*, SHA-256, return ``"sha256:<hex>"``."""
    canonical = jcs_canonicalize(payload)
    digest = hashlib.sha256(canonical).hexdigest()
    return f"sha256:{digest}"


def verify_payload_hash(payload: dict, expected_hash: str) -> bool:
    """Return True when *expected_hash* matches the computed payload hash."""
    return compute_payload_hash(payload) == expected_hash


# ---------------------------------------------------------------------------
# Signing input
# ---------------------------------------------------------------------------


def build_signing_input(envelope) -> bytes:
    """Build the signing input from envelope fields joined by ``\\n``.

    *envelope* can be a ``MessageEnvelope`` or any object with the required
    attributes (``v``, ``msg_id``, ``ts``, ``from_``, ``to``,
    ``type``, ``reply_to``, ``ttl_sec``, ``payload_hash``).

    For protocol version ``a2a/0.2`` and above, ``topic`` and ``goal`` are
    included in the signing input.  ``a2a/0.1`` retains the original format
    for backward compatibility.
    """
    # ``type`` may be an enum — coerce to its value.
    msg_type = envelope.type
    if hasattr(msg_type, "value"):
        msg_type = msg_type.value

    parts = [
        envelope.v,
        envelope.msg_id,
        str(envelope.ts),
        envelope.from_,
        envelope.to,
        str(msg_type),
        envelope.reply_to or "",
        str(envelope.ttl_sec),
        envelope.payload_hash,
    ]

    # a2a/0.2+: include topic and goal in signing input
    if envelope.v != "a2a/0.1":
        parts.append(getattr(envelope, "topic", None) or "")
        parts.append(getattr(envelope, "goal", None) or "")

    return "\n".join(parts).encode()


# ---------------------------------------------------------------------------
# Sign / verify envelope
# ---------------------------------------------------------------------------


def sign_envelope(envelope, private_key_b64: str, key_id: str) -> Signature:
    """Sign *envelope* and return a ``Signature`` object.

    *private_key_b64* is the base64-encoded 32-byte Ed25519 seed/private key.
    """
    signing_input = build_signing_input(envelope)
    sk = SigningKey(base64.b64decode(private_key_b64))
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()
    return Signature(alg="ed25519", key_id=key_id, value=sig_b64)


def verify_envelope_sig(envelope, pubkey_b64: str) -> bool:
    """Verify the Ed25519 signature on *envelope*.

    Returns True if the signature is valid, False otherwise.
    """
    try:
        signing_input = build_signing_input(envelope)
        sig_bytes = base64.b64decode(envelope.sig.value)
        vk = VerifyKey(base64.b64decode(pubkey_b64))
        vk.verify(signing_input, sig_bytes)
        return True
    except (BadSignatureError, ValueError, TypeError):
        return False


# ---------------------------------------------------------------------------
# Timestamp check
# ---------------------------------------------------------------------------


def check_timestamp(ts: int, max_drift: int = 300) -> bool:
    """Return True if *ts* is within *max_drift* seconds of now."""
    return abs(int(time.time()) - ts) <= max_drift

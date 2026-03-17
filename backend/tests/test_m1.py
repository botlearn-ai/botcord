"""M1 tests — MessageEnvelope, JCS, signing & verification."""

import base64
import time
import uuid

from nacl.signing import SigningKey

from hub.crypto import (
    build_signing_input,
    check_timestamp,
    compute_payload_hash,
    sign_envelope,
    verify_envelope_sig,
    verify_payload_hash,
)
from hub.schemas import MessageEnvelope, MessageType, Signature


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[str, str]:
    """Return (private_key_b64, public_key_b64) for a fresh Ed25519 key."""
    sk = SigningKey.generate()
    priv_b64 = base64.b64encode(bytes(sk)).decode()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return priv_b64, pub_b64


def _make_envelope(
    payload: dict | None = None,
    *,
    ts: int | None = None,
    reply_to: str | None = None,
) -> MessageEnvelope:
    """Build a minimal valid MessageEnvelope (unsigned placeholder sig)."""
    payload = payload or {"text": "hello"}
    return MessageEnvelope(
        msg_id=str(uuid.uuid4()),
        ts=ts or int(time.time()),
        **{"from": "ag_alice"},
        to="ag_bob",
        type=MessageType.message,
        reply_to=reply_to,
        ttl_sec=3600,
        payload=payload,
        payload_hash=compute_payload_hash(payload),
        sig=Signature(key_id="k0", value="placeholder"),
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_payload_hash_determinism():
    """Same payload always produces the same hash."""
    p = {"b": 2, "a": 1}
    h1 = compute_payload_hash(p)
    h2 = compute_payload_hash(p)
    assert h1 == h2
    assert h1.startswith("sha256:")
    # Key order doesn't matter (JCS sorts keys).
    h3 = compute_payload_hash({"a": 1, "b": 2})
    assert h1 == h3


def test_sign_verify_roundtrip():
    """Sign an envelope then verify — should succeed."""
    priv, pub = _make_keypair()
    env = _make_envelope()
    env.sig = sign_envelope(env, priv, "k1")
    assert env.sig.key_id == "k1"
    assert verify_envelope_sig(env, pub)


def test_tampered_payload_hash_fails():
    """Changing the payload after hashing must cause verify_payload_hash to fail."""
    original = {"text": "hello"}
    h = compute_payload_hash(original)
    assert verify_payload_hash(original, h)
    tampered = {"text": "goodbye"}
    assert not verify_payload_hash(tampered, h)


def test_tampered_signature_fails():
    """Modifying the signature value must cause verification to fail."""
    priv, pub = _make_keypair()
    env = _make_envelope()
    env.sig = sign_envelope(env, priv, "k1")
    # Corrupt last character of the base64 sig.
    bad_char = "A" if env.sig.value[-1] != "A" else "B"
    env.sig = Signature(key_id="k1", value=env.sig.value[:-1] + bad_char)
    assert not verify_envelope_sig(env, pub)


def test_wrong_key_fails():
    """Verifying with a different public key must fail."""
    priv1, _ = _make_keypair()
    _, pub2 = _make_keypair()
    env = _make_envelope()
    env.sig = sign_envelope(env, priv1, "k1")
    assert not verify_envelope_sig(env, pub2)


def test_timestamp_within_window():
    now = int(time.time())
    assert check_timestamp(now)
    assert check_timestamp(now - 299)
    assert check_timestamp(now + 299)


def test_timestamp_outside_window():
    now = int(time.time())
    assert not check_timestamp(now - 301)
    assert not check_timestamp(now + 301)


def test_envelope_serialization_from_alias():
    """MessageEnvelope must serialize ``from_`` as ``from`` in JSON."""
    env = _make_envelope()
    data = env.model_dump(by_alias=True)
    assert "from" in data
    assert "from_" not in data
    assert data["from"] == "ag_alice"


def test_envelope_deserialization_from_alias():
    """MessageEnvelope must accept ``from`` key when deserializing."""
    env = _make_envelope()
    data = env.model_dump(by_alias=True)
    restored = MessageEnvelope.model_validate(data)
    assert restored.from_ == "ag_alice"


def test_reply_to_none_signing_input():
    """reply_to=None should produce an empty string in signing input."""
    env = _make_envelope(reply_to=None)
    si = build_signing_input(env)
    parts = si.decode().split("\n")
    # reply_to is at index 6 (v, msg_id, ts, from, to, type, reply_to, ...)
    assert parts[6] == ""


def test_reply_to_set_signing_input():
    """reply_to with a value should appear in signing input."""
    ref = str(uuid.uuid4())
    env = _make_envelope(reply_to=ref)
    si = build_signing_input(env)
    parts = si.decode().split("\n")
    assert parts[6] == ref


if __name__ == "__main__":
    tests = [v for k, v in globals().items() if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  PASS  {t.__name__}")
    print(f"\nAll {len(tests)} tests passed.")

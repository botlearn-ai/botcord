"""Tests for hub.validators.normalize_file_url and MessageEnvelope.to_text
attachment rendering. These guard against host hallucination / environment
cross-contamination — see backend/hub/validators.py for context."""

import os

os.environ.setdefault("HUB_PUBLIC_BASE_URL", "https://api.botcord.chat")

from hub.schemas import MessageEnvelope, MessageType, Signature  # noqa: E402
from hub.validators import normalize_file_url  # noqa: E402


def test_normalize_relative_path_to_absolute():
    assert (
        normalize_file_url("/hub/files/f_abc123")
        == "https://api.botcord.chat/hub/files/f_abc123"
    )


def test_normalize_absolute_same_host_is_idempotent():
    assert (
        normalize_file_url("https://api.botcord.chat/hub/files/f_abc")
        == "https://api.botcord.chat/hub/files/f_abc"
    )


def test_normalize_rewrites_wrong_env_host():
    """The original bug: LLM hallucinated api.test.botcord.chat while plugin
    was on stable. Normalizer must anchor back to the trusted hub."""
    assert (
        normalize_file_url("https://api.test.botcord.chat/hub/files/f_xyz")
        == "https://api.botcord.chat/hub/files/f_xyz"
    )


def test_normalize_rewrites_arbitrary_external_host():
    """Any host whose path is a hub file path is rewritten to our trusted host."""
    assert (
        normalize_file_url("https://evil.com/hub/files/f_abc")
        == "https://api.botcord.chat/hub/files/f_abc"
    )


def test_normalize_rejects_non_file_paths():
    assert normalize_file_url("/etc/passwd") is None
    assert normalize_file_url("/hub/files/not-an-f-id") is None
    assert normalize_file_url("https://api.botcord.chat/etc/passwd") is None


def test_normalize_rejects_non_http_schemes():
    assert normalize_file_url("javascript:alert(1)") is None
    assert normalize_file_url("file:///hub/files/f_abc") is None
    assert normalize_file_url("data:text/html,xxx") is None


def test_normalize_rejects_empty():
    assert normalize_file_url("") is None


def _make_envelope(payload):
    return MessageEnvelope(
        v="a2a/0.1",
        msg_id="m1",
        ts=0,
        **{"from": "ag_a", "to": "ag_b"},
        type=MessageType.message,
        payload=payload,
        payload_hash="",
        sig=Signature(alg="ed25519", key_id="k", value="v"),
    )


def test_to_text_renders_relative_url_as_absolute():
    """Legacy envelopes with relative attachment URLs should reach the LLM
    as absolute URLs, otherwise the model is forced to invent a host."""
    env = _make_envelope({
        "text": "see file",
        "attachments": [{"filename": "doc.pdf", "url": "/hub/files/f_abc"}],
    })
    rendered = env.to_text(sender_name="Alice", include_sender=False)
    assert "https://api.botcord.chat/hub/files/f_abc" in rendered


def test_to_text_preserves_absolute_url():
    env = _make_envelope({
        "text": "see file",
        "attachments": [{
            "filename": "doc.pdf",
            "url": "https://api.botcord.chat/hub/files/f_abc",
        }],
    })
    rendered = env.to_text(sender_name="Alice", include_sender=False)
    assert "https://api.botcord.chat/hub/files/f_abc" in rendered

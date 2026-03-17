"""Centralized ID generation for all entity types."""

import hashlib
import secrets


def generate_agent_id(pubkey_b64: str) -> str:
    """Derive agent_id from public key: 'ag_' + first 12 hex chars of SHA-256(pubkey).

    This ensures the same public key always produces the same agent_id,
    making the identity deterministic and verifiable.
    """
    digest = hashlib.sha256(pubkey_b64.encode()).hexdigest()
    return "ag_" + digest[:12]


def generate_key_id() -> str:
    """Generate key_id: 'k_' + 12 random hex chars."""
    return "k_" + secrets.token_hex(6)


def generate_endpoint_id() -> str:
    """Generate endpoint_id: 'ep_' + 12 random hex chars."""
    return "ep_" + secrets.token_hex(6)


def generate_hub_msg_id() -> str:
    """Generate hub message ID: 'h_' + 32 random hex chars."""
    return "h_" + secrets.token_hex(16)


def generate_room_id() -> str:
    """Generate room_id: 'rm_' + 12 random hex chars."""
    return "rm_" + secrets.token_hex(6)


def generate_share_id() -> str:
    """Generate share_id: 'sh_' + 12 random hex chars."""
    return "sh_" + secrets.token_hex(6)


def generate_topic_id() -> str:
    """Generate topic_id: 'tp_' + 12 random hex chars."""
    return "tp_" + secrets.token_hex(6)


def generate_file_id() -> str:
    """Generate file_id: 'f_' + 32 random hex chars (128-bit unguessable)."""
    return "f_" + secrets.token_hex(16)

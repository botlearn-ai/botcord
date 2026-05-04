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


def generate_human_id() -> str:
    """Generate human_id: 'hu_' + 12 random hex chars.

    Matches the length/shape of ag_* so the two can coexist in a single
    participant_id column without format-driven ambiguity beyond the prefix.
    """
    return "hu_" + secrets.token_hex(6)


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


def generate_tx_id() -> str:
    """Generate wallet transaction ID: 'tx_' + 16 random hex chars."""
    return "tx_" + secrets.token_hex(8)


def generate_wallet_entry_id() -> str:
    """Generate wallet entry ID: 'we_' + 16 random hex chars."""
    return "we_" + secrets.token_hex(8)


def generate_topup_id() -> str:
    """Generate topup request ID: 'tu_' + 16 random hex chars."""
    return "tu_" + secrets.token_hex(8)


def generate_withdrawal_id() -> str:
    """Generate withdrawal request ID: 'wd_' + 16 random hex chars."""
    return "wd_" + secrets.token_hex(8)


def generate_subscription_product_id() -> str:
    """Generate subscription product ID: 'sp_' + 16 random hex chars."""
    return "sp_" + secrets.token_hex(8)


def generate_subscription_id() -> str:
    """Generate subscription ID: 'sub_' + 16 random hex chars."""
    return "sub_" + secrets.token_hex(8)


def generate_subscription_charge_attempt_id() -> str:
    """Generate subscription charge attempt ID: 'sca_' + 16 random hex chars."""
    return "sca_" + secrets.token_hex(8)


def generate_join_request_id() -> str:
    """Generate room join request ID: 'jr_' + 16 random hex chars."""
    return "jr_" + secrets.token_hex(8)


def generate_daemon_instance_id() -> str:
    """Generate daemon instance ID: 'dm_' + 12 random hex chars."""
    return "dm_" + secrets.token_hex(6)


def generate_gateway_connection_id(provider: str) -> str:
    """Generate third-party gateway connection ID: 'gw_<provider>_<12 hex>'.

    Provider tag is embedded so logs/dashboards can identify the channel
    type from the id alone (matches the daemon's on-disk secret filename).
    """
    safe = provider.lower().replace("-", "").replace("_", "")[:16] or "x"
    return f"gw_{safe}_" + secrets.token_hex(6)


def generate_openclaw_host_id_from_pubkey(pubkey_b64: str) -> str:
    """Derive openclaw host id deterministically from the host pubkey.

    Same pattern as :func:`generate_agent_id` so a re-install with the same
    keypair maps back to the same host row.
    """
    digest = hashlib.sha256(pubkey_b64.encode()).hexdigest()
    return "oc_" + digest[:12]


def generate_daemon_device_code() -> str:
    """Generate device-code secret: 'dc_' + 32 random hex chars."""
    return "dc_" + secrets.token_hex(16)


def generate_daemon_install_token() -> str:
    """Generate one-time daemon install token: 'dit_' + 32 random hex chars."""
    return "dit_" + secrets.token_hex(16)


def generate_daemon_install_ticket_id() -> str:
    """Generate daemon install ticket row ID: 'ditk_' + 12 random hex chars."""
    return "ditk_" + secrets.token_hex(6)


_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # avoid I, O, 0, 1


def generate_daemon_user_code() -> str:
    """Generate human-friendly user code: ``XXXX-XXXX`` from a no-confusing alphabet."""
    raw = "".join(secrets.choice(_USER_CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"

"""Shared utility helpers for the hub."""

import secrets
import string

_CODE_ALPHABET = string.ascii_uppercase + string.digits


def generate_beta_code(prefix: str = "BETA", length: int = 8) -> str:
    """Generate a random invite code like BETA-A3X9Z2WQ."""
    suffix = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))
    return f"{prefix}-{suffix}"

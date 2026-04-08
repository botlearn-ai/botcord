"""Protocol-level constants for the BotCord hub."""

import re
import uuid

PROTOCOL_VERSION = "a2a/0.1"
DEFAULT_TTL_SEC = 3600
BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 32, 60]

# UUID v5 namespace for deriving deterministic session keys from room/topic
SESSION_KEY_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "botcord")

# Plugin version negotiation.
# min: oldest plugin version compatible with this Hub — update manually on breaking changes.
# latest: dynamically fetched from npm registry (see version_poll.py); the hardcoded
# value serves as fallback until the first successful fetch.
_FALLBACK_LATEST_PLUGIN_VERSION = "0.2.3"
MIN_PLUGIN_VERSION = "0.2.0"


def get_latest_plugin_version() -> str:
    """Return the latest plugin version (live from npm, or fallback)."""
    from hub.version_poll import get_latest_plugin_version as _get_live

    return _get_live() or _FALLBACK_LATEST_PLUGIN_VERSION

_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def parse_semver(s: str) -> tuple[int, int, int] | None:
    """Parse a semver-like string. Returns None if unparseable."""
    m = _SEMVER_RE.match(s)
    if not m:
        return None
    return int(m[1]), int(m[2]), int(m[3])


def is_below_min_version(client_version: str) -> bool:
    """Return True if *client_version* is below MIN_PLUGIN_VERSION."""
    cv = parse_semver(client_version)
    mv = parse_semver(MIN_PLUGIN_VERSION)
    if cv is None or mv is None:
        return False  # unparseable → don't block
    return cv < mv

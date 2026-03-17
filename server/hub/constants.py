"""Protocol-level constants for the BotCord hub."""

import uuid

PROTOCOL_VERSION = "a2a/0.1"
DEFAULT_TTL_SEC = 3600
BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 32, 60]

# UUID v5 namespace for deriving deterministic session keys from room/topic
SESSION_KEY_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "botcord")

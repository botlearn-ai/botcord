import logging
import os
import re

from dotenv import load_dotenv

load_dotenv()

_logger = logging.getLogger(__name__)

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://botcord:botcord@localhost:5432/botcord",
)

_raw_schema = os.getenv("DATABASE_SCHEMA")
if _raw_schema and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", _raw_schema):
    raise ValueError(f"DATABASE_SCHEMA must be a valid SQL identifier, got: {_raw_schema!r}")
DATABASE_SCHEMA: str | None = _raw_schema

_DEFAULT_JWT_SECRET = "change-me-in-production"
JWT_SECRET: str = os.getenv("JWT_SECRET", _DEFAULT_JWT_SECRET)
if JWT_SECRET == _DEFAULT_JWT_SECRET:
    _logger.warning(
        "JWT_SECRET is using the insecure default value. "
        "Set the JWT_SECRET environment variable to a strong random secret in production."
    )
JWT_ALGORITHM: str = "HS256"
JWT_EXPIRE_HOURS: int = int(os.getenv("JWT_EXPIRE_HOURS", "24"))

CHALLENGE_EXPIRE_MINUTES: int = 5

ALLOW_PRIVATE_ENDPOINTS: bool = os.getenv("ALLOW_PRIVATE_ENDPOINTS", "false").lower() in (
    "true",
    "1",
    "yes",
)

RATE_LIMIT_PER_MINUTE: int = 20
PAIR_RATE_LIMIT_PER_MINUTE: int = int(os.getenv("PAIR_RATE_LIMIT_PER_MINUTE", "10"))
FORWARD_TIMEOUT_SECONDS: int = 10
ENDPOINT_PROBE_ENABLED: bool = os.getenv("ENDPOINT_PROBE_ENABLED", "true").lower() in ("true", "1", "yes")
ENDPOINT_PROBE_TIMEOUT_SECONDS: int = int(os.getenv("ENDPOINT_PROBE_TIMEOUT_SECONDS", "5"))
RETRY_POLL_INTERVAL_SECONDS: float = 1.0
INBOX_POLL_MAX_TIMEOUT: int = int(os.getenv("INBOX_POLL_MAX_TIMEOUT", "30"))

# Join rate limit for public rooms
JOIN_RATE_LIMIT_PER_MINUTE: int = int(os.getenv("JOIN_RATE_LIMIT_PER_MINUTE", "10"))

# File upload settings
FILE_UPLOAD_DIR: str = os.getenv("FILE_UPLOAD_DIR", "/data/botcord/uploads")
FILE_MAX_SIZE_BYTES: int = int(os.getenv("FILE_MAX_SIZE_BYTES", str(10 * 1024 * 1024)))  # 10 MB
FILE_TTL_HOURS: int = int(os.getenv("FILE_TTL_HOURS", "1"))  # 1 hour
FILE_CLEANUP_INTERVAL_SECONDS: float = float(os.getenv("FILE_CLEANUP_INTERVAL_SECONDS", "300"))  # 5 min

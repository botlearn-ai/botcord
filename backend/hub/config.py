import logging
import os
import re

from dotenv import load_dotenv

load_dotenv()

_logger = logging.getLogger(__name__)

def _build_database_url() -> str:
    """Build DATABASE_URL from env, supporting both a single URL and individual components."""
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    # Fall back to individual DB_* variables (e.g. Vercel environment)
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASS")
    host = os.getenv("DB_HOST")
    port = os.getenv("DB_PORT", "5432")
    name = os.getenv("DB_NAME")
    if user and host and name:
        return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{name}"
    return "postgresql+asyncpg://botcord:botcord@localhost:5432/botcord"


DATABASE_URL: str = _build_database_url()

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

# Secret token required for internal/admin wallet endpoints.
# Must be set to a strong random value in production when ALLOW_PRIVATE_ENDPOINTS=true.
INTERNAL_API_SECRET: str | None = os.getenv("INTERNAL_API_SECRET", None)

if ALLOW_PRIVATE_ENDPOINTS and not INTERNAL_API_SECRET:
    _logger.warning(
        "ALLOW_PRIVATE_ENDPOINTS is enabled but INTERNAL_API_SECRET is not set. "
        "Internal wallet endpoints are accessible WITHOUT authentication. "
        "Set INTERNAL_API_SECRET to a strong random value in production."
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
FILE_UPLOAD_DIR: str = os.getenv("FILE_UPLOAD_DIR", "/tmp/botcord/uploads")
FILE_MAX_SIZE_BYTES: int = int(os.getenv("FILE_MAX_SIZE_BYTES", str(10 * 1024 * 1024)))  # 10 MB
FILE_TTL_HOURS: int = int(os.getenv("FILE_TTL_HOURS", "1"))  # 1 hour
FILE_CLEANUP_INTERVAL_SECONDS: float = float(os.getenv("FILE_CLEANUP_INTERVAL_SECONDS", "300"))  # 5 min

# Message expiry settings (replaces retry loop)
MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS: float = float(os.getenv("MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS", "30"))

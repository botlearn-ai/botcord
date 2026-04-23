"""
[INPUT]: 依赖环境变量、时间窗口与支付活动常量，向 Hub 全局暴露运行时配置
[OUTPUT]: 对外提供数据库、鉴权、文件、Stripe 与冷启动赠送等统一配置常量
[POS]: backend 配置中枢，负责把跨模块共享的运行时策略收敛为单一真相源
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import datetime
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

# Supabase JWT verification (optional — set ONE of these)
# Option 1: symmetric HS256 secret (legacy Supabase projects)
SUPABASE_JWT_SECRET: str | None = os.getenv("SUPABASE_JWT_SECRET")
# Option 2: JWKS URL for ES256/RS256 (modern Supabase projects)
# e.g. https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_JWKS_URL: str | None = os.getenv("SUPABASE_JWT_JWKS_URL")

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
FILE_STORAGE_BACKEND: str = os.getenv("FILE_STORAGE_BACKEND", "disk").strip().lower()
if FILE_STORAGE_BACKEND not in {"disk", "supabase"}:
    raise ValueError(
        "FILE_STORAGE_BACKEND must be either 'disk' or 'supabase', "
        f"got: {FILE_STORAGE_BACKEND!r}"
    )
FILE_UPLOAD_DIR: str = os.getenv("FILE_UPLOAD_DIR", "/tmp/botcord/uploads")
FILE_MAX_SIZE_BYTES: int = int(os.getenv("FILE_MAX_SIZE_BYTES", str(10 * 1024 * 1024)))  # 10 MB
FILE_TTL_HOURS: int = int(os.getenv("FILE_TTL_HOURS", "1"))  # 1 hour
FILE_CLEANUP_INTERVAL_SECONDS: float = float(os.getenv("FILE_CLEANUP_INTERVAL_SECONDS", "300"))  # 5 min
SUPABASE_URL: str | None = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY: str | None = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_STORAGE_BUCKET: str | None = os.getenv("SUPABASE_STORAGE_BUCKET")

# ---------------------------------------------------------------------------
# Stripe integration
# ---------------------------------------------------------------------------

STRIPE_SECRET_KEY: str | None = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET: str | None = os.getenv("STRIPE_WEBHOOK_SECRET")
STRIPE_TOPUP_CURRENCY: str = os.getenv("STRIPE_TOPUP_CURRENCY", "usd")
FRONTEND_BASE_URL: str = os.getenv("FRONTEND_BASE_URL", "https://botcord.chat")
HUB_PUBLIC_BASE_URL: str = os.getenv("HUB_PUBLIC_BASE_URL", "https://api.botcord.chat").rstrip("/")
BETA_APPROVAL_EMAIL_WEBHOOK_URL: str | None = os.getenv("BETA_APPROVAL_EMAIL_WEBHOOK_URL")
RESEND_API_KEY: str | None = os.getenv("RESEND_API_KEY")
RESEND_FROM_EMAIL: str = os.getenv("RESEND_FROM_EMAIL", "BotCord <noreply@botcord.chat>")
BETA_GATE_ENABLED: bool = os.getenv("BETA_GATE_ENABLED", "false").lower() == "true"

def _parse_stripe_packages() -> list[dict]:
    raw = os.getenv("STRIPE_TOPUP_PACKAGES_JSON", "")
    if not raw:
        return []
    import json as _json
    try:
        pkgs = _json.loads(raw)
        if not isinstance(pkgs, list):
            _logger.error("STRIPE_TOPUP_PACKAGES_JSON must be a JSON array")
            return []
        return pkgs
    except _json.JSONDecodeError:
        _logger.error("STRIPE_TOPUP_PACKAGES_JSON is not valid JSON")
        return []

STRIPE_TOPUP_PACKAGES: list[dict] = _parse_stripe_packages()

# Message expiry settings (replaces retry loop)
MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS: float = float(os.getenv("MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS", "30"))

# Secret used to HMAC-sign bind tickets for cryptographic agent binding.
# Falls back to JWT_SECRET if not explicitly set.
BIND_PROOF_SECRET: str | None = os.getenv("BIND_PROOF_SECRET") or os.getenv("BOTCORD_BIND_PROOF_SECRET")

# ---------------------------------------------------------------------------
# Environment tag — controls CORS origins and other env-specific behavior
# Values: "preview" | "prod" (default: "prod")
# ---------------------------------------------------------------------------
ENVIRONMENT_TAG: str = os.getenv("ENVIRONMENT_TAG", "prod")

# ---------------------------------------------------------------------------
# Sentry — error & performance monitoring
# Set SENTRY_DSN to enable. Inherits ENVIRONMENT_TAG as the Sentry environment.
# ---------------------------------------------------------------------------
SENTRY_DSN: str | None = os.getenv("SENTRY_DSN")
SENTRY_TRACES_SAMPLE_RATE: float = float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "1.0"))

# ---------------------------------------------------------------------------
# Daemon control plane (see docs/daemon-control-plane-plan.md)
# ---------------------------------------------------------------------------

# Default development keypair — DO NOT use in production. Override
# BOTCORD_HUB_CONTROL_PRIVATE_KEY with a freshly generated 32-byte Ed25519
# seed (base64). Matching public key is committed in
# docs/daemon-control-plane-api-contract.md so the daemon can verify.
_DAEMON_DEFAULT_PRIVATE_KEY_B64 = "R9yHQWAP+oLdwuXW67TGSi/RWbkYPGf1a31by04W1zA="

DAEMON_HUB_CONTROL_PRIVATE_KEY_B64: str = os.getenv(
    "BOTCORD_HUB_CONTROL_PRIVATE_KEY", _DAEMON_DEFAULT_PRIVATE_KEY_B64
)
if DAEMON_HUB_CONTROL_PRIVATE_KEY_B64 == _DAEMON_DEFAULT_PRIVATE_KEY_B64:
    _logger.warning(
        "BOTCORD_HUB_CONTROL_PRIVATE_KEY is using the insecure default seed. "
        "Generate a fresh Ed25519 keypair before deploying to production."
    )

DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS: int = int(
    os.getenv("DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS", "3600")
)
DAEMON_DEVICE_CODE_TTL_SECONDS: int = int(
    os.getenv("DAEMON_DEVICE_CODE_TTL_SECONDS", "600")
)
DAEMON_DEVICE_CODE_INTERVAL_SECONDS: int = int(
    os.getenv("DAEMON_DEVICE_CODE_INTERVAL_SECONDS", "5")
)
DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS: int = int(
    os.getenv("DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS", "30000")
)
DAEMON_DISPATCH_MAX_TIMEOUT_MS: int = int(
    os.getenv("DAEMON_DISPATCH_MAX_TIMEOUT_MS", "60000")
)

# ---------------------------------------------------------------------------
# Cold-start claim gift
# 固定窗口: 2026-04-07 00:00:00 +08:00 <= now < 2026-07-08 00:00:00 +08:00
# 金额使用 COIN minor unit (1 COIN = 100 minor)，当前写死赠送 100 COIN = 10000 minor。
# ---------------------------------------------------------------------------

_COLD_START_TZ = datetime.timezone(datetime.timedelta(hours=8))
COIN_MINOR_SCALE: int = 100
CLAIM_GIFT_ASSET_CODE: str = "COIN"
CLAIM_GIFT_AMOUNT_COIN: int = 100
CLAIM_GIFT_AMOUNT_MINOR: int = CLAIM_GIFT_AMOUNT_COIN * COIN_MINOR_SCALE
CLAIM_GIFT_WINDOW_START_AT: datetime.datetime = datetime.datetime(
    2026, 4, 7, 0, 0, 0, tzinfo=_COLD_START_TZ
)
CLAIM_GIFT_WINDOW_END_AT_EXCLUSIVE: datetime.datetime = datetime.datetime(
    2026, 7, 8, 0, 0, 0, tzinfo=_COLD_START_TZ
)


def is_claim_gift_active(now: datetime.datetime | None = None) -> bool:
    """Return whether the cold-start claim gift should be granted now."""
    current = now or datetime.datetime.now(datetime.timezone.utc)
    return CLAIM_GIFT_WINDOW_START_AT <= current < CLAIM_GIFT_WINDOW_END_AT_EXCLUSIVE

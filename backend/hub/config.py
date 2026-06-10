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

# Shared secret used by the gateway-ingress service when it calls the
# Hub thin lifecycle API (POST /internal/cloud-gateway/...). The ingress
# service authenticates with this bearer; ``INTERNAL_API_SECRET`` is also
# accepted so operators can hit the same endpoints from runbooks.
#
# Note: this same secret is reused in the OPPOSITE direction below — the Hub
# bears it when it calls gateway-ingress' /internal/gateway-ingress/* setup
# API on behalf of a cloud agent. Symmetric bearer is intentional: both ends
# already trust each other, and rotating one shared value is simpler than
# tracking two independent secrets per environment.
CLOUD_GATEWAY_INGRESS_SECRET: str | None = os.getenv(
    "CLOUD_GATEWAY_INGRESS_SECRET", None
)
# Base URL of the gateway-ingress setup API as seen from the Hub (e.g.
# ``http://gateway-ingress.svc.cluster.local:9101``). When unset, Hub→ingress
# calls fail with 503 — the Hub will NOT silently fall back to dispatching
# cloud-agent setup through the cloud daemon (that's the very bug Phase 2
# fixes). Local development typically points at ``http://localhost:9101``.
CLOUD_GATEWAY_INGRESS_BASE_URL: str | None = os.getenv(
    "CLOUD_GATEWAY_INGRESS_BASE_URL", None
)
# Cloud runtime session tokens are scoped JWTs minted by the Hub for the
# ingress service. The signing key is derived from ``JWT_SECRET`` unless
# a dedicated key is provided so a leaked runtime token cannot be replayed
# against agent JWT validators.
CLOUD_GATEWAY_RUNTIME_TOKEN_TTL_SECONDS: int = int(
    os.getenv("CLOUD_GATEWAY_RUNTIME_TOKEN_TTL_SECONDS", "300")
)
# Public WS endpoint advertised to gateway-ingress so it can connect to the
# cloud-daemon runtime session. Defaults to the runtime relay path on the
# Hub; deployments that expose the cloud daemon directly should override.
CLOUD_GATEWAY_RUNTIME_ENDPOINT: str = os.getenv(
    "CLOUD_GATEWAY_RUNTIME_ENDPOINT", "wss://hub.botcord.chat/cloud-gateway/runtime"
)
# Optional admin endpoint for pushing dashboard-managed cloud gateway
# connection metadata into the always-on gateway-ingress service. When unset,
# dashboard gateway CRUD keeps the existing daemon-control behavior only.
CLOUD_GATEWAY_INGRESS_ADMIN_URL: str | None = (
    os.getenv("CLOUD_GATEWAY_INGRESS_ADMIN_URL", "").strip().rstrip("/") or None
)
CLOUD_GATEWAY_INGRESS_ADMIN_TIMEOUT_SECONDS: float = float(
    os.getenv("CLOUD_GATEWAY_INGRESS_ADMIN_TIMEOUT_SECONDS", "5")
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
SUPABASE_STORAGE_TIMEOUT_SECONDS: float = float(os.getenv("SUPABASE_STORAGE_TIMEOUT_SECONDS", "30"))

# ---------------------------------------------------------------------------
# Agent Presence & Status V1
#   See docs/agent-presence-status-v1-supabase.md
# ---------------------------------------------------------------------------

PRESENCE_ONLINE_TIMEOUT_SECONDS: float = float(
    os.getenv("PRESENCE_ONLINE_TIMEOUT_SECONDS", "45")
)
PRESENCE_IDLE_TIMEOUT_SECONDS: float = float(
    os.getenv("PRESENCE_IDLE_TIMEOUT_SECONDS", "300")
)
PRESENCE_TYPING_TIMEOUT_SECONDS: float = float(
    os.getenv("PRESENCE_TYPING_TIMEOUT_SECONDS", "8")
)
PRESENCE_PROCESSING_FAILSAFE_TIMEOUT_SECONDS: float = float(
    os.getenv("PRESENCE_PROCESSING_FAILSAFE_TIMEOUT_SECONDS", "600")
)
PRESENCE_CLEANUP_INTERVAL_SECONDS: float = float(
    os.getenv("PRESENCE_CLEANUP_INTERVAL_SECONDS", "30")
)
PRESENCE_NODE_ID: str = os.getenv(
    "PRESENCE_NODE_ID", os.getenv("HOSTNAME", "hub")
)[:64]
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
AUTH_ALLOWED_ORIGINS: tuple[str, ...] = tuple(
    origin.strip().rstrip("/")
    for origin in os.getenv("AUTH_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)
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

# ---------------------------------------------------------------------------
# Owner-chat in-flight stream cache (Redis)
#   See docs/owner-chat-stream-cache-prd.md
#
# When BOTCORD_REDIS_URL is unset/empty, Redis is DISABLED and all owner-chat
# cache + fanout operations become graceful no-ops. Live WebSocket streaming
# does not depend on Redis. TLS is enabled automatically via the rediss://
# scheme in the URL.
# ---------------------------------------------------------------------------
BOTCORD_REDIS_URL: str | None = os.getenv("BOTCORD_REDIS_URL", "").strip() or None
OWNER_CHAT_RUN_TTL_SECONDS: int = int(os.getenv("OWNER_CHAT_RUN_TTL_SECONDS", "3600"))
OWNER_CHAT_RUN_COMPLETED_TTL_SECONDS: int = int(
    os.getenv("OWNER_CHAT_RUN_COMPLETED_TTL_SECONDS", "300")
)
OWNER_CHAT_RUN_FAILED_TTL_SECONDS: int = int(
    os.getenv("OWNER_CHAT_RUN_FAILED_TTL_SECONDS", "600")
)
OWNER_CHAT_MAX_CACHED_EVENTS: int = int(os.getenv("OWNER_CHAT_MAX_CACHED_EVENTS", "200"))
OWNER_CHAT_MAX_EVENT_BYTES: int = int(os.getenv("OWNER_CHAT_MAX_EVENT_BYTES", "8192"))
OWNER_CHAT_FANOUT_CHANNEL: str = os.getenv("OWNER_CHAT_FANOUT_CHANNEL", "owner_chat_events")

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
SENTRY_RELEASE: str | None = os.getenv("SENTRY_RELEASE")


def _parse_log_level_env(name: str, default: str) -> int | None:
    raw = os.getenv(name, default).strip()
    if raw.lower() in {"", "none", "off"}:
        return None
    if raw.isdigit():
        return int(raw)
    level = getattr(logging, raw.upper(), None)
    if isinstance(level, int):
        return level
    _logger.warning("Invalid %s=%r; falling back to %s", name, raw, default)
    return getattr(logging, default)


SENTRY_LOG_BREADCRUMB_LEVEL: int | None = _parse_log_level_env(
    "SENTRY_LOG_BREADCRUMB_LEVEL", "INFO"
)
SENTRY_LOG_EVENT_LEVEL: int | None = _parse_log_level_env(
    "SENTRY_LOG_EVENT_LEVEL", "ERROR"
)
SENTRY_LOGS_LEVEL: int | None = _parse_log_level_env("SENTRY_LOGS_LEVEL", "INFO")

# ---------------------------------------------------------------------------
# Daemon control plane
# ---------------------------------------------------------------------------

# Default development keypair — DO NOT use in production. Override
# BOTCORD_HUB_CONTROL_PRIVATE_KEY with a freshly generated 32-byte Ed25519
# seed (base64). The matching public key is shipped to the daemon for verification.
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
DAEMON_INSTALL_TICKET_TTL_SECONDS: int = int(
    os.getenv("DAEMON_INSTALL_TICKET_TTL_SECONDS", "600")
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
DAEMON_DIAGNOSTICS_DIR: str = os.getenv("DAEMON_DIAGNOSTICS_DIR", "/tmp/botcord/daemon-diagnostics")
DAEMON_DIAGNOSTICS_MAX_BYTES: int = int(
    os.getenv("DAEMON_DIAGNOSTICS_MAX_BYTES", str(50 * 1024 * 1024))
)
DAEMON_DIAGNOSTICS_TTL_HOURS: int = int(os.getenv("DAEMON_DIAGNOSTICS_TTL_HOURS", "168"))

# OpenClaw host control plane — mirrors daemon's defaults.
OPENCLAW_ACCESS_TOKEN_EXPIRE_SECONDS: int = int(
    os.getenv("OPENCLAW_ACCESS_TOKEN_EXPIRE_SECONDS", "3600")
)
OPENCLAW_REFRESH_TOKEN_TTL_SECONDS: int = int(
    os.getenv("OPENCLAW_REFRESH_TOKEN_TTL_SECONDS", str(60 * 60 * 24 * 30))
)
OPENCLAW_PROVISION_TICKET_TTL_SECONDS: int = int(
    os.getenv("OPENCLAW_PROVISION_TICKET_TTL_SECONDS", "300")
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


# ---------------------------------------------------------------------------
# Cloud Agent (PR 3+) — feature flag + per-user limits.
# See docs/cloud-agent-subscription-implementation-plan.md §2.
# ---------------------------------------------------------------------------

CLOUD_AGENT_FEATURE_ENABLED: bool = os.getenv(
    "CLOUD_AGENT_FEATURE_ENABLED", "false"
).lower() in ("true", "1", "yes")

CLOUD_AGENT_MAX_PER_USER: int = int(os.getenv("CLOUD_AGENT_MAX_PER_USER", "5"))

CLOUD_AGENT_DEFAULT_RUNTIME: str = os.getenv(
    "CLOUD_AGENT_DEFAULT_RUNTIME", "deepseek-tui"
)

CLOUD_AGENT_DEFAULT_MODEL_PROFILE: str = os.getenv(
    "CLOUD_AGENT_DEFAULT_MODEL_PROFILE", "deepseek-v4-flash"
)

# Provider implementation key. Production/preview must use ``e2b`` so a
# created Cloud Agent actually gets a sandbox-backed daemon. Tests and local
# smoke runs that intentionally avoid E2B can opt into ``fake`` explicitly.
CLOUD_AGENT_DEFAULT_PROVIDER: str = os.getenv("CLOUD_AGENT_DEFAULT_PROVIDER", "e2b")

# Slot capacity per cloud daemon — schema allows >1 to keep the per-agent
# sandbox cost down. Conservative default while we observe real load.
CLOUD_AGENT_DEFAULT_MAX_AGENTS_PER_DAEMON: int = int(
    os.getenv("CLOUD_AGENT_DEFAULT_MAX_AGENTS_PER_DAEMON", "5")
)

CLOUD_AGENT_IDLE_PAUSE_SECONDS: float = float(
    os.getenv("CLOUD_AGENT_IDLE_PAUSE_SECONDS", "300")
)
CLOUD_AGENT_IDLE_SWEEP_INTERVAL_SECONDS: float = float(
    os.getenv("CLOUD_AGENT_IDLE_SWEEP_INTERVAL_SECONDS", "60")
)

# ---------------------------------------------------------------------------
# E2B sandbox provider (PR 4) — credentials + template + region.
#
# Gate 0 validated the Ubuntu 24.04 / glibc 2.39 template
# ``botcord-deepseek-tui-ubuntu2404-dev2`` (ID ``z0f20u29zdgx7cxnuzcu``);
# that is the default. Override via ``E2B_TEMPLATE_ID`` once a new image
# is promoted.
# ---------------------------------------------------------------------------

E2B_API_KEY: str | None = os.getenv("E2B_API_KEY")
E2B_TEMPLATE_ID: str = os.getenv("E2B_TEMPLATE_ID", "z0f20u29zdgx7cxnuzcu")
E2B_DEFAULT_REGION: str | None = os.getenv("E2B_DEFAULT_REGION") or None
# Wall-clock cap for each running E2B sandbox window. The provider configures
# E2B lifecycle on create so timeout pauses the sandbox instead of killing it.
E2B_SANDBOX_TIMEOUT_SECONDS: int = int(os.getenv("E2B_SANDBOX_TIMEOUT_SECONDS", "1800"))

# Command Hub runs inside a freshly-created or resumed cloud daemon instance.
# The default prefers the Hub-selected npm package so paused/resumed sandboxes
# do not keep running an older daemon baked into the E2B template. Keep this
# at ``latest`` so every create/resume picks up the current published daemon.
# Set ``CLOUD_DAEMON_NPM_SPEC=bundled`` only for a purpose-built image whose
# preinstalled ``botcord-daemon`` is known fresh.
CLOUD_DAEMON_NPM_SPEC: str = os.getenv(
    "CLOUD_DAEMON_NPM_SPEC", "@botcord/daemon@latest"
)
CLOUD_DAEMON_STARTUP_COMMAND: str = os.getenv(
    "CLOUD_DAEMON_STARTUP_COMMAND",
    (
        # Singleton enforcement lives in the daemon itself (see
        # `packages/daemon/src/daemon-singleton.ts`): the new daemon stops
        # any prior daemon via PID file + ps scan before claiming the slot.
        # Doing a shell-level `ps | grep | kill` here in addition is unsafe
        # because the grep pattern matches the surrounding shell command
        # line — the shell ends up killing its own parent. Trust the
        # daemon's singleton and just exec.
        "sh -lc '"
        "export npm_config_prefer_online=true; "
        "export npm_config_cache=/tmp/botcord-npm-cache; "
        "case \"${CLOUD_DAEMON_NPM_SPEC:-}\" in "
        "bundled) "
        "if command -v botcord-daemon >/dev/null 2>&1; then "
        "exec botcord-daemon start --foreground; "
        "fi; "
        ";; "
        "\"\") "
        "exec npm exec --yes --package @botcord/daemon@latest -- "
        "botcord-daemon start --foreground; "
        ";; "
        "*) "
        "exec npm exec --yes --package \"$CLOUD_DAEMON_NPM_SPEC\" -- "
        "botcord-daemon start --foreground; "
        ";; "
        "esac; "
        "exec npm exec --yes --package @botcord/daemon@latest -- "
        "botcord-daemon start --foreground"
        "'"
    ),
)

# DeepSeek model API key forwarded to the cloud daemon as an env var on
# sandbox start. PR 4 keeps it as a plain Hub env var; a real secret-manager
# integration is part of production hardening, not the MVP.
DEEPSEEK_API_KEY: str | None = os.getenv("DEEPSEEK_API_KEY")

# Optional new-api integration for cloud agents. When both base URL and
# internal secret are configured, Hub provisions a per-user new-api account and
# token, then injects that token into cloud daemon sandboxes as provider env.
NEW_API_BASE_URL: str | None = (
    os.getenv("NEW_API_BASE_URL", "").strip().rstrip("/") or None
)
NEW_API_INTERNAL_SECRET: str | None = os.getenv("NEW_API_INTERNAL_SECRET")
NEW_API_CREDENTIAL_ENCRYPTION_KEY: str | None = os.getenv(
    "NEW_API_CREDENTIAL_ENCRYPTION_KEY"
)
NEW_API_REQUEST_TIMEOUT_SECONDS: float = float(
    os.getenv("NEW_API_REQUEST_TIMEOUT_SECONDS", "10")
)
NEW_API_INITIAL_CREDIT_USD: float = float(
    os.getenv("NEW_API_INITIAL_CREDIT_USD", "5")
)


# ---------------------------------------------------------------------------
# Cloud Agent usage ledger / quota (PR 7).
#
# Free-tier included quotas land on each ``usage_balances`` row when the
# Hub creates one for a new (user_id, period_start). The credit-per-X
# coefficients translate observed token / sandbox-second usage into the
# unified Cloud Credit unit used for quota and (future) billing.
# ---------------------------------------------------------------------------

CLOUD_AGENT_FREE_CREDITS_PER_PERIOD: int = int(
    os.getenv("CLOUD_AGENT_FREE_CREDITS_PER_PERIOD", "1000")
)
CLOUD_AGENT_FREE_SANDBOX_SECONDS_PER_PERIOD: int = int(
    os.getenv("CLOUD_AGENT_FREE_SANDBOX_SECONDS_PER_PERIOD", "3600")
)

# Credit-per-X coefficients are stored as ``credit-millis`` (1/1000 credit)
# so the integers work without floats. Defaults are conservative
# placeholders; final pricing comes out of Gate 4 cost analysis.
#
# Examples with the defaults below: 1k output tokens ≈ 1 credit;
# 1k input cache-miss tokens ≈ 0.2 credits; 1 sandbox-second ≈ 0.01 credit.
CREDIT_MILLIS_PER_INPUT_CACHE_HIT_KILOTOKEN: int = int(
    os.getenv("CREDIT_MILLIS_PER_INPUT_CACHE_HIT_KILOTOKEN", "50")
)
CREDIT_MILLIS_PER_INPUT_CACHE_MISS_KILOTOKEN: int = int(
    os.getenv("CREDIT_MILLIS_PER_INPUT_CACHE_MISS_KILOTOKEN", "200")
)
CREDIT_MILLIS_PER_OUTPUT_KILOTOKEN: int = int(
    os.getenv("CREDIT_MILLIS_PER_OUTPUT_KILOTOKEN", "1000")
)
CREDIT_MILLIS_PER_SANDBOX_SECOND: int = int(
    os.getenv("CREDIT_MILLIS_PER_SANDBOX_SECOND", "10")
)

# Floor for per-run reservation so trivially small runs still get the
# bookkeeping overhead reserved. Prevents zero-credit reservations from
# slipping past quota gates.
CLOUD_AGENT_RUN_CREDIT_RESERVATION_FLOOR: int = int(
    os.getenv("CLOUD_AGENT_RUN_CREDIT_RESERVATION_FLOOR", "5")
)

# ---------------------------------------------------------------------------
# BotLearn first-party browser integration (PR 9)
#
# BotLearn has no backend service holding a long-term secret. The Hub verifies
# BotLearn's login token directly, JIT-creates/binds a BotCord user, and hands
# the browser a short-lived, agent-scoped session token. None of these are
# long-lived browser-visible credentials. See
# docs/cloud-agent-technical-design.md §3.4 / §6.4.
# ---------------------------------------------------------------------------
BOTLEARN_INTEGRATION_ENABLED: bool = os.getenv(
    "BOTLEARN_INTEGRATION_ENABLED", "false"
).lower() in ("true", "1", "yes")
# Expected ``iss`` claim on the BotLearn login token (None disables the check).
BOTLEARN_ISSUER: str | None = os.getenv("BOTLEARN_ISSUER") or None
# Expected ``aud`` claim (None disables the check).
BOTLEARN_AUDIENCE: str | None = os.getenv("BOTLEARN_AUDIENCE") or None
# JWKS endpoint for asymmetric (RS256/ES256) BotLearn tokens.
BOTLEARN_JWKS_URL: str | None = os.getenv("BOTLEARN_JWKS_URL") or None
# Shared secret for HS256 BotLearn tokens (dev / same Supabase tenant).
BOTLEARN_JWT_SECRET: str | None = os.getenv("BOTLEARN_JWT_SECRET") or None
# Origin allowlist for the session-exchange + app-facing WS endpoints. Empty
# means the integration is effectively closed (deny by default).
BOTLEARN_ALLOWED_ORIGINS: list[str] = [
    o.strip().rstrip("/")
    for o in os.getenv("BOTLEARN_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]
# Short-lived integration session token TTL (seconds). Default 15 minutes.
BOTLEARN_SESSION_TTL_SECONDS: int = int(
    os.getenv("BOTLEARN_SESSION_TTL_SECONDS", "900")
)
# Require ``email_verified=true`` on the BotLearn login token.
BOTLEARN_REQUIRE_EMAIL_VERIFIED: bool = os.getenv(
    "BOTLEARN_REQUIRE_EMAIL_VERIFIED", "true"
).lower() in ("true", "1", "yes")
# Public WS URL advertised to the BotLearn frontend after session exchange.
# Falls back to ``HUB_PUBLIC_BASE_URL`` (ws/wss) when unset.
BOTLEARN_WS_URL: str | None = os.getenv("BOTLEARN_WS_URL") or None

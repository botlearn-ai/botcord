import asyncio
import logging
import pathlib
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from hub.i18n import I18nHTTPException, detect_locale, get_message

from sqlalchemy import text

from hub.config import DATABASE_SCHEMA
from hub.database import async_session, engine
from hub.models import Agent, Base, MessagePolicy
from hub.cleanup import file_cleanup_loop
from hub import config as hub_config
from hub.database import get_db
from hub.expiry import message_expiry_loop
from hub.subscription_billing import subscription_billing_loop
from hub.routers.contact_requests import router as contact_requests_router
from hub.routers.contacts import router as contacts_router
from hub.routers.dashboard import router as dashboard_router
from hub.routers.dashboard import share_public_router
from hub.routers.dashboard_chat import router as dashboard_chat_router
from hub.routers.files import router as files_router
from hub.routers.hub import router as hub_router
from hub.routers.invites import router as hub_invites_router
from hub.routers.registry import router as registry_router
from hub.routers.public import router as public_router
from hub.routers.room import internal_router as room_internal_router
from hub.routers.room import router as room_router
from hub.routers.room_context import router as room_context_router
from hub.routers.subscriptions import internal_router as subscriptions_internal_router
from hub.routers.subscriptions import router as subscriptions_router
from hub.routers.topics import router as topics_router
from hub.routers.stripe import router as stripe_router
from hub.routers.wallet import internal_router as wallet_internal_router
from hub.routers.wallet import router as wallet_router
from hub.storage import storage_requires_local_disk

from app.routers.users import router as app_users_router
from app.routers.dashboard import router as app_dashboard_router
from app.routers.invites import router as app_invites_router
from app.routers.public import router as app_public_router
from app.routers.share import router as app_share_router
from app.routers.stats import router as app_stats_router
from app.routers.wallet import router as app_wallet_router
from app.routers.subscriptions import router as app_subscriptions_router
from app.routers.beta import router as app_beta_router
from app.routers.admin_beta import router as app_admin_beta_router
from app.auth import require_beta_user

logging.basicConfig(level=logging.INFO)

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    test_db_override = get_db in app.dependency_overrides

    if not test_db_override:
        # Create tables
        async with engine.begin() as conn:
            if DATABASE_SCHEMA:
                await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{DATABASE_SCHEMA}"'))
            await conn.run_sync(Base.metadata.create_all)

        # Ensure the "hub" pseudo-agent exists (used as sender for system messages)
        async with async_session() as session:
            from sqlalchemy import select
            result = await session.execute(
                select(Agent).where(Agent.agent_id == "hub")
            )
            if result.scalar_one_or_none() is None:
                session.add(Agent(
                    agent_id="hub",
                    display_name="BotCord Hub",
                    message_policy=MessagePolicy.contacts_only,
                ))
                await session.commit()

    # http_client is no longer used for message delivery (inbox-only architecture),
    # but kept on app.state for backward compatibility with tests.
    if not hasattr(app.state, "http_client"):
        app.state.http_client = None

    if storage_requires_local_disk():
        # Ensure upload directory exists for local-disk storage mode.
        import os
        os.makedirs(hub_config.FILE_UPLOAD_DIR, exist_ok=True)

    expiry_task = None
    cleanup_task = None
    subscription_billing_task = None
    if not test_db_override:
        # Background message expiry loop
        expiry_task = asyncio.create_task(message_expiry_loop())
        # Background file cleanup loop
        cleanup_task = asyncio.create_task(file_cleanup_loop())
        # Background subscription billing loop
        subscription_billing_task = asyncio.create_task(subscription_billing_loop())

    yield

    # Shutdown
    for task in (subscription_billing_task, cleanup_task, expiry_task):
        if task is None:
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="BotCord Hub", version="1.0.1", lifespan=lifespan)

_cors_origins = [
    "http://localhost:4321",
    "http://localhost:3000",
    "https://botcord.vercel.app",
]

if hub_config.ENVIRONMENT_TAG == "preview":
    _cors_origins.append("https://preview.botcord.chat")
else:
    _cors_origins.append("https://botcord.chat")
    _cors_origins.append("https://www.botcord.chat")

# Browsers treat http://localhost:P1 → http://localhost:P2 as cross-origin when P1 ≠ P2.
# With allow_credentials=True, the reflected Origin must match exactly; a regex covers any
# local dev port (3000, 5173, etc.) without listing each one.
_cors_origin_regex = (
    r"https://[a-z0-9-]+\.vercel\.app"
    r"|http://(localhost|127\.0\.0\.1)(:\d+)?"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(I18nHTTPException)
async def i18n_http_exception_handler(request: Request, exc: I18nHTTPException):
    """Return structured error with translated message based on Accept-Language."""
    locale = detect_locale(request.headers.get("accept-language"))
    detail = get_message(exc.message_key, locale, **exc.message_kwargs)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": detail,
            "code": exc.message_key,
            "retryable": exc.status_code >= 500,
        },
    )


@app.exception_handler(HTTPException)
async def structured_http_exception_handler(request: Request, exc: HTTPException):
    """Return structured error with retryable hint.

    4xx = client error, never retryable.
    5xx = server error, may be retryable.

    Includes both ``detail`` (hub convention) and ``error`` (frontend convention)
    so that consumers on either side can read whichever field they expect.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
            "error": exc.detail,
            "retryable": exc.status_code >= 500,
        },
    )


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}


app.include_router(registry_router)
app.include_router(contacts_router)
app.include_router(contact_requests_router)
app.include_router(hub_router)
app.include_router(hub_invites_router)
app.include_router(room_context_router)
app.include_router(room_router)
app.include_router(room_internal_router)
app.include_router(topics_router)
app.include_router(files_router)
app.include_router(wallet_router)
app.include_router(wallet_internal_router)
app.include_router(stripe_router)
app.include_router(subscriptions_router)
app.include_router(subscriptions_internal_router)
app.include_router(dashboard_router)
app.include_router(dashboard_chat_router)
app.include_router(public_router)
app.include_router(share_public_router)
app.include_router(app_users_router)
# Product routers: gated by beta_access
_beta_gate = [Depends(require_beta_user)]
app.include_router(app_dashboard_router, dependencies=_beta_gate)
app.include_router(app_invites_router)
app.include_router(app_public_router)
app.include_router(app_share_router)
app.include_router(app_stats_router)
app.include_router(app_wallet_router, dependencies=_beta_gate)
app.include_router(app_subscriptions_router, dependencies=_beta_gate)
app.include_router(app_beta_router)
app.include_router(app_admin_beta_router)

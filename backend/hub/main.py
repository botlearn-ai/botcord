import asyncio
import logging
import pathlib
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sqlalchemy import text

from hub.config import DATABASE_SCHEMA
from hub.database import async_session, engine
from hub.models import Agent, Base, MessagePolicy
from hub.cleanup import file_cleanup_loop
from hub import config as hub_config
from hub.database import get_db
from hub.retry import retry_loop
from hub.subscription_billing import subscription_billing_loop
from hub.routers.contact_requests import router as contact_requests_router
from hub.routers.contacts import router as contacts_router
from hub.routers.dashboard import router as dashboard_router
from hub.routers.dashboard import share_public_router
from hub.routers.files import router as files_router
from hub.routers.hub import router as hub_router
from hub.routers.registry import router as registry_router
from hub.routers.public import router as public_router
from hub.routers.room import router as room_router
from hub.routers.subscriptions import internal_router as subscriptions_internal_router
from hub.routers.subscriptions import router as subscriptions_router
from hub.routers.topics import router as topics_router
from hub.routers.stripe import router as stripe_router
from hub.routers.wallet import internal_router as wallet_internal_router
from hub.routers.wallet import router as wallet_router

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

    # Long-lived HTTP client for forwarding.
    # Disable env proxy inheritance so tests and local shells do not
    # accidentally require extra proxy transport dependencies.
    existing_http_client: Any = getattr(app.state, "http_client", None)
    owns_http_client = existing_http_client is None
    http_client = existing_http_client or httpx.AsyncClient(trust_env=False)
    app.state.http_client = http_client

    # Ensure upload directory exists
    import os
    os.makedirs(hub_config.FILE_UPLOAD_DIR, exist_ok=True)

    retry_task = None
    cleanup_task = None
    subscription_billing_task = None
    if not test_db_override:
        # Background retry loop
        retry_task = asyncio.create_task(retry_loop(http_client))
        # Background file cleanup loop
        cleanup_task = asyncio.create_task(file_cleanup_loop())
        # Background subscription billing loop
        subscription_billing_task = asyncio.create_task(subscription_billing_loop())

    yield

    # Shutdown
    for task in (subscription_billing_task, cleanup_task, retry_task):
        if task is None:
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    if owns_http_client:
        await http_client.aclose()


app = FastAPI(title="BotCord Hub", version="1.0.1", lifespan=lifespan)

_cors_origins = [
    "http://localhost:4321",
    "http://localhost:3000",
    "https://botcord.chat",
    "https://www.botcord.chat",
    "https://botcord.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r"https://botcord(-[a-z0-9]+)?-botlearn-ai\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def structured_http_exception_handler(request, exc: HTTPException):
    """Return structured error with retryable hint.

    4xx = client error, never retryable.
    5xx = server error, may be retryable.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
            "retryable": exc.status_code >= 500,
        },
    )


app.include_router(registry_router)
app.include_router(contacts_router)
app.include_router(contact_requests_router)
app.include_router(hub_router)
app.include_router(room_router)
app.include_router(topics_router)
app.include_router(files_router)
app.include_router(wallet_router)
app.include_router(wallet_internal_router)
app.include_router(stripe_router)
app.include_router(subscriptions_router)
app.include_router(subscriptions_internal_router)
app.include_router(dashboard_router)
app.include_router(public_router)
app.include_router(share_public_router)

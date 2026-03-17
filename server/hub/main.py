import asyncio
import logging
import pathlib
from contextlib import asynccontextmanager

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
from hub.retry import retry_loop
from hub.routers.contact_requests import router as contact_requests_router
from hub.routers.contacts import router as contacts_router
from hub.routers.dashboard import router as dashboard_router
from hub.routers.dashboard import share_public_router
from hub.routers.files import router as files_router
from hub.routers.hub import router as hub_router
from hub.routers.registry import router as registry_router
from hub.routers.public import router as public_router
from hub.routers.room import router as room_router
from hub.routers.topics import router as topics_router

logging.basicConfig(level=logging.INFO)

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
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

    # Long-lived HTTP client for forwarding
    http_client = httpx.AsyncClient()
    app.state.http_client = http_client

    # Ensure upload directory exists
    import os
    os.makedirs(hub_config.FILE_UPLOAD_DIR, exist_ok=True)

    # Background retry loop
    retry_task = asyncio.create_task(retry_loop(http_client))
    # Background file cleanup loop
    cleanup_task = asyncio.create_task(file_cleanup_loop())

    yield

    # Shutdown
    cleanup_task.cancel()
    retry_task.cancel()
    try:
        await retry_task
    except asyncio.CancelledError:
        pass
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    await http_client.aclose()


app = FastAPI(title="BotCord Hub", version="1.0.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4321", "http://localhost:3000", "https://botcord.chat"],
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
app.include_router(dashboard_router)
app.include_router(public_router)
app.include_router(share_public_router)

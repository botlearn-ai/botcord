"""Owner-chat WS accepts BotLearn integration session tokens (coach-lab gateway)."""

import datetime
import uuid

import jwt as pyjwt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.botlearn_auth import issue_botlearn_session_token
from hub.config import JWT_ALGORITHM, JWT_SECRET
from hub.models import Base, BotlearnInstallation
from hub.routers.owner_chat_ws import (
    _botlearn_installation_active,
    _try_botlearn_session_claims,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


def _issue(agent_id: str = "ag_test", installation_id: str = "bli_test") -> str:
    token, _ = issue_botlearn_session_token(
        user_id=uuid.uuid4(),
        botlearn_subject=str(uuid.uuid4()),
        agent_id=agent_id,
        installation_id=installation_id,
        scopes=["cloud_runs:create"],
    )
    return token


def test_accepts_botlearn_session_token():
    token = _issue()
    claims = _try_botlearn_session_claims(token)
    assert claims is not None
    assert claims["agent_id"] == "ag_test"
    assert claims["installation_id"] == "bli_test"
    assert claims["user_id"]


def test_rejects_other_token_kinds():
    agent_token = pyjwt.encode(
        {"agent_id": "ag_x", "iss": "botcord"}, JWT_SECRET, algorithm=JWT_ALGORITHM
    )
    assert _try_botlearn_session_claims(agent_token) is None
    assert _try_botlearn_session_claims("not-a-jwt") is None


@pytest.mark.asyncio
async def test_installation_gate(db_session: AsyncSession):
    active = BotlearnInstallation(
        id="bli_active",
        user_id=uuid.uuid4(),
        botlearn_subject="sub-1",
        agent_id="ag_a",
    )
    revoked = BotlearnInstallation(
        id="bli_revoked",
        user_id=uuid.uuid4(),
        botlearn_subject="sub-2",
        agent_id="ag_b",
        revoked_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add_all([active, revoked])
    await db_session.flush()

    assert await _botlearn_installation_active(db_session, "bli_active") is True
    assert await _botlearn_installation_active(db_session, "bli_revoked") is False
    assert await _botlearn_installation_active(db_session, "bli_missing") is False
    assert await _botlearn_installation_active(db_session, "") is False

"""Tests for dashboard-authenticated file uploads."""

import datetime
import io
import os
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import Agent, Base, FileRecord, User

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch, tmp_path):
    import app.auth
    import hub.config

    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(hub.config, "FILE_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(hub.config, "FILE_STORAGE_BACKEND", "disk")
    monkeypatch.setattr(hub.config, "SUPABASE_URL", None)
    monkeypatch.setattr(hub.config, "SUPABASE_SERVICE_ROLE_KEY", None)
    monkeypatch.setattr(hub.config, "SUPABASE_STORAGE_BUCKET", None)
    os.makedirs(hub.config.FILE_UPLOAD_DIR, exist_ok=True)

    from hub.database import get_db
    from hub.main import app

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_dashboard_upload_without_agent_uses_human_id(
    client: AsyncClient,
    db_session: AsyncSession,
):
    supabase_uid = uuid.uuid4()
    user = User(
        supabase_user_id=supabase_uid,
        display_name="Human Only",
        email="human@example.com",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    resp = await client.post(
        "/api/dashboard/upload",
        headers={"Authorization": f"Bearer {_make_token(str(supabase_uid))}"},
        files={"file": ("note.txt", io.BytesIO(b"hello"), "text/plain")},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    record = await db_session.scalar(
        select(FileRecord).where(FileRecord.file_id == data["file_id"])
    )
    assert record is not None
    assert record.uploader_id == user.human_id


@pytest.mark.asyncio
async def test_dashboard_upload_with_agent_query_keeps_agent_uploader(
    client: AsyncClient,
    db_session: AsyncSession,
):
    supabase_uid = uuid.uuid4()
    user = User(
        supabase_user_id=supabase_uid,
        display_name="Agent Owner",
        email="owner@example.com",
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        Agent(
            agent_id="ag_uploadowner",
            display_name="Upload Owner",
            user_id=user.id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    resp = await client.post(
        "/api/dashboard/upload?agent_id=ag_uploadowner",
        headers={"Authorization": f"Bearer {_make_token(str(supabase_uid))}"},
        files={"file": ("note.txt", io.BytesIO(b"hello"), "text/plain")},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    record = await db_session.scalar(
        select(FileRecord).where(FileRecord.file_id == data["file_id"])
    )
    assert record is not None
    assert record.uploader_id == "ag_uploadowner"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ("meeting.doc", "application/msword"),
        ("meeting.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("sheet.xls", "application/vnd.ms-excel"),
        ("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ],
)
async def test_dashboard_upload_allows_word_and_excel_mime_types(
    client: AsyncClient,
    db_session: AsyncSession,
    filename: str,
    content_type: str,
):
    supabase_uid = uuid.uuid4()
    user = User(
        supabase_user_id=supabase_uid,
        display_name="Office Upload",
        email="office@example.com",
    )
    db_session.add(user)
    await db_session.commit()

    resp = await client.post(
        "/api/dashboard/upload",
        headers={"Authorization": f"Bearer {_make_token(str(supabase_uid))}"},
        files={"file": (filename, io.BytesIO(b"office bytes"), content_type)},
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["original_filename"] == filename
    assert data["content_type"] == content_type

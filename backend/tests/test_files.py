"""Tests for file upload/download and cleanup."""

import base64
import datetime
import io
import os
import time
import uuid
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
import httpx
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import text as sa_text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock, patch

from hub.models import Base, FileRecord

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


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, tmp_path):
    from hub import config

    # Override upload settings BEFORE importing app (lifespan uses them)
    original_dir = config.FILE_UPLOAD_DIR
    original_backend = config.FILE_STORAGE_BACKEND
    original_supabase_url = config.SUPABASE_URL
    original_supabase_service_role_key = config.SUPABASE_SERVICE_ROLE_KEY
    original_supabase_bucket = config.SUPABASE_STORAGE_BUCKET
    config.FILE_UPLOAD_DIR = str(tmp_path / "uploads")
    config.FILE_STORAGE_BACKEND = "disk"
    config.SUPABASE_URL = None
    config.SUPABASE_SERVICE_ROLE_KEY = None
    config.SUPABASE_STORAGE_BUCKET = None
    os.makedirs(config.FILE_UPLOAD_DIR, exist_ok=True)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
    config.FILE_UPLOAD_DIR = original_dir
    config.FILE_STORAGE_BACKEND = original_backend
    config.SUPABASE_URL = original_supabase_url
    config.SUPABASE_SERVICE_ROLE_KEY = original_supabase_service_role_key
    config.SUPABASE_STORAGE_BUCKET = original_supabase_bucket


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(
    client: AsyncClient, sk: SigningKey, pubkey_str: str, display_name: str = "test-agent"
):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": "test agent"},
    )
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()

    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200
    token = resp.json()["agent_token"]
    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _enable_supabase_storage():
    from hub import config

    config.FILE_STORAGE_BACKEND = "supabase"
    config.SUPABASE_URL = "https://project.supabase.co"
    config.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
    config.SUPABASE_STORAGE_BUCKET = "botcord-files"


def _supabase_response(
    status_code: int = 200,
    *,
    content: bytes = b"",
    text: str = "",
) -> httpx.Response:
    request = httpx.Request("GET", "https://project.supabase.co/storage/v1/object")
    return httpx.Response(status_code, request=request, content=content or text.encode())


# ===========================================================================
# Upload tests
# ===========================================================================


@pytest.mark.asyncio
async def test_upload_success(client: AsyncClient):
    sk, pubkey = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pubkey)

    file_content = b"Hello, this is a test file."
    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("test.txt", io.BytesIO(file_content), "text/plain")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["file_id"].startswith("f_")
    assert data["url"].endswith(f"/hub/files/{data['file_id']}")
    assert data["original_filename"] == "test.txt"
    assert data["content_type"] == "text/plain"
    assert data["size_bytes"] == len(file_content)
    assert "expires_at" in data


@pytest.mark.asyncio
async def test_upload_requires_auth(client: AsyncClient):
    file_content = b"no auth upload"
    resp = await client.post(
        "/hub/upload",
        files={"file": ("test.txt", io.BytesIO(file_content), "text/plain")},
    )
    assert resp.status_code in (401, 403, 422)


@pytest.mark.asyncio
async def test_upload_empty_file_rejected(client: AsyncClient):
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("empty.txt", io.BytesIO(b""), "text/plain")},
    )
    assert resp.status_code == 400
    assert "Empty" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_upload_exceeds_max_size(client: AsyncClient):
    from hub import config
    original = config.FILE_MAX_SIZE_BYTES
    config.FILE_MAX_SIZE_BYTES = 100  # 100 bytes limit

    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("big.bin", io.BytesIO(b"x" * 200), "application/octet-stream")},
    )
    assert resp.status_code == 413
    config.FILE_MAX_SIZE_BYTES = original


@pytest.mark.asyncio
async def test_upload_disallowed_mime_type(client: AsyncClient):
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("script.sh", io.BytesIO(b"#!/bin/bash"), "application/x-shellscript")},
    )
    assert resp.status_code == 400
    assert "MIME" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_upload_image_mime_allowed(client: AsyncClient):
    """Common MIME types like image/png should be allowed."""
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("photo.png", io.BytesIO(b"\x89PNG\r\n"), "image/png")},
    )
    assert resp.status_code == 200
    assert resp.json()["content_type"] == "image/png"


@pytest.mark.asyncio
async def test_upload_multiple_files_same_agent(client: AsyncClient):
    """Same agent can upload multiple files, each gets a unique file_id."""
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    file_ids = []
    for i in range(3):
        resp = await client.post(
            "/hub/upload",
            headers=_auth_header(token),
            files={"file": (f"file_{i}.txt", io.BytesIO(f"content {i}".encode()), "text/plain")},
        )
        assert resp.status_code == 200
        file_ids.append(resp.json()["file_id"])

    # All file_ids should be unique
    assert len(set(file_ids)) == 3


@pytest.mark.asyncio
async def test_upload_sanitizes_filename(client: AsyncClient):
    """Path traversal in filename should be stripped."""
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("../../etc/passwd", io.BytesIO(b"sneaky"), "text/plain")},
    )
    assert resp.status_code == 200
    # Filename should be sanitized — no path separators
    assert resp.json()["original_filename"] == "passwd"


@pytest.mark.asyncio
async def test_upload_success_supabase(client: AsyncClient, db_session: AsyncSession):
    from sqlalchemy import select as sa_select

    _enable_supabase_storage()
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.storage._supabase_request", new=AsyncMock(return_value=_supabase_response())) as mock_request:
        resp = await client.post(
            "/hub/upload",
            headers=_auth_header(token),
            files={"file": ("report.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["original_filename"] == "report.pdf"
    mock_request.assert_awaited_once()

    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == data["file_id"])
    )
    record = result.scalar_one()
    assert record.storage_backend == "supabase"
    assert record.disk_path is None
    assert record.storage_bucket == "botcord-files"
    assert record.storage_object_key == f"{data['file_id']}/report.pdf"


@pytest.mark.asyncio
async def test_upload_supabase_uses_ascii_storage_key_for_unicode_filename(
    client: AsyncClient,
    db_session: AsyncSession,
):
    from sqlalchemy import select as sa_select

    _enable_supabase_storage()
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.storage._supabase_request", new=AsyncMock(return_value=_supabase_response())) as mock_request:
        resp = await client.post(
            "/hub/upload",
            headers=_auth_header(token),
            files={
                "file": (
                    "BotLearn-完整战略蓝图-v4.0.md",
                    io.BytesIO(b"# plan"),
                    "text/markdown",
                )
            },
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["original_filename"] == "BotLearn-完整战略蓝图-v4.0.md"

    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == data["file_id"])
    )
    record = result.scalar_one()
    assert record.storage_object_key == f"{data['file_id']}/BotLearn-v4.0.md"

    path = mock_request.await_args.args[1]
    assert path.endswith(f"/{data['file_id']}/BotLearn-v4.0.md")
    assert "完整战略蓝图" not in path


# ===========================================================================
# Download tests
# ===========================================================================


@pytest.mark.asyncio
async def test_download_success(client: AsyncClient):
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    file_content = b"download me"
    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("dl.txt", io.BytesIO(file_content), "text/plain")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    # Download (no auth needed)
    dl_resp = await client.get(f"/hub/files/{file_id}")
    assert dl_resp.status_code == 200
    assert dl_resp.content == file_content
    assert "text/plain" in dl_resp.headers.get("content-type", "")


@pytest.mark.asyncio
async def test_download_content_disposition(client: AsyncClient):
    """Download should include the original filename in content-disposition."""
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("report.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    dl_resp = await client.get(f"/hub/files/{file_id}")
    assert dl_resp.status_code == 200
    cd = dl_resp.headers.get("content-disposition", "")
    assert "report.pdf" in cd


@pytest.mark.asyncio
async def test_download_not_found(client: AsyncClient):
    resp = await client.get("/hub/files/f_nonexistent1234567890abcdef")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_download_expired_file(client: AsyncClient, db_session: AsyncSession):
    sk, pubkey = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey)

    file_content = b"will expire"
    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("exp.txt", io.BytesIO(file_content), "text/plain")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    # Manually set expires_at to the past
    from sqlalchemy import update
    await db_session.execute(
        update(FileRecord)
        .where(FileRecord.file_id == file_id)
        .values(expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
    )
    await db_session.commit()

    dl_resp = await client.get(f"/hub/files/{file_id}")
    assert dl_resp.status_code == 404
    assert "expired" in dl_resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_download_disk_file_missing(client: AsyncClient, db_session: AsyncSession):
    """If the disk file is deleted externally, download should return 404."""
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("gone.txt", io.BytesIO(b"will vanish"), "text/plain")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    # Delete the disk file manually
    from sqlalchemy import select as sa_select
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    record = result.scalar_one()
    os.remove(record.disk_path)

    dl_resp = await client.get(f"/hub/files/{file_id}")
    assert dl_resp.status_code == 404
    assert "disk" in dl_resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_download_success_supabase(client: AsyncClient):
    _enable_supabase_storage()
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    with patch(
        "hub.storage._supabase_request",
        new=AsyncMock(
            side_effect=[
                _supabase_response(),
                _supabase_response(content=b"supabase bytes"),
            ]
        ),
    ):
        upload_resp = await client.post(
            "/hub/upload",
            headers=_auth_header(token),
            files={"file": ("report.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
        )
        assert upload_resp.status_code == 200
        file_id = upload_resp.json()["file_id"]

        dl_resp = await client.get(f"/hub/files/{file_id}")

    assert dl_resp.status_code == 200
    assert dl_resp.content == b"supabase bytes"
    assert "application/pdf" in dl_resp.headers.get("content-type", "")
    assert "report.pdf" in dl_resp.headers.get("content-disposition", "")


# ===========================================================================
# Cleanup tests
# ===========================================================================


@pytest.mark.asyncio
async def test_cleanup_removes_expired_files(client: AsyncClient, db_session: AsyncSession, tmp_path):
    """Upload a file, expire it, then verify cleanup deletes it."""
    sk, pubkey = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey)

    # Upload a file
    file_content = b"will be cleaned up"
    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("cleanup.txt", io.BytesIO(file_content), "text/plain")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    # Get the disk path
    from sqlalchemy import select as sa_select
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    record = result.scalar_one()
    disk_path = record.disk_path
    assert os.path.isfile(disk_path)

    # Set expires_at to the past
    from sqlalchemy import update
    await db_session.execute(
        update(FileRecord)
        .where(FileRecord.file_id == file_id)
        .values(expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
    )
    await db_session.commit()

    # Verify download returns 404 (expired)
    dl_resp = await client.get(f"/hub/files/{file_id}")
    assert dl_resp.status_code == 404

    # Run the real cleanup function
    from hub import cleanup as hub_cleanup

    @asynccontextmanager
    async def _test_async_session():
        yield db_session

    with patch.object(hub_cleanup, "async_session", _test_async_session):
        cleaned = await hub_cleanup._cleanup_expired_files()
    assert cleaned == 1

    # Verify disk file is gone but DB record is kept with storage marked cleaned
    assert not os.path.isfile(disk_path)
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    kept_record = result.scalar_one_or_none()
    assert kept_record is not None
    assert kept_record.storage_backend is None
    assert kept_record.disk_path is None
    assert kept_record.storage_object_key is None

    with patch.object(hub_cleanup, "async_session", _test_async_session):
        cleaned_again = await hub_cleanup._cleanup_expired_files()
    assert cleaned_again == 0

    # Verify download still returns 404 with file_expired error
    dl_resp2 = await client.get(f"/hub/files/{file_id}")
    assert dl_resp2.status_code == 404
    assert dl_resp2.json()["code"] == "file_expired"


@pytest.mark.asyncio
async def test_cleanup_removes_expired_supabase_files(client: AsyncClient, db_session: AsyncSession):
    from sqlalchemy import select as sa_select
    from sqlalchemy import update
    from hub import cleanup as hub_cleanup

    _enable_supabase_storage()
    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    @asynccontextmanager
    async def _test_async_session():
        yield db_session

    with patch("hub.storage._supabase_request", new=AsyncMock(return_value=_supabase_response())) as mock_request:
        with patch.object(hub_cleanup, "async_session", _test_async_session):
            upload_resp = await client.post(
                "/hub/upload",
                headers=_auth_header(token),
                files={"file": ("cleanup.txt", io.BytesIO(b"cleanup"), "text/plain")},
            )
            assert upload_resp.status_code == 200
            file_id = upload_resp.json()["file_id"]

            await db_session.execute(
                update(FileRecord)
                .where(FileRecord.file_id == file_id)
                .values(expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
            )
            await db_session.commit()

            deleted = await hub_cleanup._cleanup_expired_files()

    assert deleted == 1
    assert mock_request.await_count == 2
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    kept_record = result.scalar_one_or_none()
    assert kept_record is not None
    assert kept_record.storage_backend is None
    assert kept_record.disk_path is None
    assert kept_record.storage_object_key is None

    with patch.object(hub_cleanup, "async_session", _test_async_session):
        deleted_again = await hub_cleanup._cleanup_expired_files()
    assert deleted_again == 0
    assert mock_request.await_count == 2


# ===========================================================================
@pytest.mark.asyncio
async def test_cleanup_skips_record_on_delete_failure(client: AsyncClient, db_session: AsyncSession):
    """When storage deletion fails, the record should keep its storage coordinates."""
    from sqlalchemy import select as sa_select
    from sqlalchemy import update
    from hub import cleanup as hub_cleanup

    sk, pubkey = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pubkey)

    upload_resp = await client.post(
        "/hub/upload",
        headers=_auth_header(token),
        files={"file": ("fail.txt", io.BytesIO(b"fail"), "text/plain")},
    )
    assert upload_resp.status_code == 200
    file_id = upload_resp.json()["file_id"]

    await db_session.execute(
        update(FileRecord)
        .where(FileRecord.file_id == file_id)
        .values(expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
    )
    await db_session.commit()

    @asynccontextmanager
    async def _test_async_session():
        yield db_session

    with patch("hub.cleanup.delete_file", new=AsyncMock(side_effect=OSError("disk error"))):
        with patch.object(hub_cleanup, "async_session", _test_async_session):
            cleaned = await hub_cleanup._cleanup_expired_files()

    assert cleaned == 0
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    record = result.scalar_one()
    assert record.storage_backend == "disk"
    assert record.disk_path is not None
    assert record.storage_object_key is None


@pytest.mark.asyncio
async def test_file_records_storage_location_migration_normalizes_dirty_legacy_rows(
    db_session: AsyncSession,
):
    await db_session.execute(
        sa_text(
            """
            CREATE TEMPORARY TABLE file_records_migration_probe (
              file_id TEXT PRIMARY KEY,
              storage_backend TEXT NULL,
              disk_path TEXT NULL,
              storage_bucket TEXT NULL,
              storage_object_key TEXT NULL
            )
            """
        )
    )
    rows = [
        {
            "file_id": "null_leftover_coordinates",
            "storage_backend": None,
            "disk_path": "/tmp/cleaned-file",
            "storage_bucket": "legacy-bucket",
            "storage_object_key": "legacy/object.txt",
        },
        {
            "file_id": "disk_with_stale_object_key",
            "storage_backend": "disk",
            "disk_path": "/tmp/live-disk-file",
            "storage_bucket": "stale-bucket",
            "storage_object_key": "stale/object.txt",
        },
        {
            "file_id": "supabase_with_stale_disk_path",
            "storage_backend": "supabase",
            "disk_path": "/tmp/stale-local-file",
            "storage_bucket": "botcord-files",
            "storage_object_key": "live/object.txt",
        },
        {
            "file_id": "disk_missing_disk_path",
            "storage_backend": "disk",
            "disk_path": None,
            "storage_bucket": "stale-bucket",
            "storage_object_key": "stale/object.txt",
        },
        {
            "file_id": "supabase_missing_bucket",
            "storage_backend": "supabase",
            "disk_path": None,
            "storage_bucket": None,
            "storage_object_key": "missing/bucket.txt",
        },
        {
            "file_id": "supabase_missing_object_key",
            "storage_backend": "supabase",
            "disk_path": "/tmp/stale-local-file",
            "storage_bucket": "botcord-files",
            "storage_object_key": None,
        },
        {
            "file_id": "expired_backend",
            "storage_backend": "expired",
            "disk_path": "/tmp/expired-file",
            "storage_bucket": "legacy-bucket",
            "storage_object_key": "legacy/expired.txt",
        },
    ]
    for row in rows:
        await db_session.execute(
            sa_text(
                """
                INSERT INTO file_records_migration_probe (
                  file_id,
                  storage_backend,
                  disk_path,
                  storage_bucket,
                  storage_object_key
                )
                VALUES (
                  :file_id,
                  :storage_backend,
                  :disk_path,
                  :storage_bucket,
                  :storage_object_key
                )
                """
            ),
            row,
        )

    for statement in [
        """
        UPDATE file_records_migration_probe
        SET
          storage_backend = NULL,
          disk_path = NULL,
          storage_object_key = NULL
        WHERE storage_backend IS NULL
          OR storage_backend NOT IN ('disk', 'supabase')
        """,
        """
        UPDATE file_records_migration_probe
        SET
          storage_bucket = NULL,
          storage_object_key = NULL
        WHERE storage_backend = 'disk'
          AND disk_path IS NOT NULL
        """,
        """
        UPDATE file_records_migration_probe
        SET
          storage_backend = NULL,
          disk_path = NULL,
          storage_bucket = NULL,
          storage_object_key = NULL
        WHERE storage_backend = 'disk'
          AND disk_path IS NULL
        """,
        """
        UPDATE file_records_migration_probe
        SET disk_path = NULL
        WHERE storage_backend = 'supabase'
          AND storage_bucket IS NOT NULL
          AND storage_object_key IS NOT NULL
        """,
        """
        UPDATE file_records_migration_probe
        SET
          storage_backend = NULL,
          disk_path = NULL,
          storage_bucket = NULL,
          storage_object_key = NULL
        WHERE storage_backend = 'supabase'
          AND (
            storage_bucket IS NULL
            OR storage_object_key IS NULL
          )
        """,
    ]:
        await db_session.execute(sa_text(statement))

    result = await db_session.execute(
        sa_text(
            """
            SELECT
              file_id,
              storage_backend,
              disk_path,
              storage_bucket,
              storage_object_key
            FROM file_records_migration_probe
            """
        )
    )
    normalized = {row.file_id: dict(row._mapping) for row in result}

    assert normalized["null_leftover_coordinates"] == {
        "file_id": "null_leftover_coordinates",
        "storage_backend": None,
        "disk_path": None,
        "storage_bucket": "legacy-bucket",
        "storage_object_key": None,
    }
    assert normalized["disk_with_stale_object_key"] == {
        "file_id": "disk_with_stale_object_key",
        "storage_backend": "disk",
        "disk_path": "/tmp/live-disk-file",
        "storage_bucket": None,
        "storage_object_key": None,
    }
    assert normalized["supabase_with_stale_disk_path"] == {
        "file_id": "supabase_with_stale_disk_path",
        "storage_backend": "supabase",
        "disk_path": None,
        "storage_bucket": "botcord-files",
        "storage_object_key": "live/object.txt",
    }
    for cleaned_file_id in [
        "disk_missing_disk_path",
        "supabase_missing_bucket",
        "supabase_missing_object_key",
    ]:
        assert normalized[cleaned_file_id] == {
            "file_id": cleaned_file_id,
            "storage_backend": None,
            "disk_path": None,
            "storage_bucket": None,
            "storage_object_key": None,
        }
    assert normalized["expired_backend"] == {
        "file_id": "expired_backend",
        "storage_backend": None,
        "disk_path": None,
        "storage_bucket": "legacy-bucket",
        "storage_object_key": None,
    }

    for row in normalized.values():
        storage_backend = row["storage_backend"]
        disk_path = row["disk_path"]
        storage_bucket = row["storage_bucket"]
        storage_object_key = row["storage_object_key"]
        assert (
            storage_backend is None
            and disk_path is None
            and storage_object_key is None
        ) or (
            storage_backend == "disk"
            and disk_path is not None
            and storage_object_key is None
        ) or (
            storage_backend == "supabase"
            and disk_path is None
            and storage_bucket is not None
            and storage_object_key is not None
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "storage_backend,disk_path,storage_bucket,storage_object_key",
    [
        ("disk", None, "botcord-files", "orphan/mismatch.txt"),
        ("supabase", "/tmp/orphan-local-file", "botcord-files", None),
        ("supabase", None, None, "orphan/missing-bucket.txt"),
        ("expired", None, None, None),
    ],
)
async def test_file_record_storage_constraints_reject_invalid_locations(
    db_session: AsyncSession,
    storage_backend,
    disk_path,
    storage_bucket,
    storage_object_key,
):
    record = FileRecord(
        file_id=f"file_{uuid.uuid4().hex}",
        uploader_id="ag_test",
        original_filename="mismatch.txt",
        content_type="text/plain",
        size_bytes=8,
        storage_backend=storage_backend,
        disk_path=disk_path,
        storage_bucket=storage_bucket,
        storage_object_key=storage_object_key,
        expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(record)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "storage_backend,disk_path,storage_bucket,storage_object_key",
    [
        ("disk", "/tmp/uploaded-file", None, None),
        ("supabase", None, "botcord-files", "file/report.txt"),
    ],
)
async def test_file_record_storage_constraints_allow_valid_locations(
    db_session: AsyncSession,
    storage_backend,
    disk_path,
    storage_bucket,
    storage_object_key,
):
    record = FileRecord(
        file_id=f"file_{uuid.uuid4().hex}",
        uploader_id="ag_test",
        original_filename="valid.txt",
        content_type="text/plain",
        size_bytes=5,
        storage_backend=storage_backend,
        disk_path=disk_path,
        storage_bucket=storage_bucket,
        storage_object_key=storage_object_key,
        expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(record)
    await db_session.commit()
    assert record.id is not None


@pytest.mark.asyncio
async def test_file_record_storage_constraints_allow_cleaned_null_backend_update(
    db_session: AsyncSession,
):
    record = FileRecord(
        file_id=f"file_{uuid.uuid4().hex}",
        uploader_id="ag_test",
        original_filename="cleaned.txt",
        content_type="text/plain",
        size_bytes=5,
        storage_backend="supabase",
        disk_path=None,
        storage_bucket="botcord-files",
        storage_object_key="file/cleaned.txt",
        expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(record)
    await db_session.commit()

    record.storage_backend = None
    record.disk_path = None
    record.storage_object_key = None
    await db_session.commit()

    assert record.storage_backend is None
    assert record.disk_path is None
    assert record.storage_bucket == "botcord-files"
    assert record.storage_object_key is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "disk_path,storage_object_key",
    [
        ("/tmp/cleaned-local-file", None),
        (None, "cleaned/object.txt"),
    ],
)
async def test_file_record_storage_constraints_reject_null_backend_with_coordinates(
    db_session: AsyncSession,
    disk_path,
    storage_object_key,
):
    record = FileRecord(
        file_id=f"file_{uuid.uuid4().hex}",
        uploader_id="ag_test",
        original_filename="cleaned.txt",
        content_type="text/plain",
        size_bytes=5,
        storage_backend="disk",
        disk_path="/tmp/uploaded-file",
        storage_bucket="botcord-files",
        storage_object_key=None,
        expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(record)
    await db_session.commit()

    record.storage_backend = None
    record.disk_path = disk_path
    record.storage_object_key = storage_object_key
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_cleanup_rejects_mismatched_object_key_after_disk_delete(
    db_session: AsyncSession, tmp_path
):
    disk_path = tmp_path / "expired-disk-file"
    disk_path.write_bytes(b"disk")
    record = FileRecord(
        file_id=f"file_{uuid.uuid4().hex}",
        uploader_id="ag_test",
        original_filename="both.txt",
        content_type="text/plain",
        size_bytes=4,
        storage_backend="disk",
        disk_path=str(disk_path),
        storage_bucket="botcord-files",
        storage_object_key="orphan/both.txt",
        expires_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(record)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


# to_text() with attachments
# ===========================================================================


class TestToTextAttachments:

    def _make_envelope(self, **overrides):
        from hub.schemas import MessageEnvelope

        defaults = {
            "v": "a2a/0.1",
            "msg_id": str(uuid.uuid4()),
            "ts": int(time.time()),
            "from": "ag_alice",
            "to": "ag_bob",
            "type": "message",
            "reply_to": None,
            "ttl_sec": 3600,
            "payload": {"text": "hello"},
            "payload_hash": "sha256:abc",
            "sig": {"alg": "ed25519", "key_id": "k1", "value": "fake"},
        }
        defaults.update(overrides)
        return MessageEnvelope(**defaults)

class TestGenerateFileId:

    def test_format(self):
        from hub.id_generators import generate_file_id
        fid = generate_file_id()
        assert fid.startswith("f_")
        assert len(fid) == 34  # "f_" + 32 hex chars

    def test_uniqueness(self):
        from hub.id_generators import generate_file_id
        ids = {generate_file_id() for _ in range(100)}
        assert len(ids) == 100


class TestToTextAttachments:

    def _make_envelope(self, **overrides):
        from hub.schemas import MessageEnvelope

        defaults = {
            "v": "a2a/0.1",
            "msg_id": str(uuid.uuid4()),
            "ts": int(time.time()),
            "from": "ag_alice",
            "to": "ag_bob",
            "type": "message",
            "reply_to": None,
            "ttl_sec": 3600,
            "payload": {"text": "hello"},
            "payload_hash": "sha256:abc",
            "sig": {"alg": "ed25519", "key_id": "k1", "value": "fake"},
        }
        defaults.update(overrides)
        return MessageEnvelope(**defaults)

    def test_no_attachments(self):
        env = self._make_envelope()
        text = env.to_text()
        assert "Attachments" not in text
        assert text == "ag_alice says: hello"

    def test_with_attachments(self):
        env = self._make_envelope(payload={
            "text": "here is the file",
            "attachments": [
                {
                    "filename": "report.pdf",
                    "url": "/hub/files/f_abc123",
                    "size_bytes": 12345,
                }
            ],
        })
        text = env.to_text()
        assert "【Attachments】" in text
        assert "📎 report.pdf" in text
        assert "12345 bytes" in text
        assert "/hub/files/f_abc123" in text

    def test_with_multiple_attachments(self):
        env = self._make_envelope(payload={
            "text": "two files",
            "attachments": [
                {"filename": "a.txt", "url": "/hub/files/f_1"},
                {"filename": "b.png", "url": "/hub/files/f_2", "size_bytes": 999},
            ],
        })
        text = env.to_text()
        assert "📎 a.txt" in text
        assert "📎 b.png" in text
        assert "999 bytes" in text

    def test_attachments_with_topic_goal(self):
        env = self._make_envelope(
            topic="task_001",
            goal="send report",
            payload={
                "text": "done",
                "attachments": [{"filename": "r.pdf", "url": "/hub/files/f_x"}],
            },
        )
        text = env.to_text(topic_id="tp_abc")
        lines = text.split("\n")
        assert lines[0] == "【Topic: task_001 | ID: tp_abc】"
        assert lines[1] == "【Goal: send report】"
        assert "【Attachments】" in text
        assert "📎 r.pdf" in text

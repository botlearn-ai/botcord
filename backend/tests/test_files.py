"""Tests for file upload/download and cleanup."""

import base64
import datetime
import io
import os
import time
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

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

    # Override upload dir BEFORE importing app (lifespan uses it)
    original_dir = config.FILE_UPLOAD_DIR
    config.FILE_UPLOAD_DIR = str(tmp_path / "uploads")
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
    assert data["url"] == f"/hub/files/{data['file_id']}"
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

    # Manually run cleanup logic (simulating what the background task does)
    now = datetime.datetime.now(datetime.timezone.utc)
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.expires_at <= now)
    )
    expired_records = list(result.scalars().all())
    assert len(expired_records) == 1

    for rec in expired_records:
        try:
            os.remove(rec.disk_path)
        except FileNotFoundError:
            pass
        await db_session.delete(rec)
    await db_session.commit()

    # Verify disk file and DB record are gone
    assert not os.path.isfile(disk_path)
    result = await db_session.execute(
        sa_select(FileRecord).where(FileRecord.file_id == file_id)
    )
    assert result.scalar_one_or_none() is None


# ===========================================================================
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
        text = env.to_text()
        lines = text.split("\n")
        assert lines[0] == "【Topic: task_001】"
        assert lines[1] == "【Goal: send report】"
        assert "【Attachments】" in text
        assert "📎 r.pdf" in text

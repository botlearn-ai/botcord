"""File upload and download endpoints."""

from __future__ import annotations

import asyncio
import datetime
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub import config as hub_config
from hub.database import get_db
from hub.id_generators import generate_file_id
from hub.models import FileRecord
from hub.schemas import FileUploadResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hub", tags=["files"])

# Allowed MIME type prefixes — reject obviously dangerous types
_ALLOWED_MIME_PREFIXES = (
    "text/",
    "image/",
    "audio/",
    "video/",
    "application/pdf",
    "application/json",
    "application/xml",
    "application/zip",
    "application/gzip",
    "application/octet-stream",
)


def _is_mime_allowed(content_type: str) -> bool:
    ct = content_type.lower()
    return any(ct.startswith(prefix) for prefix in _ALLOWED_MIME_PREFIXES)


@router.post("/upload", response_model=FileUploadResponse)
async def upload_file(
    file: UploadFile,
    agent_id: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Upload a file. Returns metadata including a download URL and expiration time."""
    content_type = file.content_type or "application/octet-stream"
    if not _is_mime_allowed(content_type):
        raise HTTPException(status_code=400, detail=f"MIME type not allowed: {content_type}")

    # Read file in chunks, enforce size limit
    chunks: list[bytes] = []
    total_size = 0
    while True:
        chunk = await file.read(64 * 1024)  # 64 KB chunks
        if not chunk:
            break
        total_size += len(chunk)
        if total_size > hub_config.FILE_MAX_SIZE_BYTES:
            chunks.clear()
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Max size: {hub_config.FILE_MAX_SIZE_BYTES} bytes",
            )
        chunks.append(chunk)

    if total_size == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    data = b"".join(chunks)
    file_id = generate_file_id()
    disk_path = os.path.join(hub_config.FILE_UPLOAD_DIR, file_id)
    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(hours=hub_config.FILE_TTL_HOURS)

    # Write to disk (non-blocking)
    await asyncio.to_thread(_write_file, disk_path, data)

    # Sanitize filename: strip path separators and limit length
    raw_name = file.filename or "upload"
    original_filename = os.path.basename(raw_name).strip()[:200] or "upload"
    record = FileRecord(
        file_id=file_id,
        uploader_id=agent_id,
        original_filename=original_filename,
        content_type=content_type,
        size_bytes=total_size,
        disk_path=disk_path,
        expires_at=expires_at,
    )
    db.add(record)
    await db.commit()

    logger.info(
        "File uploaded: file_id=%s uploader=%s size=%d content_type=%s expires=%s",
        file_id, agent_id, total_size, content_type, expires_at.isoformat(),
    )

    return FileUploadResponse(
        file_id=file_id,
        url=f"/hub/files/{file_id}",
        original_filename=original_filename,
        content_type=content_type,
        size_bytes=total_size,
        expires_at=expires_at.isoformat(),
    )


def _write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


@router.get("/files/{file_id}")
async def download_file(
    file_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Download a file by its ID. Public access (file_id is unguessable)."""
    result = await db.execute(
        select(FileRecord).where(FileRecord.file_id == file_id)
    )
    record = result.scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=404, detail="File not found")

    # Check expiration
    expires = record.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    if datetime.datetime.now(datetime.timezone.utc) >= expires:
        raise HTTPException(status_code=404, detail="File expired")

    if not os.path.isfile(record.disk_path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=record.disk_path,
        media_type=record.content_type,
        filename=record.original_filename,
    )

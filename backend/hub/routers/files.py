"""File upload and download endpoints."""

from __future__ import annotations

import datetime
import logging
import os
from urllib.parse import quote

from fastapi import APIRouter, Depends, UploadFile
from hub.i18n import I18nHTTPException
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub import config as hub_config
from hub.database import get_db
from hub.id_generators import generate_file_id
from hub.models import FileRecord
from hub.schemas import FileUploadResponse
from hub.storage import load_file, store_file

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
        raise I18nHTTPException(status_code=400, message_key="mime_type_not_allowed", content_type=content_type)

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
            raise I18nHTTPException(
                status_code=413,
                message_key="file_too_large",
                max_size=hub_config.FILE_MAX_SIZE_BYTES,
            )
        chunks.append(chunk)

    if total_size == 0:
        raise I18nHTTPException(status_code=400, message_key="empty_file")

    # Sanitize filename: strip path separators and limit length
    raw_name = file.filename or "upload"
    original_filename = os.path.basename(raw_name).strip()[:200] or "upload"
    data = b"".join(chunks)
    file_id = generate_file_id()
    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(hours=hub_config.FILE_TTL_HOURS)
    location = await store_file(
        file_id=file_id,
        original_filename=original_filename,
        content_type=content_type,
        data=data,
    )
    record = FileRecord(
        file_id=file_id,
        uploader_id=agent_id,
        original_filename=original_filename,
        content_type=content_type,
        size_bytes=total_size,
        storage_backend=location.storage_backend,
        disk_path=location.disk_path,
        storage_bucket=location.storage_bucket,
        storage_object_key=location.storage_object_key,
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
        raise I18nHTTPException(status_code=404, message_key="file_not_found")

    # Check expiration
    expires = record.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    if datetime.datetime.now(datetime.timezone.utc) >= expires:
        raise I18nHTTPException(status_code=404, message_key="file_expired")

    if record.storage_backend == "disk" and record.disk_path:
        if not os.path.isfile(record.disk_path):
            raise I18nHTTPException(status_code=404, message_key="file_not_found_on_disk")
        return FileResponse(
            path=record.disk_path,
            media_type=record.content_type,
            filename=record.original_filename,
        )

    try:
        data = await load_file(record)
    except FileNotFoundError:
        raise I18nHTTPException(status_code=404, message_key="file_not_found_on_disk")

    return Response(
        content=data,
        media_type=record.content_type,
        headers={
            "Content-Disposition": _build_content_disposition(record.original_filename),
        },
    )


def _build_content_disposition(filename: str) -> str:
    quoted = quote(filename, safe="")
    return f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quoted}'

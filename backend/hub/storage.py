"""Storage helpers for uploaded files."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from hub import config as hub_config
from hub.models import FileRecord

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StoredFileLocation:
    storage_backend: str
    disk_path: str | None = None
    storage_bucket: str | None = None
    storage_object_key: str | None = None


def storage_requires_local_disk() -> bool:
    return hub_config.FILE_STORAGE_BACKEND == "disk"


async def store_file(
    *,
    file_id: str,
    original_filename: str,
    content_type: str,
    data: bytes,
) -> StoredFileLocation:
    if hub_config.FILE_STORAGE_BACKEND == "disk":
        disk_path = os.path.join(hub_config.FILE_UPLOAD_DIR, file_id)
        await asyncio.to_thread(_write_file, disk_path, data)
        return StoredFileLocation(storage_backend="disk", disk_path=disk_path)

    if hub_config.FILE_STORAGE_BACKEND == "supabase":
        _validate_supabase_config()
        object_key = f"{file_id}/{_storage_object_filename(original_filename)}"
        await _supabase_request(
            "POST",
            f"/storage/v1/object/{_quoted_bucket_and_key(hub_config.SUPABASE_STORAGE_BUCKET, object_key)}",
            content=data,
            headers={
                "Content-Type": content_type,
                "x-upsert": "false",
            },
            expected_statuses={200, 201},
        )
        return StoredFileLocation(
            storage_backend="supabase",
            storage_bucket=hub_config.SUPABASE_STORAGE_BUCKET,
            storage_object_key=object_key,
        )

    raise RuntimeError(f"Unsupported FILE_STORAGE_BACKEND: {hub_config.FILE_STORAGE_BACKEND}")


async def load_file(record: FileRecord) -> bytes:
    backend = _record_backend(record)
    if backend == "disk":
        if not record.disk_path or not os.path.isfile(record.disk_path):
            raise FileNotFoundError(record.disk_path or "<missing disk_path>")
        return await asyncio.to_thread(_read_file, record.disk_path)

    if backend == "supabase":
        bucket = record.storage_bucket or hub_config.SUPABASE_STORAGE_BUCKET
        if not bucket or not record.storage_object_key:
            raise FileNotFoundError("Missing Supabase storage coordinates")
        response = await _supabase_request(
            "GET",
            f"/storage/v1/object/{_quoted_bucket_and_key(bucket, record.storage_object_key)}",
            expected_statuses={200},
        )
        return response.content

    raise FileNotFoundError(f"Unsupported storage backend: {backend}")


async def delete_file(record: FileRecord) -> None:
    backend = _record_backend(record)
    if backend == "disk":
        if record.disk_path:
            await asyncio.to_thread(os.remove, record.disk_path)
        return

    if backend == "supabase":
        bucket = record.storage_bucket or hub_config.SUPABASE_STORAGE_BUCKET
        if not bucket or not record.storage_object_key:
            return
        await _supabase_request(
            "DELETE",
            "/storage/v1/object/{bucket}".format(bucket=quote(bucket, safe="")),
            json={"prefixes": [record.storage_object_key]},
            expected_statuses={200},
        )
        return

    logger.warning("Skipping delete for unsupported storage backend %s", backend)


def _record_backend(record: FileRecord) -> str:
    return record.storage_backend or ("disk" if record.disk_path else "supabase")


def _write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def _read_file(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _storage_object_filename(original_filename: str) -> str:
    """Return an ASCII-only object key segment accepted by Supabase Storage."""
    name = os.path.basename(original_filename).strip()[:200] or "upload"
    stem, ext = os.path.splitext(name)
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem)
    safe_stem = re.sub(r"-+", "-", safe_stem).strip("._-")
    safe_ext = re.sub(r"[^A-Za-z0-9.]+", "", ext)[:32]
    safe_name = f"{safe_stem or 'upload'}{safe_ext}"
    return safe_name[:200] or "upload"


def _validate_supabase_config() -> None:
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", hub_config.SUPABASE_URL),
            ("SUPABASE_SERVICE_ROLE_KEY", hub_config.SUPABASE_SERVICE_ROLE_KEY),
            ("SUPABASE_STORAGE_BUCKET", hub_config.SUPABASE_STORAGE_BUCKET),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Supabase storage is enabled but required settings are missing: "
            + ", ".join(missing)
        )


def _quoted_bucket_and_key(bucket: str | None, object_key: str) -> str:
    if not bucket:
        raise RuntimeError("SUPABASE_STORAGE_BUCKET is required")
    quoted_key = "/".join(quote(part, safe="") for part in object_key.split("/"))
    return f"{quote(bucket, safe='')}/{quoted_key}"


async def _supabase_request(
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    expected_statuses: set[int] | None = None,
    **kwargs: Any,
) -> httpx.Response:
    _validate_supabase_config()
    request_headers = {
        "Authorization": f"Bearer {hub_config.SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": hub_config.SUPABASE_SERVICE_ROLE_KEY,
        **(headers or {}),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.request(
            method,
            f"{hub_config.SUPABASE_URL}{path}",
            headers=request_headers,
            **kwargs,
        )

    allowed = expected_statuses or {200}
    if response.status_code in allowed:
        return response

    detail = response.text.strip()
    logger.error(
        "Supabase storage request failed: %s %s -> %s %s",
        method,
        path,
        response.status_code,
        detail,
    )
    raise HTTPException(
        status_code=502,
        detail=f"Supabase storage request failed: {response.status_code}",
    )

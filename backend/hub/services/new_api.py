"""new-api provisioning client for Cloud Agent runtime tokens."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.models import NewApiCredential, User

logger = logging.getLogger(__name__)


class NewApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class NewApiBalance:
    configured: bool
    provisioned: bool
    api_base_url: str | None
    new_api_user_id: int | None
    new_api_username: str | None
    token_id: int | None
    token_name: str | None
    quota: int
    used_quota: int
    token_remain_quota: int
    token_used_quota: int
    quota_per_usd: float

    @property
    def balance_usd(self) -> float:
        return self.quota / self.quota_per_usd if self.quota_per_usd > 0 else 0.0

    @property
    def token_balance_usd(self) -> float:
        if self.quota_per_usd <= 0:
            return 0.0
        return self.token_remain_quota / self.quota_per_usd


class NewApiService:
    """Provision and refresh per-user new-api credentials.

    The service is intentionally optional. If ``NEW_API_BASE_URL`` or
    ``NEW_API_INTERNAL_SECRET`` is absent, callers receive ``None``/an
    unconfigured balance and existing Cloud Agent flows continue unchanged.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        internal_secret: str | None = None,
        initial_credit_usd: float | None = None,
        timeout_seconds: float | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = (
            base_url.rstrip("/")
            if base_url is not None
            else hub_config.NEW_API_BASE_URL
        )
        self._internal_secret = (
            internal_secret
            if internal_secret is not None
            else hub_config.NEW_API_INTERNAL_SECRET
        )
        self._initial_credit_usd = (
            hub_config.NEW_API_INITIAL_CREDIT_USD
            if initial_credit_usd is None
            else initial_credit_usd
        )
        self._timeout_seconds = (
            hub_config.NEW_API_REQUEST_TIMEOUT_SECONDS
            if timeout_seconds is None
            else timeout_seconds
        )
        self._http_client = http_client

    def configured(self) -> bool:
        return bool(self._base_url and self._internal_secret)

    async def ensure_credential(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        force_refresh: bool = False,
    ) -> NewApiCredential | None:
        if not self.configured():
            return None

        existing = await db.scalar(
            select(NewApiCredential).where(NewApiCredential.user_id == user_id)
        )
        if existing is not None and existing.api_key and not force_refresh:
            return existing

        user = await db.scalar(select(User).where(User.id == user_id))
        payload = {
            "external_user_id": str(user_id),
            "display_name": user.display_name if user is not None else str(user_id),
            "initial_usd": self._initial_credit_usd,
        }
        data = await self._request("POST", "/api/botcord/provision", payload)
        credential = await self._upsert_credential(
            db,
            user_id=user_id,
            data=data,
            require_api_key=True,
        )
        await db.flush()
        return credential

    async def get_balance(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
    ) -> NewApiBalance:
        if not self.configured():
            existing = await db.scalar(
                select(NewApiCredential).where(NewApiCredential.user_id == user_id)
            )
            return _balance_from_credential(existing, configured=False)

        existing = await self.ensure_credential(db, user_id=user_id)
        if existing is None:
            return _balance_from_credential(None, configured=False)

        data = await self._request(
            "POST",
            "/api/botcord/balance",
            {"external_user_id": str(user_id)},
        )
        credential = await self._upsert_credential(
            db,
            user_id=user_id,
            data=data,
            require_api_key=False,
        )
        await db.flush()
        return _balance_from_credential(credential, configured=True)

    def runtime_env(self, credential: NewApiCredential | None) -> dict[str, str]:
        if credential is None or not credential.api_key:
            return {}
        base_url = credential.api_base_url.rstrip("/")
        v1_url = f"{base_url}/v1"
        api_key = credential.api_key
        return {
            "NEW_API_BASE_URL": base_url,
            "NEW_API_API_KEY": api_key,
            "NEW_API_OPENAI_BASE_URL": v1_url,
            "OPENAI_BASE_URL": v1_url,
            "OPENAI_API_KEY": api_key,
            "ANTHROPIC_BASE_URL": v1_url,
            "ANTHROPIC_API_KEY": api_key,
            "DEEPSEEK_BASE_URL": v1_url,
            "DEEPSEEK_API_KEY": api_key,
        }

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._base_url or not self._internal_secret:
            raise NewApiError("new_api_not_configured", "new-api is not configured")

        url = f"{self._base_url}{path}"
        headers = {"Authorization": f"Bearer {self._internal_secret}"}
        try:
            if self._http_client is not None:
                response = await self._http_client.request(
                    method,
                    url,
                    headers=headers,
                    json=payload,
                    timeout=self._timeout_seconds,
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                    response = await client.request(
                        method,
                        url,
                        headers=headers,
                        json=payload,
                    )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as exc:
            raise NewApiError(
                "new_api_unavailable",
                f"new-api request failed: {exc.__class__.__name__}",
            ) from exc
        except httpx.HTTPError as exc:
            raise NewApiError("new_api_http_error", str(exc)) from exc

        parsed: dict[str, Any] | None = None
        try:
            parsed = response.json()
        except Exception:
            parsed = None
        if response.status_code >= 400:
            message = _response_message(parsed) or f"new-api HTTP {response.status_code}"
            raise NewApiError("new_api_error", message)
        if not isinstance(parsed, dict) or not parsed.get("success", False):
            message = _response_message(parsed) or "new-api returned an unsuccessful response"
            raise NewApiError("new_api_error", message)
        data = parsed.get("data")
        if not isinstance(data, dict):
            raise NewApiError("new_api_bad_response", "new-api response missing data")
        return data

    async def _upsert_credential(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        data: dict[str, Any],
        require_api_key: bool,
    ) -> NewApiCredential:
        token = data.get("token")
        if not isinstance(token, dict):
            raise NewApiError("new_api_bad_response", "new-api response missing token")
        api_key = _string(token.get("api_key"))
        if require_api_key and not api_key:
            raise NewApiError("new_api_bad_response", "new-api response missing api_key")

        existing = await db.scalar(
            select(NewApiCredential).where(NewApiCredential.user_id == user_id)
        )
        if existing is None:
            existing = NewApiCredential(
                user_id=user_id,
                new_api_user_id=_int(data.get("user_id")),
                new_api_username=_string(data.get("username")) or "",
                token_id=_int(token.get("id")),
                token_name=_string(token.get("name")) or "",
                api_base_url=self._base_url or "",
                api_key=api_key or "",
                quota=0,
                used_quota=0,
                token_remain_quota=0,
                token_used_quota=0,
                quota_per_usd=500000.0,
            )
            db.add(existing)

        existing.new_api_user_id = _int(data.get("user_id"))
        existing.new_api_username = _string(data.get("username")) or existing.new_api_username
        existing.token_id = _int(token.get("id"))
        existing.token_name = _string(token.get("name")) or existing.token_name
        existing.api_base_url = self._base_url or existing.api_base_url
        if api_key:
            existing.api_key = api_key
        existing.quota = _int(data.get("quota"))
        existing.used_quota = _int(data.get("used_quota"))
        existing.token_remain_quota = _int(token.get("remain_quota"))
        existing.token_used_quota = _int(token.get("used_quota"))
        existing.quota_per_usd = (
            _float(data.get("quota_per_usd")) or existing.quota_per_usd or 500000.0
        )
        return existing


def _balance_from_credential(
    credential: NewApiCredential | None,
    *,
    configured: bool,
) -> NewApiBalance:
    if credential is None:
        return NewApiBalance(
            configured=configured,
            provisioned=False,
            api_base_url=None,
            new_api_user_id=None,
            new_api_username=None,
            token_id=None,
            token_name=None,
            quota=0,
            used_quota=0,
            token_remain_quota=0,
            token_used_quota=0,
            quota_per_usd=500000.0,
        )
    return NewApiBalance(
        configured=configured,
        provisioned=True,
        api_base_url=credential.api_base_url,
        new_api_user_id=credential.new_api_user_id,
        new_api_username=credential.new_api_username,
        token_id=credential.token_id,
        token_name=credential.token_name,
        quota=credential.quota,
        used_quota=credential.used_quota,
        token_remain_quota=credential.token_remain_quota,
        token_used_quota=credential.token_used_quota,
        quota_per_usd=credential.quota_per_usd,
    )


def _response_message(parsed: dict[str, Any] | None) -> str | None:
    if not isinstance(parsed, dict):
        return None
    message = parsed.get("message")
    return message if isinstance(message, str) and message else None


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def _float(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0

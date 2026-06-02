from __future__ import annotations

import json
import uuid

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import Base, NewApiCredential, User
from hub.services.new_api import NewApiService
from tests.test_app.conftest import create_test_engine


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


def _new_api_response(
    api_key: str | None = "sk-user",
    *,
    quota: int = 2_500_000,
    used_quota: int = 0,
    token_remain_quota: int = 2_500_000,
    token_used_quota: int = 0,
) -> dict:
    token = {
        "id": 77,
        "name": "BotCord Cloud Agent",
        "remain_quota": token_remain_quota,
        "used_quota": token_used_quota,
        "unlimited_quota": False,
    }
    if api_key is not None:
        token["api_key"] = api_key
    return {
        "success": True,
        "message": "",
        "data": {
            "external_user_id": "ignored",
            "user_id": 42,
            "username": "bc_test",
            "quota": quota,
            "used_quota": used_quota,
            "quota_per_usd": 500_000.0,
            "balance_usd": 5,
            "used_usd": 0,
            "token": token,
        },
    }


@pytest.mark.asyncio
async def test_ensure_credential_provisions_and_builds_runtime_env(db_session):
    user_id = uuid.uuid4()
    db_session.add(
        User(
            id=user_id,
            display_name="Ada",
            email="ada@example.test",
            supabase_user_id=uuid.uuid4(),
        )
    )
    await db_session.flush()

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.url.path == "/api/botcord/provision"
        assert request.headers["Authorization"] == "Bearer secret"
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["initial_usd"] == 5.0
        return httpx.Response(200, json=_new_api_response())

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as http_client:
        service = NewApiService(
            base_url="https://new-api.test/",
            internal_secret="secret",
            credential_encryption_key="test-encryption-secret",
            http_client=http_client,
        )
        credential = await service.ensure_credential(db_session, user_id=user_id)
        await db_session.commit()

    assert credential is not None
    assert credential.api_key_ciphertext.startswith("fernet:")
    assert credential.api_key_ciphertext != "sk-user"
    assert credential.new_api_user_id == 42
    assert len(seen) == 1

    persisted = await db_session.scalar(
        select(NewApiCredential).where(NewApiCredential.user_id == user_id)
    )
    assert persisted is not None
    assert persisted.api_key_ciphertext.startswith("fernet:")
    assert persisted.api_key_ciphertext != "sk-user"
    assert persisted.token_remain_quota == 2_500_000

    env = service.runtime_env(persisted)
    assert env["OPENAI_API_KEY"] == "sk-user"
    assert env["OPENAI_BASE_URL"] == "https://new-api.test/v1"
    assert env["DEEPSEEK_API_KEY"] == "sk-user"
    # Anthropic SDK appends /v1/messages itself, so its base URL has no /v1.
    assert env["ANTHROPIC_BASE_URL"] == "https://new-api.test"
    assert env["ANTHROPIC_API_KEY"] == "sk-user"


@pytest.mark.asyncio
async def test_balance_refresh_does_not_require_returning_api_key(db_session):
    user_id = uuid.uuid4()
    db_session.add(
        NewApiCredential(
            user_id=user_id,
            new_api_user_id=42,
            new_api_username="bc_test",
            token_id=77,
            token_name="BotCord Cloud Agent",
            api_base_url="https://new-api.test",
            api_key_ciphertext="sk-existing",
            quota=1,
            used_quota=0,
            token_remain_quota=1,
            token_used_quota=0,
            quota_per_usd=500_000.0,
        )
    )
    await db_session.flush()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/botcord/balance"
        return httpx.Response(200, json=_new_api_response(api_key=None))

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as http_client:
        service = NewApiService(
            base_url="https://new-api.test",
            internal_secret="secret",
            credential_encryption_key="test-encryption-secret",
            http_client=http_client,
        )
        balance = await service.get_balance(db_session, user_id=user_id)
        await db_session.commit()

    assert balance.provisioned is True
    assert balance.balance_usd == 5
    credential = await db_session.scalar(
        select(NewApiCredential).where(NewApiCredential.user_id == user_id)
    )
    assert credential is not None
    assert credential.api_key_ciphertext.startswith("fernet:")
    assert credential.api_key_ciphertext != "sk-existing"
    assert service.runtime_env(credential)["OPENAI_API_KEY"] == "sk-existing"


@pytest.mark.asyncio
async def test_balance_is_read_only_for_unprovisioned_user(db_session):
    user_id = uuid.uuid4()

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected new-api request: {request.url.path}")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as http_client:
        service = NewApiService(
            base_url="https://new-api.test",
            internal_secret="secret",
            credential_encryption_key="test-encryption-secret",
            http_client=http_client,
        )
        balance = await service.get_balance(db_session, user_id=user_id)
        await db_session.commit()

    assert balance.configured is True
    assert balance.provisioned is False
    assert balance.balance_usd == 0
    credential = await db_session.scalar(
        select(NewApiCredential).where(NewApiCredential.user_id == user_id)
    )
    assert credential is None


@pytest.mark.asyncio
async def test_balance_uses_token_remaining_quota_when_user_quota_drifts(db_session):
    user_id = uuid.uuid4()
    db_session.add(
        NewApiCredential(
            user_id=user_id,
            new_api_user_id=42,
            new_api_username="bc_test",
            token_id=77,
            token_name="BotCord Cloud Agent",
            api_base_url="https://new-api.test",
            api_key_ciphertext="sk-existing",
            quota=9_000_000,
            used_quota=0,
            token_remain_quota=9_000_000,
            token_used_quota=0,
            quota_per_usd=500_000.0,
        )
    )
    await db_session.flush()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/botcord/balance"
        return httpx.Response(
            200,
            json=_new_api_response(
                api_key=None,
                quota=9_000_000,
                token_remain_quota=2_500_000,
            ),
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as http_client:
        service = NewApiService(
            base_url="https://new-api.test",
            internal_secret="secret",
            credential_encryption_key="test-encryption-secret",
            http_client=http_client,
        )
        balance = await service.get_balance(db_session, user_id=user_id)
        await db_session.commit()

    assert balance.quota == 9_000_000
    assert balance.token_remain_quota == 2_500_000
    assert balance.balance_usd == 5
    assert balance.token_balance_usd == 5

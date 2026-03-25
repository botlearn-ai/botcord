"""Tests for /api/beta (user) and /api/admin/beta (admin) endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from unittest.mock import AsyncMock, patch

from hub.models import Base, BetaInviteCode, BetaWaitlistEntry, User
from hub.enums import BetaCodeStatus, BetaWaitlistStatus

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


async def _create_user(session: AsyncSession, *, beta_access: bool = False, beta_admin: bool = False) -> tuple[User, str]:
    sub = str(uuid.uuid4())
    user = User(
        display_name="Test User",
        email="test@example.com",
        supabase_user_id=uuid.UUID(sub),
        beta_access=beta_access,
        beta_admin=beta_admin,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user, sub


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
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# POST /api/beta/redeem
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_redeem_valid_code(client: AsyncClient, db_session: AsyncSession):
    user, sub = await _create_user(db_session)
    code = BetaInviteCode(code="TEST-ABCDEF12", label="test", max_uses=10)
    db_session.add(code)
    await db_session.commit()

    with patch("app.routers.beta._sync_beta_access_to_supabase", new=AsyncMock()):
        resp = await client.post(
            "/api/beta/redeem",
            json={"code": "TEST-ABCDEF12"},
            headers={"Authorization": f"Bearer {_make_token(sub)}"},
        )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    await db_session.refresh(user)
    assert user.beta_access is True
    await db_session.refresh(code)
    assert code.used_count == 1


@pytest.mark.asyncio
async def test_redeem_invalid_code(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session)
    resp = await client.post(
        "/api/beta/redeem",
        json={"code": "INVALID-CODE"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_redeem_revoked_code(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session)
    code = BetaInviteCode(code="TEST-REVOKED1", label="test", max_uses=10, status=BetaCodeStatus.revoked)
    db_session.add(code)
    await db_session.commit()

    resp = await client.post(
        "/api/beta/redeem",
        json={"code": "TEST-REVOKED1"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_redeem_exhausted_code(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session)
    code = BetaInviteCode(code="TEST-EXHAUST1", label="test", max_uses=1, used_count=1)
    db_session.add(code)
    await db_session.commit()

    resp = await client.post(
        "/api/beta/redeem",
        json={"code": "TEST-EXHAUST1"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_redeem_idempotent(client: AsyncClient, db_session: AsyncSession):
    """Already-activated user re-redeeming returns success without double-counting."""
    user, sub = await _create_user(db_session, beta_access=True)
    code = BetaInviteCode(code="TEST-IDEM0001", label="test", max_uses=10)
    db_session.add(code)
    await db_session.commit()

    with patch("app.routers.beta._sync_beta_access_to_supabase", new=AsyncMock()):
        resp = await client.post(
            "/api/beta/redeem",
            json={"code": "TEST-IDEM0001"},
            headers={"Authorization": f"Bearer {_make_token(sub)}"},
        )
    assert resp.status_code == 200
    await db_session.refresh(code)
    assert code.used_count == 0  # no increment for already-activated user


# ---------------------------------------------------------------------------
# POST /api/beta/waitlist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_waitlist(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session)
    resp = await client.post(
        "/api/beta/waitlist",
        json={"email": "user@example.com", "note": "AI developer"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_apply_waitlist_duplicate(client: AsyncClient, db_session: AsyncSession):
    user, sub = await _create_user(db_session)
    entry = BetaWaitlistEntry(user_id=user.id, email="user@example.com", status=BetaWaitlistStatus.pending)
    db_session.add(entry)
    await db_session.commit()

    resp = await client.post(
        "/api/beta/waitlist",
        json={"email": "user@example.com"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_create_and_list_codes(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session, beta_admin=True)
    resp = await client.post(
        "/api/admin/beta/codes",
        json={"label": "TechWave", "max_uses": 500, "prefix": "KOL"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["label"] == "TechWave"
    assert data["max_uses"] == 500
    assert data["code"].startswith("KOL-")

    list_resp = await client.get(
        "/api/admin/beta/codes",
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert list_resp.status_code == 200
    assert len(list_resp.json()["codes"]) == 1


@pytest.mark.asyncio
async def test_admin_revoke_code(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session, beta_admin=True)
    code = BetaInviteCode(code="KOL-REVTEST1", label="test", max_uses=100)
    db_session.add(code)
    await db_session.commit()

    resp = await client.post(
        f"/api/admin/beta/codes/{code.id}/revoke",
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"


@pytest.mark.asyncio
async def test_admin_approve_waitlist(client: AsyncClient, db_session: AsyncSession):
    admin_user, admin_sub = await _create_user(db_session, beta_admin=True)
    applicant, _ = await _create_user(db_session)
    entry = BetaWaitlistEntry(user_id=applicant.id, email="applicant@example.com")
    db_session.add(entry)
    await db_session.commit()

    with patch("app.routers.admin_beta._send_approval_email", new=AsyncMock(return_value=True)):
        resp = await client.post(
            f"/api/admin/beta/waitlist/{entry.id}/approve",
            headers={"Authorization": f"Bearer {_make_token(admin_sub)}"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["code"].startswith("INVITE-")
    assert data["email_sent"] is True


@pytest.mark.asyncio
async def test_admin_approve_waitlist_keeps_manual_fallback_when_email_fails(
    client: AsyncClient,
    db_session: AsyncSession,
):
    _, admin_sub = await _create_user(db_session, beta_admin=True)
    applicant, _ = await _create_user(db_session)
    entry = BetaWaitlistEntry(user_id=applicant.id, email="fallback@example.com")
    db_session.add(entry)
    await db_session.commit()

    with patch("app.routers.admin_beta._send_approval_email", new=AsyncMock(return_value=False)):
        resp = await client.post(
            f"/api/admin/beta/waitlist/{entry.id}/approve",
            headers={"Authorization": f"Bearer {_make_token(admin_sub)}"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["email_sent"] is False
    assert data["code"].startswith("INVITE-")
    assert data["entry"]["sent_code"] == data["code"]


@pytest.mark.asyncio
async def test_redeem_exhausted_code_does_not_activate_user(client: AsyncClient, db_session: AsyncSession):
    user, sub = await _create_user(db_session)
    code = BetaInviteCode(code="TEST-ROLLBACK1", label="test", max_uses=1, used_count=1)
    db_session.add(code)
    await db_session.commit()

    resp = await client.post(
        "/api/beta/redeem",
        json={"code": "TEST-ROLLBACK1"},
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )

    assert resp.status_code == 400
    await db_session.refresh(user)
    assert user.beta_access is False


@pytest.mark.asyncio
async def test_admin_non_admin_forbidden(client: AsyncClient, db_session: AsyncSession):
    _, sub = await _create_user(db_session, beta_admin=False)
    resp = await client.get(
        "/api/admin/beta/codes",
        headers={"Authorization": f"Bearer {_make_token(sub)}"},
    )
    assert resp.status_code == 403

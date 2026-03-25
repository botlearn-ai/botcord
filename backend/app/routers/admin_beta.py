"""Admin beta management routes under /api/admin/beta.

Requires beta_admin=true on the requesting user.

  GET  /api/admin/beta/codes              — list invite codes
  POST /api/admin/beta/codes              — create invite code
  POST /api/admin/beta/codes/{id}/revoke  — revoke invite code
  GET  /api/admin/beta/waitlist           — list waitlist entries
  POST /api/admin/beta/waitlist/{id}/approve — approve + email code
  POST /api/admin/beta/waitlist/{id}/reject  — reject application
"""

import datetime
import logging
import uuid

import httpx
import pydantic
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.config import BETA_APPROVAL_EMAIL_WEBHOOK_URL, FRONTEND_BASE_URL
from hub.database import get_db
from hub.enums import BetaCodeStatus, BetaWaitlistStatus
from hub.models import BetaCodeRedemption, BetaInviteCode, BetaWaitlistEntry, User
from hub.utils import generate_beta_code

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/beta", tags=["app-admin-beta"])


# ---------------------------------------------------------------------------
# Admin auth dependency
# ---------------------------------------------------------------------------


async def require_beta_admin(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> RequestContext:
    user_result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = user_result.scalar_one_or_none()
    if user is None or not user.beta_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return ctx


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _code_response(c: BetaInviteCode) -> dict:
    return {
        "id": str(c.id),
        "code": c.code,
        "label": c.label,
        "max_uses": c.max_uses,
        "used_count": c.used_count,
        "created_by": c.created_by,
        "expires_at": c.expires_at.isoformat() if c.expires_at else None,
        "status": c.status.value,
        "created_at": c.created_at.isoformat(),
    }


def _entry_response(e: BetaWaitlistEntry, code: BetaInviteCode | None = None) -> dict:
    return {
        "id": str(e.id),
        "user_id": str(e.user_id),
        "email": e.email,
        "note": e.note,
        "status": e.status.value,
        "applied_at": e.applied_at.isoformat(),
        "reviewed_at": e.reviewed_at.isoformat() if e.reviewed_at else None,
        "sent_code": code.code if code else None,
    }


async def _send_approval_email(email: str, code: str) -> bool:
    """Send approval email through a real mail relay. Returns True only on delivery handoff."""
    activate_url = f"{FRONTEND_BASE_URL.rstrip('/')}/invite?code={code}"

    if not BETA_APPROVAL_EMAIL_WEBHOOK_URL:
        _logger.warning("Approval email relay not configured; falling back to manual code sharing")
        _logger.info("BETA_APPROVAL_FALLBACK to=%s code=%s url=%s", email, code, activate_url)
        return False

    subject = "你的 BotCord 公测邀请码"
    body = (
        f"你好，\n\n"
        f"你的 BotCord 公测申请已通过审核！\n\n"
        f"激活码：{code}\n\n"
        f"点击以下链接直接激活：\n{activate_url}\n\n"
        f"或登录后前往 {FRONTEND_BASE_URL.rstrip('/')}/invite 手动输入激活码。\n\n"
        f"— BotCord 团队"
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                BETA_APPROVAL_EMAIL_WEBHOOK_URL,
                json={
                    "email": email,
                    "subject": subject,
                    "text": body,
                    "metadata": {
                        "beta_invite_code": code,
                        "activate_url": activate_url,
                    },
                },
            )
            if resp.status_code in (200, 201):
                return True
            _logger.warning("Approval email relay failed: %s %s", resp.status_code, resp.text)
            return False
    except Exception as exc:
        _logger.warning("Approval email relay error: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Invite code endpoints
# ---------------------------------------------------------------------------


class CreateCodeRequest(BaseModel):
    label: str = pydantic.Field(max_length=128)
    max_uses: int = pydantic.Field(default=1, ge=1, le=100000)
    prefix: str = pydantic.Field(default="BETA", max_length=20, pattern=r"^[A-Za-z0-9]+$")
    expires_at: datetime.datetime | None = None


@router.get("/codes")
async def list_codes(
    status: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(BetaInviteCode).order_by(BetaInviteCode.created_at.desc())
    if status:
        try:
            stmt = stmt.where(BetaInviteCode.status == BetaCodeStatus(status))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
    result = await db.execute(stmt)
    codes = result.scalars().all()
    return {"codes": [_code_response(c) for c in codes]}


@router.post("/codes")
async def create_code(
    body: CreateCodeRequest,
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    # Ensure uniqueness with retry loop (collision probability is negligible but not zero)
    prefix_upper = body.prefix.upper()
    for _ in range(10):
        code_val = generate_beta_code(prefix_upper)
        existing = await db.execute(select(BetaInviteCode).where(BetaInviteCode.code == code_val))
        if existing.scalar_one_or_none() is None:
            break
    else:
        raise HTTPException(status_code=500, detail="Failed to generate unique invite code")

    invite_code = BetaInviteCode(
        code=code_val,
        label=body.label,
        max_uses=body.max_uses,
        created_by=str(ctx.user_id),
        expires_at=body.expires_at,
    )
    db.add(invite_code)
    await db.commit()
    await db.refresh(invite_code)
    return _code_response(invite_code)


@router.post("/codes/{code_id}/revoke")
async def revoke_code(
    code_id: uuid.UUID,
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(BetaInviteCode).where(BetaInviteCode.id == code_id))
    invite_code = result.scalar_one_or_none()
    if not invite_code:
        raise HTTPException(status_code=404, detail="Invite code not found")
    invite_code.status = BetaCodeStatus.revoked
    await db.commit()
    return _code_response(invite_code)


# ---------------------------------------------------------------------------
# Waitlist endpoints
# ---------------------------------------------------------------------------


@router.get("/waitlist")
async def list_waitlist(
    status: str = Query(default="pending"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        status_enum = BetaWaitlistStatus(status)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid status: {status}")

    stmt = (
        select(BetaWaitlistEntry)
        .where(BetaWaitlistEntry.status == status_enum)
        .order_by(BetaWaitlistEntry.applied_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    entries = result.scalars().all()

    # Fetch sent codes for approved entries
    code_map: dict[uuid.UUID, BetaInviteCode] = {}
    code_ids = [e.sent_code_id for e in entries if e.sent_code_id]
    if code_ids:
        codes_result = await db.execute(select(BetaInviteCode).where(BetaInviteCode.id.in_(code_ids)))
        for c in codes_result.scalars().all():
            code_map[c.id] = c

    return {"entries": [_entry_response(e, code_map.get(e.sent_code_id)) for e in entries]}


@router.post("/waitlist/{entry_id}/approve")
async def approve_waitlist(
    entry_id: uuid.UUID,
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(BetaWaitlistEntry).where(BetaWaitlistEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")
    if entry.status != BetaWaitlistStatus.pending:
        raise HTTPException(status_code=400, detail="Entry is not pending")

    # Generate one-time code with uniqueness retry
    for _ in range(10):
        code_val = generate_beta_code("INVITE")
        existing = await db.execute(select(BetaInviteCode).where(BetaInviteCode.code == code_val))
        if existing.scalar_one_or_none() is None:
            break
    else:
        raise HTTPException(status_code=500, detail="Failed to generate unique invite code")
    invite_code = BetaInviteCode(
        code=code_val,
        label=f"waitlist:{entry.email}",
        max_uses=1,
        created_by=str(ctx.user_id),
    )
    db.add(invite_code)
    await db.flush()  # get invite_code.id

    # Update entry
    entry.status = BetaWaitlistStatus.approved
    entry.reviewed_at = datetime.datetime.now(datetime.timezone.utc)
    entry.sent_code_id = invite_code.id
    await db.commit()

    # Send email (best-effort)
    email_sent = await _send_approval_email(entry.email, code_val)

    return {
        "ok": True,
        "code": code_val,
        "email_sent": email_sent,
        "entry": _entry_response(entry, invite_code),
    }


@router.post("/waitlist/{entry_id}/reject")
async def reject_waitlist(
    entry_id: uuid.UUID,
    ctx: RequestContext = Depends(require_beta_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(BetaWaitlistEntry).where(BetaWaitlistEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")
    if entry.status != BetaWaitlistStatus.pending:
        raise HTTPException(status_code=400, detail="Entry is not pending")

    entry.status = BetaWaitlistStatus.rejected
    entry.reviewed_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    return {"ok": True, "entry": _entry_response(entry)}

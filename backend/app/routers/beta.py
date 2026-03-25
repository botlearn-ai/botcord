"""Beta invite gate routes under /api/beta.

User-facing endpoints:
  POST /api/beta/redeem   — redeem an invite code to activate beta access
  POST /api/beta/waitlist — submit a waitlist application
"""

import asyncio
import datetime
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.config import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL
from hub.database import get_db
from hub.enums import BetaCodeStatus, BetaWaitlistStatus
from hub.models import BetaCodeRedemption, BetaInviteCode, BetaWaitlistEntry, User
from hub.utils import generate_beta_code  # noqa: F401 (available for tests)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/beta", tags=["app-beta"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _sync_beta_access_to_supabase(supabase_user_id: str) -> None:
    """Write beta_access=true into Supabase user_metadata so middleware can read it from JWT."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        _logger.warning("Supabase config missing, skipping user_metadata sync")
        return
    url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/admin/users/{supabase_user_id}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.put(url, json={"user_metadata": {"beta_access": True}}, headers=headers)
            if resp.status_code not in (200, 204):
                _logger.warning("Supabase user_metadata update failed: %s %s", resp.status_code, resp.text)
    except Exception as exc:
        _logger.warning("Supabase user_metadata sync error: %s", exc)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class RedeemRequest(BaseModel):
    code: str


class WaitlistRequest(BaseModel):
    email: str
    note: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/redeem")
async def redeem_invite_code(
    body: RedeemRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Redeem an invite code and activate beta access for the current user."""
    code_val = body.code.strip().upper()

    now = datetime.datetime.now(datetime.timezone.utc)

    # Fetch the invite code
    result = await db.execute(
        select(BetaInviteCode).where(BetaInviteCode.code == code_val)
    )
    invite_code = result.scalar_one_or_none()

    if invite_code is None or invite_code.status == BetaCodeStatus.revoked:
        raise HTTPException(status_code=400, detail="邀请码无效")

    if invite_code.expires_at and invite_code.expires_at < now:
        raise HTTPException(status_code=400, detail="邀请码已过期")

    if invite_code.used_count >= invite_code.max_uses:
        raise HTTPException(status_code=400, detail="邀请码已被使用完")

    user_activation = await db.execute(
        update(User)
        .where(User.id == ctx.user_id, User.beta_access.is_(False))
        .values(beta_access=True)
    )
    if user_activation.rowcount == 0:
        return {"ok": True}

    code_claim = await db.execute(
        update(BetaInviteCode)
        .where(
            and_(
                BetaInviteCode.id == invite_code.id,
                BetaInviteCode.status == BetaCodeStatus.active,
                BetaInviteCode.used_count < BetaInviteCode.max_uses,
                or_(BetaInviteCode.expires_at.is_(None), BetaInviteCode.expires_at >= now),
            )
        )
        .values(used_count=BetaInviteCode.used_count + 1)
    )
    if code_claim.rowcount == 0:
        await db.rollback()
        raise HTTPException(status_code=400, detail="邀请码已被使用完")

    redemption = BetaCodeRedemption(code_id=invite_code.id, user_id=ctx.user_id)
    db.add(redemption)
    await db.commit()

    # Sync to Supabase user_metadata (best-effort, fire-and-forget)
    asyncio.create_task(_sync_beta_access_to_supabase(ctx.supabase_user_id))

    return {"ok": True}


@router.post("/waitlist")
async def apply_waitlist(
    body: WaitlistRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit a waitlist application for beta access."""
    # Check user doesn't already have beta_access
    user_result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = user_result.scalar_one()
    if user.beta_access:
        raise HTTPException(status_code=400, detail="你已开通公测资格")

    # Check for existing non-rejected application (rejected users may not re-apply)
    existing = await db.execute(
        select(BetaWaitlistEntry).where(
            BetaWaitlistEntry.user_id == ctx.user_id,
            BetaWaitlistEntry.status.in_([
                BetaWaitlistStatus.pending,
                BetaWaitlistStatus.approved,
                BetaWaitlistStatus.rejected,
            ]),
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="你已提交过申请")

    entry = BetaWaitlistEntry(
        user_id=ctx.user_id,
        email=body.email.strip(),
        note=body.note,
    )
    db.add(entry)
    await db.commit()

    return {"ok": True}

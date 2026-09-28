"""Organization invite links — personal (single-use, 7 days) by default.

A manager creates one link per invitee (optionally labelled with who it is
for); multi-use links remain available as an advanced option. Anyone holding
a link can preview the organization
without an account, sign up / log in, and accept to become an active member.
Links can expire, cap their uses and be revoked. Callers commit once after a
successful mutation (same convention as ``hub.services.spaces``).
"""

from __future__ import annotations

import datetime
import secrets
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import (
    Organization, Space, SpaceInviteLink, SpaceRoleBinding, SpaceUserMembership, User,
)
from hub.services import spaces

MAX_USES_LIMIT = 1000


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value: datetime.datetime | None) -> datetime.datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value


def link_status(link: SpaceInviteLink) -> str:
    """``active`` | ``revoked`` | ``expired`` | ``exhausted``."""
    if link.revoked_at is not None:
        return "revoked"
    expires_at = _aware(link.expires_at)
    if expires_at is not None and expires_at <= _now():
        return "expired"
    if link.max_uses is not None and link.use_count >= link.max_uses:
        return "exhausted"
    return "active"


async def create_link(
    db: AsyncSession, space_id: UUID, actor_id: UUID, *,
    expires_in_days: int | None = 7, max_uses: int | None = 1, label: str | None = None,
) -> SpaceInviteLink:
    await spaces.organization_space(db, space_id)
    await spaces.require_manager(db, space_id, actor_id)
    if expires_in_days is not None and not 1 <= expires_in_days <= 90:
        spaces.reject("invalid_expiry", 422)
    if max_uses is not None and not 1 <= max_uses <= MAX_USES_LIMIT:
        spaces.reject("invalid_max_uses", 422)
    link = SpaceInviteLink(
        space_id=space_id,
        code="oi_" + secrets.token_urlsafe(18),
        created_by_user_id=actor_id,
        max_uses=max_uses,
        label=(label or "").strip() or None,
        expires_at=_now() + datetime.timedelta(days=expires_in_days) if expires_in_days else None,
    )
    db.add(link)
    await db.flush()
    spaces.audit(db, space_id, actor_id, "invite_link.created", link.id,
                 expires_in_days=expires_in_days, max_uses=max_uses)
    return link


async def list_links(db: AsyncSession, space_id: UUID, actor_id: UUID) -> list[SpaceInviteLink]:
    await spaces.require_manager(db, space_id, actor_id)
    rows = await db.scalars(
        select(SpaceInviteLink)
        .where(SpaceInviteLink.space_id == space_id, SpaceInviteLink.revoked_at.is_(None))
        .order_by(SpaceInviteLink.created_at.desc())
    )
    return list(rows.all())


async def revoke_link(db: AsyncSession, space_id: UUID, actor_id: UUID, link_id: UUID) -> SpaceInviteLink:
    link = await db.get(SpaceInviteLink, link_id)
    if link is None or link.space_id != space_id:
        spaces.reject("invite_link_not_found", 404)
    await spaces.require_manager(db, space_id, actor_id)
    if link.revoked_at is None:
        link.revoked_at = _now()
        spaces.audit(db, space_id, actor_id, "invite_link.revoked", link.id)
    return link


async def _link_by_code(db: AsyncSession, code: str, *, lock: bool = False) -> SpaceInviteLink:
    query = select(SpaceInviteLink).where(SpaceInviteLink.code == code)
    if lock:
        query = query.with_for_update()
    link = await db.scalar(query.execution_options(populate_existing=True))
    if link is None:
        spaces.reject("invite_link_not_found", 404)
    return link


async def preview(db: AsyncSession, code: str) -> dict:
    """Public preview: organization name, inviter, member count, link status."""
    link = await _link_by_code(db, code)
    space = await db.get(Space, link.space_id)
    org = await db.scalar(select(Organization).where(Organization.space_id == link.space_id))
    inviter = await db.get(User, link.created_by_user_id)
    member_count = await db.scalar(
        select(func.count()).select_from(SpaceUserMembership).where(
            SpaceUserMembership.space_id == link.space_id, SpaceUserMembership.status == "active",
        )
    )
    status = link_status(link)
    if space is None or space.status != "active":
        status = "unavailable"
    return {
        "space_id": link.space_id,
        "organization_name": org.name if org else None,
        "inviter_name": inviter.display_name if inviter else None,
        "member_count": member_count or 0,
        "status": status,
        "expires_at": link.expires_at,
        "single_use": link.max_uses == 1,
    }


async def accept(db: AsyncSession, code: str, user_id: UUID) -> SpaceUserMembership:
    """Redeem a live link: the caller becomes an active organization member."""
    link = await _link_by_code(db, code, lock=True)
    await spaces.organization_space(db, link.space_id)
    user = await spaces.active_user(db, user_id)
    membership = await db.scalar(select(SpaceUserMembership).where(
        SpaceUserMembership.space_id == link.space_id, SpaceUserMembership.user_id == user_id,
    ))
    if membership is not None and membership.status == "active":
        return membership  # idempotent; does not consume a use
    status = link_status(link)
    if status != "active":
        spaces.reject(f"invite_link_{status}", 410)
    if membership is not None and membership.status in {"removed", "suspended"}:
        # People an admin removed may still hold an old link; they need a
        # direct invitation to come back.
        spaces.reject("membership_requires_direct_invite", 403)
    if membership is None:
        membership = SpaceUserMembership(space_id=link.space_id, user_id=user_id, status="active")
        db.add(membership)
        await db.flush()
    else:
        # A pending direct invitation is completed by the link.
        membership.status = "active"
        membership.version += 1
        await db.execute(delete(SpaceRoleBinding).where(SpaceRoleBinding.user_membership_id == membership.id))
    db.add(SpaceRoleBinding(space_id=link.space_id, user_membership_id=membership.id, role_key="member"))
    link.use_count += 1
    link.redeemed_by_user_id = user_id
    link.redeemed_at = _now()
    # Invite links are an onboarding path: never strand an invitee behind the beta gate.
    user.beta_access = True
    spaces.audit(db, link.space_id, user_id, "membership.joined_via_link", membership.id,
                 link_id=str(link.id), version=membership.version)
    return membership

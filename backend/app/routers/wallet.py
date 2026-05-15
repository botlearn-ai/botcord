"""Wallet, topup, withdrawal, and Stripe routes under /api/wallet.

Auth uses Supabase JWT via ``require_user_with_optional_agent``; each
route accepts ``?as=agent|human`` (default ``agent``) to pick whose
wallet to operate on. ``as=agent`` still requires the
``X-Active-Agent`` header; ``as=human`` uses ``ctx.human_id``.
"""

import datetime
import json
import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user_with_optional_agent
from hub import config as hub_config
from hub.database import get_db
from hub.id_generators import generate_hub_msg_id
from hub.models import MessageRecord, MessageState, RoomMember, WithdrawalRequest
from hub.routers.hub import build_message_realtime_event, notify_inbox
from hub.services import wallet as wallet_svc
from hub.services import stripe_topup as stripe_svc
from hub.wallet_schemas import (
    LedgerEntryResponse,
    LedgerListResponse,
    StripeCheckoutRequest,
    StripeCheckoutResponse,
    StripePackageItem,
    StripePackageResponse,
    StripeSessionStatusResponse,
    TopupCreateRequest,
    TopupResponse,
    TransactionResponse,
    TransferRequest,
    WalletSummaryResponse,
    WithdrawalCreateRequest,
    WithdrawalResponse,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/wallet", tags=["app-wallet"])


class AppTransferRequest(TransferRequest):
    room_id: str | None = Field(default=None, description="Room where the transfer notice should be posted")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_owner(ctx: RequestContext, as_: str) -> str:
    """Resolve owner id based on `?as=agent|human` query parameter."""
    if as_ == "human":
        if not ctx.human_id:
            raise HTTPException(status_code=400, detail="User has no human_id")
        return ctx.human_id
    if as_ == "agent":
        if not ctx.active_agent_id:
            raise HTTPException(
                status_code=400,
                detail="X-Active-Agent header is required when as=agent",
            )
        return ctx.active_agent_id
    raise HTTPException(status_code=400, detail=f"Invalid `as` value: {as_!r}")


def _wallet_summary(wallet) -> dict:
    total = wallet.available_balance_minor + wallet.locked_balance_minor
    return {
        "agent_id": wallet.owner_id,
        "asset_code": wallet.asset_code,
        "available_balance_minor": str(wallet.available_balance_minor),
        "locked_balance_minor": str(wallet.locked_balance_minor),
        "total_balance_minor": str(total),
        "updated_at": wallet.updated_at,
    }


def _tx_response(tx) -> dict:
    return {
        "tx_id": tx.tx_id,
        "type": tx.type.value if hasattr(tx.type, "value") else str(tx.type),
        "status": tx.status.value if hasattr(tx.status, "value") else str(tx.status),
        "asset_code": tx.asset_code,
        "amount_minor": str(tx.amount_minor),
        "fee_minor": str(tx.fee_minor),
        "from_agent_id": tx.from_owner_id,
        "to_agent_id": tx.to_owner_id,
        "reference_type": tx.reference_type,
        "reference_id": tx.reference_id,
        "idempotency_key": tx.idempotency_key,
        "metadata_json": tx.metadata_json,
        "created_at": tx.created_at,
        "updated_at": tx.updated_at,
        "completed_at": tx.completed_at,
    }


def _format_coin_amount(amount_minor: int | str) -> str:
    try:
        minor = int(amount_minor)
    except (TypeError, ValueError):
        minor = 0
    return f"{minor / 100:.2f} COIN"


async def _record_room_transfer_notice(
    db: AsyncSession,
    *,
    room_id: str,
    from_owner_id: str,
    to_owner_id: str,
    tx,
    source_user_id: str | None = None,
    source_user_name: str | None = None,
) -> None:
    members_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id)
    )
    members = list(members_result.scalars().all())
    member_ids = {member.agent_id for member in members}
    if from_owner_id not in member_ids:
        raise HTTPException(status_code=403, detail="Sender is not a room member")
    if to_owner_id not in member_ids:
        raise HTTPException(status_code=400, detail="Recipient is not a room member")

    amount = _format_coin_amount(tx.amount_minor)
    payload = {
        "text": "\n".join([
            "[BotCord Transfer]",
            "Status: completed",
            f"Transaction: {tx.tx_id}",
            f"Amount: {amount}",
            f"Asset: {tx.asset_code}",
            f"From: {from_owner_id}",
            f"To: {to_owner_id}",
            f"Created: {tx.created_at}",
        ]),
        "event": "wallet_transfer_notice",
        "tx_id": tx.tx_id,
        "amount_minor": str(tx.amount_minor),
        "asset_code": tx.asset_code,
        "from_agent_id": from_owner_id,
        "to_agent_id": to_owner_id,
        "from_display_name": source_user_name,
    }
    envelope_data = {
        "v": "a2a/0.1",
        "msg_id": str(uuid.uuid4()),
        "ts": int(time.time()),
        "from": from_owner_id,
        "to": room_id,
        "type": "message",
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "wallet", "value": ""},
    }
    envelope_json = json.dumps(envelope_data)
    now = datetime.datetime.now(datetime.timezone.utc)
    receiver_ids = [member.agent_id for member in members if not member.muted]
    first_hub_msg_id: str | None = None
    receiver_hub_msg_ids: dict[str, str] = {}

    for receiver_id in receiver_ids:
        hub_msg_id = generate_hub_msg_id()
        if first_hub_msg_id is None:
            first_hub_msg_id = hub_msg_id
        receiver_hub_msg_ids[receiver_id] = hub_msg_id
        db.add(
            MessageRecord(
                hub_msg_id=hub_msg_id,
                msg_id=envelope_data["msg_id"],
                sender_id=from_owner_id,
                receiver_id=receiver_id,
                room_id=room_id,
                state=MessageState.queued,
                envelope_json=envelope_json,
                ttl_sec=3600,
                created_at=now,
                source_type="dashboard_human_room" if source_user_id else "wallet_transfer_notice",
                source_user_id=source_user_id,
                source_session_kind="room_human",
            )
        )

    await db.flush()

    for receiver_id in receiver_ids:
        try:
            await notify_inbox(
                receiver_id,
                db=db,
                realtime_event=build_message_realtime_event(
                    type="message",
                    agent_id=receiver_id,
                    sender_id=from_owner_id,
                    room_id=room_id,
                    hub_msg_id=receiver_hub_msg_ids.get(receiver_id, first_hub_msg_id),
                    created_at=now,
                    payload=payload,
                    source_type="dashboard_human_room" if source_user_id else "wallet_transfer_notice",
                ),
            )
        except Exception as exc:
            _logger.error(
                "Wallet transfer room notice notify failed receiver=%s room=%s err=%s",
                receiver_id, room_id, exc, exc_info=True,
            )


def _topup_response(topup, tx) -> dict:
    return {
        "topup_id": topup.topup_id,
        "tx_id": tx.tx_id if tx else topup.tx_id,
        "agent_id": topup.owner_id,
        "asset_code": topup.asset_code,
        "amount_minor": str(topup.amount_minor),
        "status": topup.status.value if hasattr(topup.status, "value") else str(topup.status),
        "channel": topup.channel,
        "created_at": topup.created_at,
        "completed_at": topup.completed_at,
    }


def _withdrawal_response(wd) -> dict:
    return {
        "withdrawal_id": wd.withdrawal_id,
        "tx_id": wd.tx_id,
        "agent_id": wd.owner_id,
        "asset_code": wd.asset_code,
        "amount_minor": str(wd.amount_minor),
        "fee_minor": str(wd.fee_minor),
        "status": wd.status.value if hasattr(wd.status, "value") else str(wd.status),
        "destination_type": wd.destination_type,
        "review_note": wd.review_note,
        "created_at": wd.created_at,
        "reviewed_at": wd.reviewed_at,
        "completed_at": wd.completed_at,
    }


# ---------------------------------------------------------------------------
# Wallet summary
# ---------------------------------------------------------------------------


@router.get("/summary")
async def get_wallet_summary(
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    wallet = await wallet_svc.get_or_create_wallet(db, owner_id)
    return _wallet_summary(wallet)


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


@router.get("/ledger")
async def get_wallet_ledger(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    type: str | None = Query(default=None),
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    entries, next_cursor, has_more = await wallet_svc.list_wallet_ledger(
        db, owner_id, cursor=cursor, limit=limit, tx_type=type,
    )
    return {
        "entries": [
            {
                "entry_id": entry.entry_id,
                "tx_id": entry.tx_id,
                "direction": entry.direction.value if hasattr(entry.direction, "value") else str(entry.direction),
                "tx_type": tx.type.value if tx is not None and hasattr(tx.type, "value") else (str(tx.type) if tx is not None else None),
                "reference_type": tx.reference_type if tx is not None else None,
                "reference_id": tx.reference_id if tx is not None else None,
                "amount_minor": str(entry.amount_minor),
                "balance_after_minor": str(entry.balance_after_minor),
                "created_at": entry.created_at,
            }
            for entry, tx in entries
        ],
        "has_more": has_more,
        "next_cursor": next_cursor,
    }


# ---------------------------------------------------------------------------
# Transfers
# ---------------------------------------------------------------------------


@router.post("/transfers", status_code=201)
async def create_transfer(
    body: AppTransferRequest,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")

    from_owner_id = _resolve_owner(ctx, as_)
    if body.room_id:
        members_result = await db.execute(
            select(RoomMember.agent_id).where(RoomMember.room_id == body.room_id)
        )
        member_ids = {row[0] for row in members_result.all()}
        if from_owner_id not in member_ids:
            raise HTTPException(status_code=403, detail="Sender is not a room member")
        if body.to_agent_id not in member_ids:
            raise HTTPException(status_code=400, detail="Recipient is not a room member")

    try:
        tx = await wallet_svc.create_transfer(
            db,
            from_owner_id=from_owner_id,
            to_owner_id=body.to_agent_id,
            amount_minor=amount,
            memo=body.memo,
            reference_type=body.reference_type,
            reference_id=body.reference_id,
            metadata=body.metadata,
            idempotency_key=body.idempotency_key,
        )
        if body.room_id:
            await _record_room_transfer_notice(
                db,
                room_id=body.room_id,
                from_owner_id=from_owner_id,
                to_owner_id=body.to_agent_id,
                tx=tx,
                source_user_id=str(ctx.user_id) if as_ == "human" else None,
                source_user_name=ctx.user_display_name if as_ == "human" else None,
            )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _tx_response(tx)


# ---------------------------------------------------------------------------
# Topups
# ---------------------------------------------------------------------------


@router.post("/topups", status_code=201)
async def create_topup(
    body: TopupCreateRequest,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")

    owner_id = _resolve_owner(ctx, as_)

    try:
        topup, tx = await wallet_svc.create_topup_request(
            db,
            owner_id,
            amount,
            channel=body.channel,
            metadata=body.metadata,
            idempotency_key=body.idempotency_key,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _topup_response(topup, tx)


# ---------------------------------------------------------------------------
# Withdrawals
# ---------------------------------------------------------------------------


@router.get("/withdrawals")
async def list_withdrawals(
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    result = await db.execute(
        select(WithdrawalRequest)
        .where(WithdrawalRequest.owner_id == owner_id)
        .order_by(WithdrawalRequest.created_at.desc())
        .limit(20)
    )
    wds = list(result.scalars().all())
    return {"withdrawals": [_withdrawal_response(wd) for wd in wds]}


@router.post("/withdrawals", status_code=201)
async def create_withdrawal(
    body: WithdrawalCreateRequest,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
        fee = int(body.fee_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor or fee_minor")

    destination_json = json.dumps(body.destination) if body.destination else None

    owner_id = _resolve_owner(ctx, as_)

    try:
        wd, _tx = await wallet_svc.create_withdrawal_request(
            db,
            owner_id,
            amount,
            fee_minor=fee,
            destination_type=body.destination_type,
            destination_json=destination_json,
            idempotency_key=body.idempotency_key,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _withdrawal_response(wd)


@router.post("/withdrawals/{withdrawal_id}/cancel")
async def cancel_withdrawal(
    withdrawal_id: str,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    try:
        wd = await wallet_svc.cancel_withdrawal_request(
            db, withdrawal_id, owner_id,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _withdrawal_response(wd)


# ---------------------------------------------------------------------------
# Transaction detail
# ---------------------------------------------------------------------------


@router.get("/transactions/{tx_id}")
async def get_transaction(
    tx_id: str,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    tx = await wallet_svc.get_transaction(db, tx_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    owner_id = _resolve_owner(ctx, as_)
    # Authorization: owner must be sender or receiver
    if owner_id not in (tx.from_owner_id, tx.to_owner_id):
        raise HTTPException(status_code=403, detail="Not authorized to view this transaction")

    return _tx_response(tx)


# ---------------------------------------------------------------------------
# Stripe packages (public)
# ---------------------------------------------------------------------------


@router.get("/stripe/packages")
async def list_stripe_packages():
    packages = hub_config.STRIPE_TOPUP_PACKAGES
    return {
        "packages": [
            {
                "package_code": p.get("package_code", ""),
                "coin_amount_minor": str(p.get("coin_amount_minor", 0)),
                "fiat_amount": str(p.get("fiat_amount", "0")),
                "currency": p.get("currency", "usd"),
            }
            for p in packages
        ]
    }


# ---------------------------------------------------------------------------
# Stripe checkout
# ---------------------------------------------------------------------------


@router.post("/stripe/checkout-session", status_code=201)
async def create_stripe_checkout(
    body: StripeCheckoutRequest,
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    try:
        result = await stripe_svc.create_checkout_session(
            db,
            owner_id,
            body.package_code,
            body.idempotency_key,
            quantity=body.quantity,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return result


# ---------------------------------------------------------------------------
# Stripe session status
# ---------------------------------------------------------------------------


@router.get("/stripe/session-status")
async def get_stripe_session_status(
    session_id: str = Query(...),
    as_: str = Query(default="agent", alias="as"),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    owner_id = _resolve_owner(ctx, as_)
    try:
        result = await stripe_svc.get_checkout_status(
            db, session_id, agent_id=owner_id,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    return result

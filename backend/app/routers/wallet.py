"""Wallet, topup, withdrawal, and Stripe routes under /api/wallet.

Uses Supabase JWT auth via ``require_active_agent`` and delegates to
the existing hub service layer.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub import config as hub_config
from hub.database import get_db
from hub.models import WithdrawalRequest
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _wallet_summary(wallet) -> dict:
    total = wallet.available_balance_minor + wallet.locked_balance_minor
    return {
        "agent_id": wallet.agent_id,
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
        "from_agent_id": tx.from_agent_id,
        "to_agent_id": tx.to_agent_id,
        "reference_type": tx.reference_type,
        "reference_id": tx.reference_id,
        "idempotency_key": tx.idempotency_key,
        "metadata_json": tx.metadata_json,
        "created_at": tx.created_at,
        "updated_at": tx.updated_at,
        "completed_at": tx.completed_at,
    }


def _topup_response(topup, tx) -> dict:
    return {
        "topup_id": topup.topup_id,
        "tx_id": tx.tx_id if tx else topup.tx_id,
        "agent_id": topup.agent_id,
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
        "agent_id": wd.agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    wallet = await wallet_svc.get_or_create_wallet(db, ctx.active_agent_id)
    return _wallet_summary(wallet)


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


@router.get("/ledger")
async def get_wallet_ledger(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    type: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    entries, next_cursor, has_more = await wallet_svc.list_wallet_ledger(
        db, ctx.active_agent_id, cursor=cursor, limit=limit, tx_type=type,
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
    body: TransferRequest,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")

    try:
        tx = await wallet_svc.create_transfer(
            db,
            from_agent_id=ctx.active_agent_id,
            to_agent_id=body.to_agent_id,
            amount_minor=amount,
            memo=body.memo,
            reference_type=body.reference_type,
            reference_id=body.reference_id,
            metadata=body.metadata,
            idempotency_key=body.idempotency_key,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")

    try:
        topup, tx = await wallet_svc.create_topup_request(
            db,
            ctx.active_agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WithdrawalRequest)
        .where(WithdrawalRequest.agent_id == ctx.active_agent_id)
        .order_by(WithdrawalRequest.created_at.desc())
        .limit(20)
    )
    wds = list(result.scalars().all())
    return {"withdrawals": [_withdrawal_response(wd) for wd in wds]}


@router.post("/withdrawals", status_code=201)
async def create_withdrawal(
    body: WithdrawalCreateRequest,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
        fee = int(body.fee_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor or fee_minor")

    destination_json = json.dumps(body.destination) if body.destination else None

    try:
        wd, _tx = await wallet_svc.create_withdrawal_request(
            db,
            ctx.active_agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        wd = await wallet_svc.cancel_withdrawal_request(
            db, withdrawal_id, ctx.active_agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    tx = await wallet_svc.get_transaction(db, tx_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # Authorization: agent must be sender or receiver
    if ctx.active_agent_id not in (tx.from_agent_id, tx.to_agent_id):
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await stripe_svc.create_checkout_session(
            db,
            ctx.active_agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await stripe_svc.get_checkout_status(
            db, session_id, agent_id=ctx.active_agent_id,
        )
        await db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    return result

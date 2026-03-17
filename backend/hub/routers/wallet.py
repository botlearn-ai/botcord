"""Wallet API router — user-facing and internal endpoints for the coin economy."""

import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub import config as hub_config
from hub.database import get_db
from hub.services import wallet as wallet_svc
from hub.wallet_schemas import (
    LedgerEntryResponse,
    LedgerListResponse,
    TopupCreateRequest,
    TopupResponse,
    TransactionResponse,
    TransferRequest,
    WalletSummaryResponse,
    WithdrawalCreateRequest,
    WithdrawalRejectRequest,
    WithdrawalResponse,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# User-facing router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/wallet", tags=["wallet"])


@router.get("/me", response_model=WalletSummaryResponse)
async def wallet_summary(
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return current agent's wallet summary."""
    wallet = await wallet_svc.get_wallet_summary(db, current_agent)
    total = wallet.available_balance_minor + wallet.locked_balance_minor
    return WalletSummaryResponse(
        agent_id=wallet.agent_id,
        asset_code=wallet.asset_code,
        available_balance_minor=str(wallet.available_balance_minor),
        locked_balance_minor=str(wallet.locked_balance_minor),
        total_balance_minor=str(total),
        updated_at=wallet.updated_at or wallet.created_at,
    )


@router.get("/ledger", response_model=LedgerListResponse)
async def wallet_ledger(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    type: str | None = Query(default=None),
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return paginated ledger entries for the current agent."""
    entries, next_cursor, has_more = await wallet_svc.list_wallet_ledger(
        db, current_agent, tx_type=type, cursor=cursor, limit=limit
    )
    return LedgerListResponse(
        entries=[
            LedgerEntryResponse(
                entry_id=e.entry_id,
                tx_id=e.tx_id,
                agent_id=e.agent_id,
                asset_code=e.asset_code,
                direction=e.direction.value,
                amount_minor=str(e.amount_minor),
                balance_after_minor=str(e.balance_after_minor),
                created_at=e.created_at,
            )
            for e in entries
        ],
        next_cursor=next_cursor,
        has_more=has_more,
    )


@router.post("/transfers", response_model=TransactionResponse, status_code=201)
async def create_transfer(
    req: TransferRequest,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Transfer coins to another agent."""
    try:
        amount = int(req.amount_minor)
    except ValueError:
        raise HTTPException(status_code=400, detail="amount_minor must be a numeric string")

    try:
        tx = await wallet_svc.create_transfer(
            db,
            from_agent_id=current_agent,
            to_agent_id=req.to_agent_id,
            amount_minor=amount,
            idempotency_key=req.idempotency_key,
            memo=req.memo,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _tx_response(tx)


@router.post("/topups", response_model=TopupResponse, status_code=201)
async def create_topup(
    req: TopupCreateRequest,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Create a topup request."""
    try:
        amount = int(req.amount_minor)
    except ValueError:
        raise HTTPException(status_code=400, detail="amount_minor must be a numeric string")

    try:
        topup, tx = await wallet_svc.create_topup_request(
            db, current_agent, amount, channel=req.channel, metadata=req.metadata,
            idempotency_key=req.idempotency_key,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return TopupResponse(
        topup_id=topup.topup_id,
        tx_id=topup.tx_id,
        agent_id=topup.agent_id,
        asset_code=topup.asset_code,
        amount_minor=str(topup.amount_minor),
        status=topup.status.value,
        channel=topup.channel,
        created_at=topup.created_at,
        completed_at=topup.completed_at,
    )


@router.post("/withdrawals", response_model=WithdrawalResponse, status_code=201)
async def create_withdrawal(
    req: WithdrawalCreateRequest,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Create a withdrawal request — locks balance."""
    try:
        amount = int(req.amount_minor)
        fee = int(req.fee_minor)
    except ValueError:
        raise HTTPException(status_code=400, detail="amount/fee must be numeric strings")

    if fee < 0:
        raise HTTPException(status_code=400, detail="fee_minor must be >= 0")

    dest_json = json.dumps(req.destination) if req.destination else None

    try:
        wd, tx = await wallet_svc.create_withdrawal_request(
            db,
            current_agent,
            amount,
            fee_minor=fee,
            destination_type=req.destination_type,
            destination_json=dest_json,
            idempotency_key=req.idempotency_key,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _wd_response(wd)


@router.get("/transactions/{tx_id}", response_model=TransactionResponse)
async def get_transaction(
    tx_id: str,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Get a single transaction detail."""
    tx = await wallet_svc.get_transaction(db, tx_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    # Authorization: agent must be sender or receiver
    if tx.from_agent_id != current_agent and tx.to_agent_id != current_agent:
        raise HTTPException(status_code=403, detail="Not authorized")
    return _tx_response(tx)


@router.post("/withdrawals/{withdrawal_id}/cancel", response_model=WithdrawalResponse)
async def cancel_withdrawal(
    withdrawal_id: str,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a pending withdrawal request."""
    try:
        wd = await wallet_svc.cancel_withdrawal_request(db, withdrawal_id, current_agent)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _wd_response(wd)


# ---------------------------------------------------------------------------
# Internal / mock admin router
# ---------------------------------------------------------------------------

internal_router = APIRouter(prefix="/internal/wallet", tags=["wallet-internal"])


def _require_internal(authorization: str | None = None):
    """Guard: require ALLOW_PRIVATE_ENDPOINTS=true AND a valid INTERNAL_API_SECRET.

    The caller must pass ``Authorization: Bearer <secret>`` where ``<secret>``
    matches the ``INTERNAL_API_SECRET`` env var.  When the secret is not
    configured (dev/test mode) the header check is skipped so that existing
    tests keep working.
    """
    if not hub_config.ALLOW_PRIVATE_ENDPOINTS:
        raise HTTPException(status_code=403, detail="Internal endpoints are disabled")

    expected = hub_config.INTERNAL_API_SECRET
    if expected:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing internal API secret")
        provided = authorization.removeprefix("Bearer ").strip()
        if provided != expected:
            raise HTTPException(status_code=401, detail="Invalid internal API secret")


@internal_router.post("/topups/{topup_id}/complete", response_model=TopupResponse)
async def internal_complete_topup(
    topup_id: str,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Complete a pending topup (internal/mock)."""
    _require_internal(authorization)
    try:
        topup, tx = await wallet_svc.complete_topup_request(db, topup_id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TopupResponse(
        topup_id=topup.topup_id,
        tx_id=topup.tx_id,
        agent_id=topup.agent_id,
        asset_code=topup.asset_code,
        amount_minor=str(topup.amount_minor),
        status=topup.status.value,
        channel=topup.channel,
        created_at=topup.created_at,
        completed_at=topup.completed_at,
    )


@internal_router.post("/topups/{topup_id}/fail", response_model=TopupResponse)
async def internal_fail_topup(
    topup_id: str,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Fail a pending topup (internal/mock)."""
    _require_internal(authorization)
    try:
        topup = await wallet_svc.fail_topup_request(db, topup_id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TopupResponse(
        topup_id=topup.topup_id,
        tx_id=topup.tx_id,
        agent_id=topup.agent_id,
        asset_code=topup.asset_code,
        amount_minor=str(topup.amount_minor),
        status=topup.status.value,
        channel=topup.channel,
        created_at=topup.created_at,
        completed_at=topup.completed_at,
    )


@internal_router.post("/withdrawals/{withdrawal_id}/approve", response_model=WithdrawalResponse)
async def internal_approve_withdrawal(
    withdrawal_id: str,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Approve a pending withdrawal (internal/mock)."""
    _require_internal(authorization)
    try:
        wd = await wallet_svc.approve_withdrawal_request(db, withdrawal_id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _wd_response(wd)


@internal_router.post("/withdrawals/{withdrawal_id}/reject", response_model=WithdrawalResponse)
async def internal_reject_withdrawal(
    withdrawal_id: str,
    req: WithdrawalRejectRequest | None = None,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Reject a pending withdrawal — unlocks balance (internal/mock)."""
    _require_internal(authorization)
    note = req.note if req else None
    try:
        wd = await wallet_svc.reject_withdrawal_request(db, withdrawal_id, note)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _wd_response(wd)


@internal_router.post("/withdrawals/{withdrawal_id}/complete", response_model=WithdrawalResponse)
async def internal_complete_withdrawal(
    withdrawal_id: str,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    """Complete an approved withdrawal (internal/mock)."""
    _require_internal(authorization)
    try:
        wd, tx = await wallet_svc.complete_withdrawal_request(db, withdrawal_id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _wd_response(wd)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tx_response(tx) -> TransactionResponse:
    return TransactionResponse(
        tx_id=tx.tx_id,
        type=tx.type.value,
        status=tx.status.value,
        asset_code=tx.asset_code,
        amount_minor=str(tx.amount_minor),
        fee_minor=str(tx.fee_minor),
        from_agent_id=tx.from_agent_id,
        to_agent_id=tx.to_agent_id,
        reference_type=tx.reference_type,
        reference_id=tx.reference_id,
        idempotency_key=tx.idempotency_key,
        metadata_json=tx.metadata_json,
        created_at=tx.created_at,
        updated_at=tx.updated_at,
        completed_at=tx.completed_at,
    )


def _wd_response(wd) -> WithdrawalResponse:
    return WithdrawalResponse(
        withdrawal_id=wd.withdrawal_id,
        tx_id=wd.tx_id,
        agent_id=wd.agent_id,
        asset_code=wd.asset_code,
        amount_minor=str(wd.amount_minor),
        fee_minor=str(wd.fee_minor),
        status=wd.status.value,
        destination_type=wd.destination_type,
        review_note=wd.review_note,
        created_at=wd.created_at,
        reviewed_at=wd.reviewed_at,
        completed_at=wd.completed_at,
    )

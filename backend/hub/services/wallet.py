"""Core wallet business logic — all balance mutations happen here.

Rules:
- All balance mutations within a single DB transaction.
- SELECT ... FOR UPDATE on wallet rows before mutation.
- Write WalletEntry for every balance change (immutable ledger).
- Support idempotency_key dedup.
- Balance can never go negative.
"""

import datetime
import json
import logging

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import (
    EntryDirection,
    TopupStatus,
    TxStatus,
    TxType,
    WithdrawalStatus,
)
from hub.id_generators import (
    generate_topup_id,
    generate_tx_id,
    generate_wallet_entry_id,
    generate_withdrawal_id,
)
from hub.models import (
    Agent,
    TopupRequest,
    WalletAccount,
    WalletEntry,
    WalletTransaction,
    WithdrawalRequest,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def get_or_create_wallet(
    session: AsyncSession, agent_id: str, asset_code: str = "COIN"
) -> WalletAccount:
    """Return existing wallet or create a zero-balance wallet."""
    result = await session.execute(
        select(WalletAccount).where(
            WalletAccount.agent_id == agent_id,
            WalletAccount.asset_code == asset_code,
        )
    )
    wallet = result.scalar_one_or_none()
    if wallet is not None:
        return wallet
    wallet = WalletAccount(agent_id=agent_id, asset_code=asset_code)
    session.add(wallet)
    await session.flush()
    return wallet


def _is_sqlite(session: AsyncSession) -> bool:
    return (session.bind.dialect.name if session.bind else "") == "sqlite"


async def _lock_wallet(
    session: AsyncSession, agent_id: str, asset_code: str = "COIN"
) -> WalletAccount:
    """SELECT ... FOR UPDATE on the wallet row. Creates wallet if missing.

    SQLite does not support FOR UPDATE; we fall back to a plain select in that
    case (acceptable for tests running on SQLite).
    """
    sqlite = _is_sqlite(session)

    stmt = select(WalletAccount).where(
        WalletAccount.agent_id == agent_id,
        WalletAccount.asset_code == asset_code,
    )
    if not sqlite:
        stmt = stmt.with_for_update()

    result = await session.execute(stmt)
    wallet = result.scalar_one_or_none()
    if wallet is None:
        wallet = WalletAccount(agent_id=agent_id, asset_code=asset_code)
        session.add(wallet)
        await session.flush()
        # Re-lock after creation (for PG)
        if not sqlite:
            result = await session.execute(
                select(WalletAccount)
                .where(
                    WalletAccount.agent_id == agent_id,
                    WalletAccount.asset_code == asset_code,
                )
                .with_for_update()
            )
            wallet = result.scalar_one()
    return wallet


def _write_entry(
    session: AsyncSession,
    tx_id: str,
    agent_id: str,
    asset_code: str,
    direction: EntryDirection,
    amount_minor: int,
    balance_after_minor: int,
) -> WalletEntry:
    entry = WalletEntry(
        entry_id=generate_wallet_entry_id(),
        tx_id=tx_id,
        agent_id=agent_id,
        asset_code=asset_code,
        direction=direction,
        amount_minor=amount_minor,
        balance_after_minor=balance_after_minor,
    )
    session.add(entry)
    return entry


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


async def get_wallet_summary(
    session: AsyncSession, agent_id: str, asset_code: str = "COIN"
) -> WalletAccount:
    """Return wallet summary (creates a zero-balance wallet if none exists)."""
    return await get_or_create_wallet(session, agent_id, asset_code)


async def list_wallet_ledger(
    session: AsyncSession,
    agent_id: str,
    *,
    asset_code: str = "COIN",
    tx_type: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[WalletEntry], str | None, bool]:
    """Return paginated ledger entries for an agent.

    Returns (entries, next_cursor, has_more).
    """
    limit = min(max(limit, 1), 200)

    stmt = (
        select(WalletEntry)
        .where(
            WalletEntry.agent_id == agent_id,
            WalletEntry.asset_code == asset_code,
        )
        .order_by(WalletEntry.id.desc())
    )

    if tx_type:
        # Filter by joining with WalletTransaction
        stmt = stmt.join(
            WalletTransaction, WalletEntry.tx_id == WalletTransaction.tx_id
        ).where(WalletTransaction.type == tx_type)

    if cursor:
        try:
            cursor_id = int(cursor)
            stmt = stmt.where(WalletEntry.id < cursor_id)
        except ValueError:
            pass

    stmt = stmt.limit(limit + 1)
    result = await session.execute(stmt)
    entries = list(result.scalars().all())

    has_more = len(entries) > limit
    if has_more:
        entries = entries[:limit]

    next_cursor = str(entries[-1].id) if entries and has_more else None
    return entries, next_cursor, has_more


async def get_transaction(
    session: AsyncSession, tx_id: str
) -> WalletTransaction | None:
    result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == tx_id)
    )
    return result.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Transfer
# ---------------------------------------------------------------------------


async def create_transfer(
    session: AsyncSession,
    from_agent_id: str,
    to_agent_id: str,
    amount_minor: int,
    *,
    idempotency_key: str | None = None,
    memo: str | None = None,
    reference_type: str | None = None,
    reference_id: str | None = None,
    metadata: dict | None = None,
    asset_code: str = "COIN",
) -> WalletTransaction:
    """Atomic peer-to-peer transfer with double-entry bookkeeping."""

    # Idempotency check — scoped to (type, initiator, key)
    if idempotency_key:
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.transfer,
                WalletTransaction.initiator_agent_id == from_agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            return tx

    # Validations
    if from_agent_id == to_agent_id:
        raise ValueError("Cannot transfer to yourself")
    if amount_minor <= 0:
        raise ValueError("Amount must be positive")

    # Verify recipient exists
    recipient = await session.execute(
        select(Agent).where(Agent.agent_id == to_agent_id)
    )
    if recipient.scalar_one_or_none() is None:
        raise ValueError("Recipient agent not found")

    # Lock wallets (consistent ordering to avoid deadlock)
    ids_sorted = sorted([from_agent_id, to_agent_id])
    wallets = {}
    for aid in ids_sorted:
        wallets[aid] = await _lock_wallet(session, aid, asset_code)

    sender_wallet = wallets[from_agent_id]
    receiver_wallet = wallets[to_agent_id]

    if sender_wallet.available_balance_minor < amount_minor:
        raise ValueError("Insufficient balance")

    # Create transaction
    now = datetime.datetime.now(datetime.timezone.utc)
    tx_id = generate_tx_id()
    metadata_obj = dict(metadata or {})
    if memo is not None and "memo" not in metadata_obj:
        metadata_obj["memo"] = memo
    if reference_type is not None and "reference_type" not in metadata_obj:
        metadata_obj["reference_type"] = reference_type
    if reference_id is not None and "reference_id" not in metadata_obj:
        metadata_obj["reference_id"] = reference_id

    tx = WalletTransaction(
        tx_id=tx_id,
        type=TxType.transfer,
        status=TxStatus.completed,
        asset_code=asset_code,
        amount_minor=amount_minor,
        fee_minor=0,
        from_agent_id=from_agent_id,
        to_agent_id=to_agent_id,
        initiator_agent_id=from_agent_id,
        idempotency_key=idempotency_key,
        reference_type=reference_type,
        reference_id=reference_id,
        metadata_json=json.dumps(metadata_obj) if metadata_obj else None,
        completed_at=now,
    )
    session.add(tx)
    try:
        await session.flush()
    except IntegrityError:
        # Concurrent insert with same idempotency key — reload existing
        await session.rollback()
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.transfer,
                WalletTransaction.initiator_agent_id == from_agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            return tx
        raise ValueError("Idempotency conflict")

    # Debit sender
    sender_wallet.available_balance_minor -= amount_minor
    sender_wallet.version += 1
    _write_entry(
        session, tx_id, from_agent_id, asset_code,
        EntryDirection.debit, amount_minor,
        sender_wallet.available_balance_minor + sender_wallet.locked_balance_minor,
    )

    # Credit receiver
    receiver_wallet.available_balance_minor += amount_minor
    receiver_wallet.version += 1
    _write_entry(
        session, tx_id, to_agent_id, asset_code,
        EntryDirection.credit, amount_minor,
        receiver_wallet.available_balance_minor + receiver_wallet.locked_balance_minor,
    )

    await session.flush()
    return tx


# ---------------------------------------------------------------------------
# Topup
# ---------------------------------------------------------------------------


async def create_topup_request(
    session: AsyncSession,
    agent_id: str,
    amount_minor: int,
    *,
    channel: str = "mock",
    metadata: dict | None = None,
    idempotency_key: str | None = None,
    asset_code: str = "COIN",
) -> tuple[TopupRequest, WalletTransaction]:
    """Create a pending topup request and associated transaction."""
    if amount_minor <= 0:
        raise ValueError("Amount must be positive")

    # Idempotency check — scoped to (type, initiator, key)
    if idempotency_key:
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.topup,
                WalletTransaction.initiator_agent_id == agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            topup_result = await session.execute(
                select(TopupRequest).where(TopupRequest.tx_id == tx.tx_id)
            )
            topup = topup_result.scalar_one_or_none()
            if topup is not None:
                return topup, tx

    tx_id = generate_tx_id()
    topup_id = generate_topup_id()

    tx = WalletTransaction(
        tx_id=tx_id,
        type=TxType.topup,
        status=TxStatus.pending,
        asset_code=asset_code,
        amount_minor=amount_minor,
        fee_minor=0,
        to_agent_id=agent_id,
        initiator_agent_id=agent_id,
        idempotency_key=idempotency_key,
        metadata_json=json.dumps(metadata) if metadata else None,
    )
    session.add(tx)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.topup,
                WalletTransaction.initiator_agent_id == agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            topup_result = await session.execute(
                select(TopupRequest).where(TopupRequest.tx_id == tx.tx_id)
            )
            topup = topup_result.scalar_one_or_none()
            if topup is not None:
                return topup, tx
        raise ValueError("Idempotency conflict")

    topup = TopupRequest(
        topup_id=topup_id,
        agent_id=agent_id,
        asset_code=asset_code,
        amount_minor=amount_minor,
        status=TopupStatus.pending,
        channel=channel,
        metadata_json=json.dumps(metadata) if metadata else None,
        tx_id=tx_id,
    )
    session.add(topup)
    await session.flush()

    return topup, tx


async def complete_topup_request(
    session: AsyncSession, topup_id: str
) -> tuple[TopupRequest, WalletTransaction]:
    """Complete a pending topup — credit wallet, write entry."""
    sqlite = _is_sqlite(session)
    stmt = select(TopupRequest).where(TopupRequest.topup_id == topup_id)
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    topup = result.scalar_one_or_none()
    if topup is None:
        raise ValueError("Topup request not found")
    if topup.status != TopupStatus.pending:
        raise ValueError(f"Topup is not pending (current: {topup.status.value})")

    # Lock wallet and credit
    wallet = await _lock_wallet(session, topup.agent_id, topup.asset_code)
    wallet.available_balance_minor += topup.amount_minor
    wallet.version += 1

    now = datetime.datetime.now(datetime.timezone.utc)
    topup.status = TopupStatus.completed
    topup.completed_at = now

    # Update transaction
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == topup.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.completed
    tx.completed_at = now

    # Write ledger entry
    _write_entry(
        session, tx.tx_id, topup.agent_id, topup.asset_code,
        EntryDirection.credit, topup.amount_minor,
        wallet.available_balance_minor + wallet.locked_balance_minor,
    )

    await session.flush()
    return topup, tx


async def fail_topup_request(
    session: AsyncSession, topup_id: str
) -> TopupRequest:
    """Mark a pending topup as failed."""
    sqlite = _is_sqlite(session)
    stmt = select(TopupRequest).where(TopupRequest.topup_id == topup_id)
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    topup = result.scalar_one_or_none()
    if topup is None:
        raise ValueError("Topup request not found")
    if topup.status != TopupStatus.pending:
        raise ValueError(f"Topup is not pending (current: {topup.status.value})")

    topup.status = TopupStatus.failed

    # Update transaction
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == topup.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.failed

    await session.flush()
    return topup


# ---------------------------------------------------------------------------
# Withdrawal
# ---------------------------------------------------------------------------


async def create_withdrawal_request(
    session: AsyncSession,
    agent_id: str,
    amount_minor: int,
    *,
    fee_minor: int = 0,
    destination_type: str | None = None,
    destination_json: str | None = None,
    idempotency_key: str | None = None,
    asset_code: str = "COIN",
) -> tuple[WithdrawalRequest, WalletTransaction]:
    """Create a withdrawal request — locks balance."""
    if amount_minor <= 0:
        raise ValueError("Amount must be positive")
    if fee_minor < 0:
        raise ValueError("Fee must be non-negative")

    total = amount_minor + fee_minor

    # Idempotency — scoped to (type, initiator, key)
    if idempotency_key:
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.withdrawal,
                WalletTransaction.initiator_agent_id == agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            wd_result = await session.execute(
                select(WithdrawalRequest).where(
                    WithdrawalRequest.tx_id == tx.tx_id
                )
            )
            wd = wd_result.scalar_one_or_none()
            if wd is not None:
                return wd, tx

    # Lock wallet
    wallet = await _lock_wallet(session, agent_id, asset_code)
    if wallet.available_balance_minor < total:
        raise ValueError("Insufficient balance")

    # Move from available to locked
    wallet.available_balance_minor -= total
    wallet.locked_balance_minor += total
    wallet.version += 1

    tx_id = generate_tx_id()
    withdrawal_id = generate_withdrawal_id()

    tx = WalletTransaction(
        tx_id=tx_id,
        type=TxType.withdrawal,
        status=TxStatus.pending,
        asset_code=asset_code,
        amount_minor=amount_minor,
        fee_minor=fee_minor,
        from_agent_id=agent_id,
        initiator_agent_id=agent_id,
        idempotency_key=idempotency_key,
    )
    session.add(tx)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        existing = await session.execute(
            select(WalletTransaction).where(
                WalletTransaction.idempotency_key == idempotency_key,
                WalletTransaction.type == TxType.withdrawal,
                WalletTransaction.initiator_agent_id == agent_id,
            )
        )
        tx = existing.scalar_one_or_none()
        if tx is not None:
            wd_result = await session.execute(
                select(WithdrawalRequest).where(
                    WithdrawalRequest.tx_id == tx.tx_id
                )
            )
            wd = wd_result.scalar_one_or_none()
            if wd is not None:
                return wd, tx
        raise ValueError("Idempotency conflict")

    wd = WithdrawalRequest(
        withdrawal_id=withdrawal_id,
        agent_id=agent_id,
        asset_code=asset_code,
        amount_minor=amount_minor,
        fee_minor=fee_minor,
        status=WithdrawalStatus.pending,
        destination_type=destination_type,
        destination_json=destination_json,
        tx_id=tx_id,
    )
    session.add(wd)
    await session.flush()

    return wd, tx


async def approve_withdrawal_request(
    session: AsyncSession, withdrawal_id: str
) -> WithdrawalRequest:
    """Approve a pending withdrawal."""
    sqlite = _is_sqlite(session)
    stmt = select(WithdrawalRequest).where(
        WithdrawalRequest.withdrawal_id == withdrawal_id
    )
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    wd = result.scalar_one_or_none()
    if wd is None:
        raise ValueError("Withdrawal request not found")
    if wd.status != WithdrawalStatus.pending:
        raise ValueError(f"Withdrawal is not pending (current: {wd.status.value})")

    now = datetime.datetime.now(datetime.timezone.utc)
    wd.status = WithdrawalStatus.approved
    wd.reviewed_at = now

    # Update transaction status
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == wd.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.processing

    await session.flush()
    return wd


async def reject_withdrawal_request(
    session: AsyncSession, withdrawal_id: str, note: str | None = None
) -> WithdrawalRequest:
    """Reject a pending withdrawal — unlock balance."""
    sqlite = _is_sqlite(session)
    stmt = select(WithdrawalRequest).where(
        WithdrawalRequest.withdrawal_id == withdrawal_id
    )
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    wd = result.scalar_one_or_none()
    if wd is None:
        raise ValueError("Withdrawal request not found")
    if wd.status != WithdrawalStatus.pending:
        raise ValueError(f"Withdrawal is not pending (current: {wd.status.value})")

    total = wd.amount_minor + wd.fee_minor

    # Unlock balance
    wallet = await _lock_wallet(session, wd.agent_id, wd.asset_code)
    wallet.locked_balance_minor -= total
    wallet.available_balance_minor += total
    wallet.version += 1

    now = datetime.datetime.now(datetime.timezone.utc)
    wd.status = WithdrawalStatus.rejected
    wd.review_note = note
    wd.reviewed_at = now

    # Update transaction
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == wd.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.failed

    await session.flush()
    return wd


async def complete_withdrawal_request(
    session: AsyncSession, withdrawal_id: str
) -> tuple[WithdrawalRequest, WalletTransaction]:
    """Complete an approved withdrawal — deduct locked balance, write entry."""
    sqlite = _is_sqlite(session)
    stmt = select(WithdrawalRequest).where(
        WithdrawalRequest.withdrawal_id == withdrawal_id
    )
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    wd = result.scalar_one_or_none()
    if wd is None:
        raise ValueError("Withdrawal request not found")
    if wd.status != WithdrawalStatus.approved:
        raise ValueError(f"Withdrawal is not approved (current: {wd.status.value})")

    total = wd.amount_minor + wd.fee_minor

    # Deduct locked balance
    wallet = await _lock_wallet(session, wd.agent_id, wd.asset_code)
    wallet.locked_balance_minor -= total
    wallet.version += 1

    now = datetime.datetime.now(datetime.timezone.utc)
    wd.status = WithdrawalStatus.completed
    wd.completed_at = now

    # Update transaction
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == wd.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.completed
    tx.completed_at = now

    # Write ledger entry
    _write_entry(
        session, tx.tx_id, wd.agent_id, wd.asset_code,
        EntryDirection.debit, total,
        wallet.available_balance_minor + wallet.locked_balance_minor,
    )

    await session.flush()
    return wd, tx


async def cancel_withdrawal_request(
    session: AsyncSession, withdrawal_id: str, agent_id: str
) -> WithdrawalRequest:
    """Cancel a pending withdrawal — unlock balance. Only the requesting agent can cancel."""
    sqlite = _is_sqlite(session)
    stmt = select(WithdrawalRequest).where(
        WithdrawalRequest.withdrawal_id == withdrawal_id
    )
    if not sqlite:
        stmt = stmt.with_for_update()
    result = await session.execute(stmt)
    wd = result.scalar_one_or_none()
    if wd is None:
        raise ValueError("Withdrawal request not found")
    if wd.agent_id != agent_id:
        raise ValueError("Not authorized to cancel this withdrawal")
    if wd.status != WithdrawalStatus.pending:
        raise ValueError(f"Withdrawal is not pending (current: {wd.status.value})")

    total = wd.amount_minor + wd.fee_minor

    # Unlock balance
    wallet = await _lock_wallet(session, wd.agent_id, wd.asset_code)
    wallet.locked_balance_minor -= total
    wallet.available_balance_minor += total
    wallet.version += 1

    wd.status = WithdrawalStatus.cancelled

    # Update transaction
    tx_result = await session.execute(
        select(WalletTransaction).where(WalletTransaction.tx_id == wd.tx_id)
    )
    tx = tx_result.scalar_one()
    tx.status = TxStatus.cancelled

    await session.flush()
    return wd

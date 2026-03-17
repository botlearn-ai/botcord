"""Pydantic request/response schemas for the wallet / coin economy system."""

import datetime

from pydantic import BaseModel, Field


# --- Responses ---


class WalletSummaryResponse(BaseModel):
    agent_id: str
    asset_code: str
    available_balance_minor: str
    locked_balance_minor: str
    total_balance_minor: str
    updated_at: datetime.datetime


class TransactionResponse(BaseModel):
    tx_id: str
    type: str
    status: str
    asset_code: str
    amount_minor: str
    fee_minor: str
    from_agent_id: str | None = None
    to_agent_id: str | None = None
    reference_type: str | None = None
    reference_id: str | None = None
    idempotency_key: str | None = None
    metadata_json: str | None = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    completed_at: datetime.datetime | None = None


class LedgerEntryResponse(BaseModel):
    entry_id: str
    tx_id: str
    agent_id: str
    asset_code: str
    direction: str
    amount_minor: str
    balance_after_minor: str
    created_at: datetime.datetime


class LedgerListResponse(BaseModel):
    entries: list[LedgerEntryResponse]
    next_cursor: str | None = None
    has_more: bool


class TopupResponse(BaseModel):
    topup_id: str
    tx_id: str | None = None
    agent_id: str
    asset_code: str
    amount_minor: str
    status: str
    channel: str
    created_at: datetime.datetime
    completed_at: datetime.datetime | None = None


class WithdrawalResponse(BaseModel):
    withdrawal_id: str
    tx_id: str | None = None
    agent_id: str
    asset_code: str
    amount_minor: str
    fee_minor: str
    status: str
    destination_type: str | None = None
    review_note: str | None = None
    created_at: datetime.datetime
    reviewed_at: datetime.datetime | None = None
    completed_at: datetime.datetime | None = None


# --- Requests ---


class TransferRequest(BaseModel):
    to_agent_id: str = Field(..., min_length=1)
    amount_minor: str = Field(..., min_length=1, description="Amount in minor units as string")
    memo: str | None = None
    idempotency_key: str | None = None


class TopupCreateRequest(BaseModel):
    amount_minor: str = Field(..., min_length=1)
    channel: str = "mock"
    metadata: dict | None = None
    idempotency_key: str | None = None


class WithdrawalCreateRequest(BaseModel):
    amount_minor: str = Field(..., min_length=1)
    fee_minor: str = Field(default="0", description="Fee in minor units (must be >= 0)")
    destination_type: str | None = None
    destination: dict | None = None
    idempotency_key: str | None = None


class WithdrawalRejectRequest(BaseModel):
    note: str | None = None

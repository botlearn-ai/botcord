"""Pydantic request/response schemas for subscription products and billing."""

import datetime

from pydantic import BaseModel, Field


class SubscriptionProductCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(default="")
    amount_minor: str = Field(..., min_length=1)
    billing_interval: str = Field(..., description="week, month, or once")


class SubscriptionCreateRequest(BaseModel):
    idempotency_key: str | None = None
    room_id: str | None = None


class SubscriptionProductResponse(BaseModel):
    product_id: str
    owner_agent_id: str
    name: str
    description: str
    asset_code: str
    amount_minor: str
    billing_interval: str
    status: str
    created_at: datetime.datetime
    updated_at: datetime.datetime
    archived_at: datetime.datetime | None = None


class SubscriptionProductListResponse(BaseModel):
    products: list[SubscriptionProductResponse]


class SubscriptionResponse(BaseModel):
    subscription_id: str
    product_id: str
    subscriber_agent_id: str
    provider_agent_id: str
    asset_code: str
    amount_minor: str
    billing_interval: str
    status: str
    current_period_start: datetime.datetime
    current_period_end: datetime.datetime
    next_charge_at: datetime.datetime
    cancel_at_period_end: bool
    cancelled_at: datetime.datetime | None = None
    last_charged_at: datetime.datetime | None = None
    last_charge_tx_id: str | None = None
    consecutive_failed_attempts: int
    created_at: datetime.datetime
    updated_at: datetime.datetime


class SubscriptionListResponse(BaseModel):
    subscriptions: list[SubscriptionResponse]


class SubscriptionChargeAttemptResponse(BaseModel):
    attempt_id: str
    subscription_id: str
    billing_cycle_key: str
    status: str
    scheduled_at: datetime.datetime
    attempted_at: datetime.datetime | None = None
    tx_id: str | None = None
    failure_reason: str | None = None
    attempt_count: int
    created_at: datetime.datetime
    updated_at: datetime.datetime


class SubscriptionBillingResponse(BaseModel):
    processed_count: int
    charged_count: int
    failed_count: int
    skipped_count: int

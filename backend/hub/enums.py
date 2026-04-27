"""Centralized enum definitions for the BotCord hub."""

import enum


class KeyState(str, enum.Enum):
    pending = "pending"
    active = "active"
    revoked = "revoked"


class EndpointState(str, enum.Enum):
    active = "active"
    inactive = "inactive"
    unreachable = "unreachable"
    unverified = "unverified"


class MessagePolicy(str, enum.Enum):
    open = "open"
    contacts_only = "contacts_only"


class ContactPolicy(str, enum.Enum):
    """Who can directly contact the agent (DM / direct send / human-room speech)."""

    open = "open"
    contacts_only = "contacts_only"
    whitelist = "whitelist"
    closed = "closed"


class RoomInvitePolicy(str, enum.Enum):
    """Who can invite the agent into a room."""

    open = "open"
    contacts_only = "contacts_only"
    closed = "closed"


class AttentionMode(str, enum.Enum):
    """Daemon-side attention gate — does an inbound message wake the runtime?"""

    always = "always"
    mention_only = "mention_only"
    keyword = "keyword"
    muted = "muted"


class MessageState(str, enum.Enum):
    queued = "queued"
    processing = "processing"  # Claimed by a consumer, pending explicit ack
    delivered = "delivered"
    acked = "acked"
    done = "done"
    failed = "failed"


class ContactRequestState(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class RoomRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"


class RoomVisibility(str, enum.Enum):
    public = "public"
    private = "private"


class RoomJoinPolicy(str, enum.Enum):
    open = "open"
    invite_only = "invite_only"


class RoomJoinRequestStatus(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class MessageType(str, enum.Enum):
    message = "message"
    ack = "ack"
    result = "result"
    error = "error"
    contact_request = "contact_request"
    contact_request_response = "contact_request_response"
    contact_removed = "contact_removed"
    system = "system"


class TopicStatus(str, enum.Enum):
    open = "open"
    completed = "completed"
    failed = "failed"
    expired = "expired"


class TxType(str, enum.Enum):
    grant = "grant"
    topup = "topup"
    withdrawal = "withdrawal"
    transfer = "transfer"


class BillingInterval(str, enum.Enum):
    week = "week"
    month = "month"
    once = "once"


class SubscriptionProductStatus(str, enum.Enum):
    active = "active"
    archived = "archived"


class SubscriptionStatus(str, enum.Enum):
    active = "active"
    past_due = "past_due"
    cancelled = "cancelled"


class SubscriptionChargeAttemptStatus(str, enum.Enum):
    pending = "pending"
    succeeded = "succeeded"
    failed = "failed"


class TxStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class TopupStatus(str, enum.Enum):
    pending = "pending"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class WithdrawalStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    completed = "completed"
    cancelled = "cancelled"


class EntryDirection(str, enum.Enum):
    debit = "debit"
    credit = "credit"


class BetaCodeStatus(str, enum.Enum):
    active = "active"
    revoked = "revoked"


class BetaWaitlistStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"


class ParticipantType(str, enum.Enum):
    """Discriminator for the participant polymorphism on Room/Contact/Block/etc.

    Agents (ag_*) sign their own envelopes (Ed25519). Humans (hu_*) do not sign;
    their identity is proven by a Supabase JWT whose user record owns the
    `human_id`.
    """

    agent = "agent"
    human = "human"


class ApprovalKind(str, enum.Enum):
    """Kinds of external requests a Human can approve on behalf of a claimed Agent."""

    contact_request = "contact_request"
    room_invite = "room_invite"
    payment = "payment"


class ApprovalState(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"


class ErrorCode(str, enum.Enum):
    INVALID_SIGNATURE = "INVALID_SIGNATURE"
    UNKNOWN_AGENT = "UNKNOWN_AGENT"
    ENDPOINT_UNREACHABLE = "ENDPOINT_UNREACHABLE"
    TTL_EXPIRED = "TTL_EXPIRED"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    BLOCKED = "BLOCKED"
    NOT_IN_CONTACTS = "NOT_IN_CONTACTS"

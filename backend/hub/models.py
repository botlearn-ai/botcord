"""
[INPUT]: 依赖 SQLAlchemy Base、枚举与关系定义，承载 Hub 与 dashboard 的持久化真相源
[OUTPUT]: 对外提供 Agent、Invite、ShortCode 等领域模型，供路由与服务共享
[POS]: backend 数据模型中枢，负责把身份、社交、支付、绑定等状态收敛到统一 schema
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import datetime

import uuid as _uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from hub.enums import (  # noqa: F401 — re-exported for backward compatibility
    BetaCodeStatus,
    BetaWaitlistStatus,
    BillingInterval,
    ContactRequestState,
    EndpointState,
    EntryDirection,
    KeyState,
    MessagePolicy,
    MessageState,
    RoomJoinPolicy,
    RoomJoinRequestStatus,
    RoomRole,
    RoomVisibility,
    SubscriptionChargeAttemptStatus,
    SubscriptionProductStatus,
    SubscriptionStatus,
    TopicStatus,
    TopupStatus,
    TxStatus,
    TxType,
    WithdrawalStatus,
)


class Base(DeclarativeBase):
    pass


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_policy: Mapped[MessagePolicy] = mapped_column(
        Enum(MessagePolicy), nullable=False, server_default="contacts_only"
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    user_id: Mapped[_uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    agent_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claim_code: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        default=lambda: f"clm_{_uuid.uuid4().hex}",
    )
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    claimed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    signing_keys: Mapped[list["SigningKey"]] = relationship(back_populates="agent")
    challenges: Mapped[list["Challenge"]] = relationship(back_populates="agent")
    used_nonces: Mapped[list["UsedNonce"]] = relationship(back_populates="agent")
    endpoints: Mapped[list["Endpoint"]] = relationship(back_populates="agent")


class SigningKey(Base):
    __tablename__ = "signing_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    key_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    pubkey: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[KeyState] = mapped_column(Enum(KeyState), nullable=False, default=KeyState.pending)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    agent: Mapped["Agent"] = relationship(back_populates="signing_keys")


class Challenge(Base):
    __tablename__ = "challenges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False
    )
    key_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("signing_keys.key_id"), nullable=False
    )
    challenge: Mapped[str] = mapped_column(Text, nullable=False)  # base64-encoded 32 bytes
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    agent: Mapped["Agent"] = relationship(back_populates="challenges")


class UsedNonce(Base):
    __tablename__ = "used_nonces"
    __table_args__ = (
        UniqueConstraint("agent_id", "nonce", name="uq_used_nonce"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    nonce: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    agent: Mapped["Agent"] = relationship(back_populates="used_nonces")


class UsedBindTicket(Base):
    """Tracks consumed bind ticket JTIs to prevent replay attacks.

    No FK to agents — the ticket may be consumed before the agent row exists.
    Rows can be periodically cleaned where created_at < now - 10 minutes.
    """
    __tablename__ = "used_bind_tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    jti: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ShortCode(Base):
    """Generic short-lived code table for bind and future URL/token flows."""

    __tablename__ = "short_codes"
    __table_args__ = (
        UniqueConstraint("code", name="uq_short_codes_code"),
        Index("ix_short_codes_kind_created", "kind", "created_at"),
        Index("ix_short_codes_owner_created", "owner_user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    owner_user_id: Mapped[_uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    consumed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Endpoint(Base):
    __tablename__ = "endpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    endpoint_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    webhook_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[EndpointState] = mapped_column(
        Enum(EndpointState), nullable=False, default=EndpointState.active
    )
    last_probe_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_delivery_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    registered_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    agent: Mapped["Agent"] = relationship(back_populates="endpoints")


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    rule: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    owner_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    visibility: Mapped[RoomVisibility] = mapped_column(
        Enum(RoomVisibility), nullable=False, default=RoomVisibility.private
    )
    join_policy: Mapped[RoomJoinPolicy] = mapped_column(
        Enum(RoomJoinPolicy), nullable=False, default=RoomJoinPolicy.invite_only
    )
    required_subscription_product_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("subscription_products.product_id"),
        nullable=True,
        index=True,
    )
    max_members: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_send: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    default_invite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    slow_mode_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    members: Mapped[list["RoomMember"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    topics: Mapped[list["Topic"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )


class SubscriptionRoomCreatorPolicy(Base):
    __tablename__ = "subscription_room_creator_policies"
    __table_args__ = (
        UniqueConstraint("agent_id", name="uq_subscription_room_creator_policy_agent"),
        CheckConstraint("max_active_rooms >= 0", name="ck_subscription_room_creator_policy_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    allowed_to_create: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    max_active_rooms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RoomMember(Base):
    __tablename__ = "room_members"
    __table_args__ = (
        UniqueConstraint("room_id", "agent_id"),
        Index("ix_room_members_agent_room", "agent_id", "room_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    role: Mapped[RoomRole] = mapped_column(
        Enum(RoomRole), nullable=False, default=RoomRole.member
    )
    muted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_send: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=None)
    can_invite: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=None)
    last_viewed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    joined_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    room: Mapped["Room"] = relationship(back_populates="members")


class RoomJoinRequest(Base):
    __tablename__ = "room_join_requests"
    __table_args__ = (
        UniqueConstraint("room_id", "agent_id", "status", name="uq_room_join_request_pending"),
        Index("ix_room_join_requests_room_status", "room_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[RoomJoinRequestStatus] = mapped_column(
        Enum(RoomJoinRequestStatus), nullable=False, default=RoomJoinRequestStatus.pending
    )
    responded_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class MessageRecord(Base):
    __tablename__ = "message_records"
    __table_args__ = (
        UniqueConstraint("msg_id", "receiver_id"),
        Index("ix_message_records_retry", "state", "next_retry_at"),
        Index("ix_message_records_room_id_created_at_id", "room_id", "created_at", "id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hub_msg_id: Mapped[str] = mapped_column(String(48), unique=True, nullable=False, index=True)
    msg_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    sender_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    receiver_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    room_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    topic: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    topic_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    goal: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    state: Mapped[MessageState] = mapped_column(
        Enum(MessageState), nullable=False, default=MessageState.queued
    )
    envelope_json: Mapped[str] = mapped_column(Text, nullable=False)
    ttl_sec: Mapped[int] = mapped_column(Integer, nullable=False)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    delivered_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    acked_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    mentioned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="agent", server_default="agent"
    )
    source_user_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_session_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    source_user_agent: Mapped[str | None] = mapped_column(String(256), nullable=True)


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        UniqueConstraint("owner_id", "contact_agent_id", name="uq_contact"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    contact_agent_id: Mapped[str] = mapped_column(String(32), nullable=False)
    alias: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Block(Base):
    __tablename__ = "blocks"
    __table_args__ = (
        UniqueConstraint("owner_id", "blocked_agent_id", name="uq_block"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    blocked_agent_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Share(Base):
    __tablename__ = "shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    share_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    shared_by_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False
    )
    shared_by_name: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    messages: Mapped[list["ShareMessage"]] = relationship(
        back_populates="share", cascade="all, delete-orphan"
    )


class ShareMessage(Base):
    __tablename__ = "share_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    share_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("shares.share_id"), nullable=False, index=True
    )
    hub_msg_id: Mapped[str] = mapped_column(String(48), nullable=False)
    msg_id: Mapped[str] = mapped_column(String(64), nullable=False)
    sender_id: Mapped[str] = mapped_column(String(32), nullable=False)
    sender_name: Mapped[str] = mapped_column(String(128), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False, default="message")
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    share: Mapped["Share"] = relationship(back_populates="messages")


class Invite(Base):
    __tablename__ = "invites"
    __table_args__ = (
        UniqueConstraint("code", name="uq_invites_code"),
        Index("ix_invites_creator_kind", "creator_agent_id", "kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    creator_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    room_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=True, index=True
    )
    expires_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class InviteRedemption(Base):
    __tablename__ = "invite_redemptions"
    __table_args__ = (
        UniqueConstraint("code", "redeemer_agent_id", name="uq_invite_redemption"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(
        String(32), ForeignKey("invites.code"), nullable=False, index=True
    )
    redeemer_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ContactRequest(Base):
    __tablename__ = "contact_requests"
    __table_args__ = (
        UniqueConstraint("from_agent_id", "to_agent_id", name="uq_contact_request"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    from_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    to_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    state: Mapped[ContactRequestState] = mapped_column(
        Enum(ContactRequestState), nullable=False, default=ContactRequestState.pending
    )
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = (
        UniqueConstraint("room_id", "title", name="uq_topic_room_title"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[TopicStatus] = mapped_column(
        Enum(TopicStatus), nullable=False, default=TopicStatus.open
    )
    creator_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    goal: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    closed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    room: Mapped["Room"] = relationship(back_populates="topics")


class FileRecord(Base):
    __tablename__ = "file_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    uploader_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    original_filename: Mapped[str] = mapped_column(String(256), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_backend: Mapped[str] = mapped_column(String(32), nullable=False, default="disk", index=True)
    disk_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_bucket: Mapped[str | None] = mapped_column(String(128), nullable=True)
    storage_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ---------------------------------------------------------------------------
# Wallet / Economy models
#
# Currency convention:
#   1 COIN = 100 minor units (similar to 1 USD = 100 cents).
#   All `amount_minor` / `balance_*_minor` / `fee_minor` columns store
#   values in minor units (integer).  Display-side divides by 100.
# ---------------------------------------------------------------------------


class WalletAccount(Base):
    __tablename__ = "wallet_accounts"
    __table_args__ = (
        UniqueConstraint("agent_id", "asset_code", name="uq_wallet_agent_asset"),
        CheckConstraint("available_balance_minor >= 0", name="ck_wallet_available_nonneg"),
        CheckConstraint("locked_balance_minor >= 0", name="ck_wallet_locked_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    available_balance_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    locked_balance_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WalletTransaction(Base):
    __tablename__ = "wallet_transactions"
    __table_args__ = (
        # Idempotency: scoped to (type, initiator_agent_id, idempotency_key).
        # initiator_agent_id is from_agent_id for transfer/withdrawal, to_agent_id for topup.
        # We use a computed-style approach: store the initiator in a dedicated column.
        UniqueConstraint("type", "initiator_agent_id", "idempotency_key", name="uq_tx_idem"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tx_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    type: Mapped[TxType] = mapped_column(Enum(TxType), nullable=False)
    status: Mapped[TxStatus] = mapped_column(Enum(TxStatus), nullable=False, default=TxStatus.pending)
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    from_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    to_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    initiator_agent_id: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True,
        doc="The agent who initiated the tx: from_agent_id for transfer/withdrawal, to_agent_id for topup"
    )
    reference_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class WalletEntry(Base):
    __tablename__ = "wallet_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    tx_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("wallet_transactions.tx_id"), nullable=False, index=True
    )
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    direction: Mapped[EntryDirection] = mapped_column(Enum(EntryDirection), nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class TopupRequest(Base):
    __tablename__ = "topup_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topup_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[TopupStatus] = mapped_column(
        Enum(TopupStatus), nullable=False, default=TopupStatus.pending
    )
    channel: Mapped[str] = mapped_column(String(32), nullable=False, default="mock")
    external_ref: Mapped[str | None] = mapped_column(String(256), nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    tx_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("wallet_transactions.tx_id"), nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class WithdrawalRequest(Base):
    __tablename__ = "withdrawal_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    withdrawal_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    status: Mapped[WithdrawalStatus] = mapped_column(
        Enum(WithdrawalStatus), nullable=False, default=WithdrawalStatus.pending
    )
    destination_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    destination_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    tx_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("wallet_transactions.tx_id"), nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    reviewed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SubscriptionProduct(Base):
    __tablename__ = "subscription_products"
    __table_args__ = (
        UniqueConstraint("owner_agent_id", "name", name="uq_subscription_product_owner_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    owner_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    billing_interval: Mapped[BillingInterval] = mapped_column(
        Enum(BillingInterval), nullable=False
    )
    status: Mapped[SubscriptionProductStatus] = mapped_column(
        Enum(SubscriptionProductStatus), nullable=False, default=SubscriptionProductStatus.active
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    archived_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AgentSubscription(Base):
    __tablename__ = "agent_subscriptions"
    __table_args__ = (
        UniqueConstraint("product_id", "subscriber_agent_id", name="uq_subscription_product_subscriber"),
        CheckConstraint("amount_minor > 0", name="ck_subscription_amount_positive"),
        CheckConstraint("consecutive_failed_attempts >= 0", name="ck_subscription_failed_attempts_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscription_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("subscription_products.product_id"), nullable=False, index=True
    )
    subscriber_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    provider_agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    billing_interval: Mapped[BillingInterval] = mapped_column(
        Enum(BillingInterval), nullable=False
    )
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), nullable=False, default=SubscriptionStatus.active
    )
    current_period_start: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    current_period_end: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    next_charge_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cancelled_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_charged_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_charge_tx_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("wallet_transactions.tx_id"), nullable=True
    )
    consecutive_failed_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SubscriptionChargeAttempt(Base):
    __tablename__ = "subscription_charge_attempts"
    __table_args__ = (
        UniqueConstraint("subscription_id", "billing_cycle_key", name="uq_subscription_cycle"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    subscription_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("agent_subscriptions.subscription_id"), nullable=False, index=True
    )
    billing_cycle_key: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[SubscriptionChargeAttemptStatus] = mapped_column(
        Enum(SubscriptionChargeAttemptStatus), nullable=False, default=SubscriptionChargeAttemptStatus.pending
    )
    scheduled_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    attempted_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    tx_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("wallet_transactions.tx_id"), nullable=True
    )
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ---------------------------------------------------------------------------
# User / RBAC models
# ---------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": "public"}

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    email: Mapped[str | None] = mapped_column(String(256), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    supabase_user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, unique=True, nullable=False, index=True)
    max_agents: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    banned_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ban_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    last_login_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    beta_access: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    beta_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    user_roles: Mapped[list["UserRole"]] = relationship(back_populates="user")


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = {"schema": "public"}

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Permission(Base):
    __tablename__ = "permissions"
    __table_args__ = {"schema": "public"}

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    resource: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(String(32), nullable=False, default="own")
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_id", name="uq_role_permission"),
        {"schema": "public"},
    )

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    role_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.roles.id"), nullable=False, index=True
    )
    permission_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.permissions.id"), nullable=False, index=True
    )


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", name="uq_user_role"),
        {"schema": "public"},
    )

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    user_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.users.id"), nullable=False, index=True
    )
    role_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.roles.id"), nullable=False, index=True
    )
    granted_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped["User"] = relationship(back_populates="user_roles")
    role: Mapped["Role"] = relationship()


# ---------------------------------------------------------------------------
# Beta invite gate
# ---------------------------------------------------------------------------


class BetaInviteCode(Base):
    __tablename__ = "beta_invite_codes"

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    used_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str] = mapped_column(String(256), nullable=False, default="")
    expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[BetaCodeStatus] = mapped_column(
        Enum(BetaCodeStatus, name="betacodestatus"), nullable=False, default=BetaCodeStatus.active
    )
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    redemptions: Mapped[list["BetaCodeRedemption"]] = relationship(back_populates="invite_code")


class BetaCodeRedemption(Base):
    __tablename__ = "beta_code_redemptions"

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    code_id: Mapped[_uuid.UUID] = mapped_column(Uuid, ForeignKey("beta_invite_codes.id"), nullable=False, index=True)
    user_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.users.id"), nullable=False, unique=True, index=True
    )
    redeemed_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    invite_code: Mapped["BetaInviteCode"] = relationship(back_populates="redemptions")


class BetaWaitlistEntry(Base):
    __tablename__ = "beta_waitlist_entries"

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    user_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.users.id"), nullable=False, unique=True, index=True
    )
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[BetaWaitlistStatus] = mapped_column(
        Enum(BetaWaitlistStatus, name="betawaitliststatus"),
        nullable=False,
        default=BetaWaitlistStatus.pending,
    )
    applied_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    reviewed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sent_code_id: Mapped[_uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("beta_invite_codes.id"), nullable=True
    )

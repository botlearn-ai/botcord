import datetime

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
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from hub.enums import (  # noqa: F401 — re-exported for backward compatibility
    ContactRequestState,
    EndpointState,
    EntryDirection,
    KeyState,
    MessagePolicy,
    MessageState,
    RoomJoinPolicy,
    RoomRole,
    RoomVisibility,
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
    owner_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False, index=True
    )
    visibility: Mapped[RoomVisibility] = mapped_column(
        Enum(RoomVisibility), nullable=False, default=RoomVisibility.private
    )
    join_policy: Mapped[RoomJoinPolicy] = mapped_column(
        Enum(RoomJoinPolicy), nullable=False, default=RoomJoinPolicy.invite_only
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


class RoomMember(Base):
    __tablename__ = "room_members"
    __table_args__ = (UniqueConstraint("room_id", "agent_id"),)

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
    joined_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    room: Mapped["Room"] = relationship(back_populates="members")


class MessageRecord(Base):
    __tablename__ = "message_records"
    __table_args__ = (
        UniqueConstraint("msg_id", "receiver_id"),
        Index("ix_message_records_retry", "state", "next_retry_at"),
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
    disk_path: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ---------------------------------------------------------------------------
# Wallet / Economy models
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

"""
[INPUT]: 依赖 SQLAlchemy Base、枚举与关系定义，承载 Hub 与 dashboard 的持久化真相源
[OUTPUT]: 对外提供 Agent、Invite、ShortCode 等领域模型，供路由与服务共享
[POS]: backend 数据模型中枢，负责把身份、社交、支付、绑定等状态收敛到统一 schema
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import datetime

import uuid as _uuid

from sqlalchemy import (
    JSON,
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
    text as sa_text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from hub.id_generators import generate_human_id
from hub.enums import (  # noqa: F401 — re-exported for backward compatibility
    ApprovalKind,
    ApprovalState,
    AttentionMode,
    BetaCodeStatus,
    BetaWaitlistStatus,
    BillingInterval,
    ContactPolicy,
    ContactRequestState,
    EndpointState,
    EntryDirection,
    KeyState,
    MessagePolicy,
    MessageState,
    ParticipantType,
    RoomInvitePolicy,
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
    __table_args__ = (
        CheckConstraint(
            "hosting_kind IS NULL OR hosting_kind IN ('daemon', 'plugin', 'cli')",
            name="ck_agents_hosting_kind",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_policy: Mapped[MessagePolicy] = mapped_column(
        Enum(MessagePolicy), nullable=False, server_default="contacts_only"
    )
    contact_policy: Mapped[ContactPolicy] = mapped_column(
        Enum(ContactPolicy, name="contactpolicy", native_enum=False, length=32),
        nullable=False,
        default=ContactPolicy.contacts_only,
        server_default=ContactPolicy.contacts_only.value,
    )
    allow_agent_sender: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
    allow_human_sender: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
    room_invite_policy: Mapped[RoomInvitePolicy] = mapped_column(
        Enum(RoomInvitePolicy, name="roominvitepolicy", native_enum=False, length=32),
        nullable=False,
        default=RoomInvitePolicy.contacts_only,
        server_default=RoomInvitePolicy.contacts_only.value,
    )
    default_attention: Mapped[AttentionMode] = mapped_column(
        Enum(AttentionMode, name="attentionmode", native_enum=False, length=32),
        nullable=False,
        default=AttentionMode.always,
        server_default=AttentionMode.always.value,
    )
    attention_keywords: Mapped[str] = mapped_column(
        Text, nullable=False, default="[]", server_default="[]"
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    user_id: Mapped[_uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    agent_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claim_code: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        unique=True,
        index=True,
        default=lambda: f"clm_{_uuid.uuid4().hex}",
    )
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    claimed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", server_default="active")
    deleted_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    daemon_instance_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("daemon_instances.id", ondelete="SET NULL"), nullable=True, index=True
    )
    openclaw_host_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("openclaw_host_instances.id", ondelete="SET NULL"), nullable=True, index=True
    )
    hosting_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Runtime selected at creation (claude-code / codex / gemini / ...).
    # Null for agents created via bind_code.
    runtime: Mapped[str | None] = mapped_column(String(32), nullable=True)

    signing_keys: Mapped[list["SigningKey"]] = relationship(back_populates="agent")
    challenges: Mapped[list["Challenge"]] = relationship(back_populates="agent")
    used_nonces: Mapped[list["UsedNonce"]] = relationship(back_populates="agent")
    endpoints: Mapped[list["Endpoint"]] = relationship(back_populates="agent")

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    @property
    def is_deletable(self) -> bool:
        return self.status == "active" and self.user_id is not None


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
    # Holds either an ag_* or hu_* participant id. FK removed because the
    # column is now polymorphic — the discriminator is ``owner_type``.
    owner_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    owner_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
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
    allow_human_send: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
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
    # ``agent_id`` is kept as the column name for backward compatibility with
    # the unique constraint and legacy queries, but now stores any participant
    # id (ag_* or hu_*). The FK to agents was dropped so Human members are
    # legal; ``participant_type`` is the discriminator.
    agent_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    participant_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
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
    agent: Mapped["Agent"] = relationship(
        "Agent",
        primaryjoin="RoomMember.agent_id == Agent.agent_id",
        foreign_keys=[agent_id],
        viewonly=True,
        lazy="select",
    )


class AgentRoomPolicyOverride(Base):
    """Per-room attention override for an agent (sparse).

    NULL columns mean "inherit from agent default". ``muted_until`` is a
    transient snooze timestamp; the resolver treats past values as no-op.

    Admission policy is intentionally NOT scoped here — see design doc §3.2.
    """

    __tablename__ = "agent_room_policy_overrides"
    __table_args__ = (
        UniqueConstraint("agent_id", "room_id", name="uq_arpo_agent_room"),
        Index("ix_arpo_agent", "agent_id"),
    )

    # ``BigInteger`` for the Postgres BIGSERIAL; in SQLite tests this maps to
    # plain INTEGER which still supports rowid autoincrement. Mirroring the
    # dialect-neutral pattern used elsewhere in this module.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agents.agent_id", ondelete="CASCADE"),
        nullable=False,
    )
    room_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("rooms.room_id", ondelete="CASCADE"),
        nullable=False,
    )
    attention_mode: Mapped[AttentionMode | None] = mapped_column(
        Enum(AttentionMode, name="attentionmode", native_enum=False, length=32),
        nullable=True,
    )
    # JSON-encoded list[str]; NULL means inherit from the agent default.
    keywords: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON-encoded list[str] of room member participant IDs allowed to wake.
    # NULL/empty both mean "no allowed senders" for allowed_senders mode.
    allowed_sender_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    muted_until: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )


class RoomJoinRequest(Base):
    __tablename__ = "room_join_requests"
    __table_args__ = (
        UniqueConstraint(
            "room_id", "agent_id", "participant_type", "status",
            name="uq_room_join_request_pending",
        ),
        Index("ix_room_join_requests_room_status", "room_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    # Polymorphic requester id (ag_* or hu_*). Column name kept for
    # compatibility; ``participant_type`` is the discriminator. FK to agents
    # was dropped so Human requesters are legal.
    agent_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    participant_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
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
        Index("ix_message_records_sender_created_room", "sender_id", "created_at", "room_id"),
        Index("ix_message_records_receiver_created_room", "receiver_id", "created_at", "room_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hub_msg_id: Mapped[str] = mapped_column(String(48), unique=True, nullable=False, index=True)
    msg_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # ``sender_id`` is polymorphic (ag_* or hu_*). FK dropped so Human-originated
    # messages (source_type="human") can be recorded without a corresponding
    # agents row. The prefix is self-describing.
    sender_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
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
    # Polymorphic participant ids — ``owner_type`` / ``peer_type`` discriminate.
    owner_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    owner_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
    # Column retains its legacy name for unique-constraint compatibility; now
    # holds any participant id (ag_* or hu_*).
    contact_agent_id: Mapped[str] = mapped_column(String(32), nullable=False)
    peer_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
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
        String(32), nullable=False, index=True
    )
    owner_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
    blocked_agent_id: Mapped[str] = mapped_column(String(32), nullable=False)
    blocked_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
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
        String(32), nullable=False
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
    # Polymorphic — holds either ``ag_*`` or ``hu_*``. FK to agents was
    # dropped in migration 034 so Human creators don't violate it.
    creator_agent_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
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
    # Polymorphic — holds either ``ag_*`` or ``hu_*``. FK to agents was
    # dropped in migration 034.
    redeemer_agent_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
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
        String(32), nullable=False, index=True
    )
    from_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
    to_agent_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    to_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
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
        Index("ix_topics_creator_updated_status", "creator_id", "updated_at", "status"),
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
        UniqueConstraint("owner_id", "asset_code", name="uq_wallet_owner_asset"),
        CheckConstraint("available_balance_minor >= 0", name="ck_wallet_available_nonneg"),
        CheckConstraint("locked_balance_minor >= 0", name="ck_wallet_locked_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Owner may be an agent (`ag_*`) or a human user (`hu_*`). No FK — the
    # target table depends on prefix; validated in the service layer.
    owner_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
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
        # Idempotency: scoped to (type, initiator_owner_id, idempotency_key).
        # initiator_owner_id is from_owner_id for transfer/withdrawal, to_owner_id for topup.
        UniqueConstraint("type", "initiator_owner_id", "idempotency_key", name="uq_tx_idem"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tx_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    type: Mapped[TxType] = mapped_column(Enum(TxType), nullable=False)
    status: Mapped[TxStatus] = mapped_column(Enum(TxStatus), nullable=False, default=TxStatus.pending)
    asset_code: Mapped[str] = mapped_column(String(16), nullable=False, default="COIN")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    from_owner_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    to_owner_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    initiator_owner_id: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True,
        doc="The owner who initiated the tx: from_owner_id for transfer/withdrawal, to_owner_id for topup"
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
    owner_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
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
    owner_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
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
    owner_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
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
        UniqueConstraint("owner_id", "owner_type", "name", name="uq_subscription_product_owner_name"),
        Index("ix_subscription_products_owner", "owner_id", "owner_type"),
        Index("ix_subscription_products_provider", "provider_agent_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    # Polymorphic owner — `owner_type` is the discriminator. Can be ag_* or hu_*.
    owner_id: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_type: Mapped[ParticipantType] = mapped_column(
        Enum(ParticipantType, name="participanttype"),
        nullable=False,
        default=ParticipantType.agent,
        server_default=ParticipantType.agent.value,
    )
    # Wallet receiver for charges — always an agent. Equals owner_id for
    # agent-owned products; for human-owned products the human picks one of
    # their bound bots.
    provider_agent_id: Mapped[str] = mapped_column(
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
    room_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("rooms.room_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
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
    # Social-identity ID used as ``from``/``participant_id`` for Human-as-first-class
    # messages and memberships. Always ``hu_<12 hex>``. Generated on first login;
    # see ``hub.id_generators.generate_human_id``.
    human_id: Mapped[str] = mapped_column(
        String(32),
        unique=True,
        nullable=False,
        index=True,
        default=generate_human_id,
    )
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


# ---------------------------------------------------------------------------
# Daemon control plane
# ---------------------------------------------------------------------------


class DaemonInstance(Base):
    """A user's local daemon process registered with the Hub.

    One row per machine where the user has authorized `botcord-daemon`.
    `refresh_token_hash` stores SHA-256(hex) of the issued refresh token —
    plaintext is never persisted.
    """

    __tablename__ = "daemon_instances"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # dm_<12 hex>
    user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refresh_token_hash: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Device-removal lifecycle. When `removal_requested_at` is set but
    # `revoked_at` is null, the daemon is in "pending removal": bots have
    # been detached but local cleanup is still draining (the device may be
    # offline). Once cleanup completes we stamp `cleanup_completed_at` and
    # finalize via `revoked_at`.
    removal_requested_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    removal_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    cleanup_completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Latest runtime-discovery snapshot pushed by the daemon (or pulled via
    # list_runtimes). `runtimes_json` mirrors the protocol `runtimes` array;
    # `runtimes_probed_at` is the daemon-side probe wall-clock in UTC.
    runtimes_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    runtimes_probed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class DaemonAgentCleanup(Base):
    """Durable best-effort local cleanup for daemon-managed agents."""

    __tablename__ = "daemon_agent_cleanups"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'succeeded', 'failed', 'cancelled')",
            name="ck_daemon_agent_cleanups_status",
        ),
        Index("ix_daemon_agent_cleanups_daemon_status", "daemon_instance_id", "status"),
        Index("ix_daemon_agent_cleanups_agent_status", "agent_id", "status"),
    )

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    daemon_instance_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("daemon_instances.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id", ondelete="CASCADE"), nullable=False
    )
    delete_credentials: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
    delete_state: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
    delete_workspace: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa_text("FALSE")
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class DaemonDiagnosticBundle(Base):
    """Diagnostic zip uploaded by a user-authorized daemon."""

    __tablename__ = "daemon_diagnostic_bundles"
    __table_args__ = (
        Index("ix_daemon_diagnostic_bundles_daemon_created", "daemon_instance_id", "created_at"),
        Index("ix_daemon_diagnostic_bundles_user_created", "user_id", "created_at"),
    )

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    daemon_instance_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("daemon_instances.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DaemonInstallTicket(Base):
    """Short-lived one-time token for non-interactive daemon bootstrap."""

    __tablename__ = "daemon_install_tickets"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_daemon_install_tickets_token_hash"),
        Index("ix_daemon_install_tickets_user_expires", "user_id", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # ditk_<12 hex>
    user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    consumed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    daemon_instance_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class OpenclawHostInstance(Base):
    """An OpenClaw VM/container hosting the BotCord plugin.

    Mirrors :class:`DaemonInstance` semantics — long-lived control-plane
    row with refresh-token rotation. ``host_pubkey`` is the Ed25519 public
    key the plugin generated locally during install-claim; the matching
    private key never leaves the host.
    """

    __tablename__ = "openclaw_host_instances"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # oc_<12 hex>
    owner_user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    host_pubkey: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refresh_token_hash: Mapped[str | None] = mapped_column(
        String(128), nullable=True, index=True
    )
    refresh_token_expires_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_seen_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AgentSchedule(Base):
    """Owner/agent-managed schedule for proactive agent turns."""

    __tablename__ = "agent_schedules"
    __table_args__ = (
        UniqueConstraint("agent_id", "name", name="uq_agent_schedules_agent_name"),
        Index("ix_agent_schedules_due", "enabled", "next_fire_at"),
        Index("ix_agent_schedules_agent", "agent_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[_uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=sa_text("TRUE"))
    schedule_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by: Mapped[str] = mapped_column(String(16), nullable=False, default="owner", server_default="owner")
    next_fire_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    last_fire_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_until: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentScheduleRun(Base):
    """Audit trail for schedule dispatch attempts."""

    __tablename__ = "agent_schedule_runs"
    __table_args__ = (
        Index("ix_agent_schedule_runs_schedule", "schedule_id", "scheduled_for"),
        Index("ix_agent_schedule_runs_agent", "agent_id", "scheduled_for"),
        UniqueConstraint("dedupe_key", name="uq_agent_schedule_runs_dedupe_key"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    schedule_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agent_schedules.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id", ondelete="CASCADE"), nullable=False
    )
    scheduled_for: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="queued", server_default="queued")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DaemonDeviceCode(Base):
    """Transient device-code rows for the daemon login flow.

    The daemon polls `/daemon/auth/device-token` with `device_code`; the
    user enters `user_code` on the dashboard `/activate` page. Once the
    dashboard binds the row to a user (`approved`), the next daemon poll
    consumes the row by reading `issued_token_json`.
    """

    __tablename__ = "daemon_device_codes"
    __table_args__ = (
        UniqueConstraint("user_code", name="uq_daemon_device_codes_user_code"),
        Index("ix_daemon_device_codes_status", "status", "expires_at"),
    )

    device_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_code: Mapped[str] = mapped_column(String(16), nullable=False)
    user_id: Mapped[_uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    daemon_instance_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expires_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    approved_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    consumed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # pending | approved | consumed | denied
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    issued_token_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ---------------------------------------------------------------------------
# Human-as-first-class: approval queue for Human-owned Agents
# ---------------------------------------------------------------------------


class AgentApprovalQueue(Base):
    """External requests to a claimed Agent that need its owner Human to approve.

    When an external party sends a ``contact_request`` / ``room_invite`` / payment
    request to an Agent that has been claimed by a user, we queue a pending row
    here instead of auto-accepting. The owning Human resolves it from the
    dashboard (``approved`` / ``rejected``).

    Unclaimed Agents sidestep this queue and fall back to their existing
    auto-accept / policy logic — so older A2A flows are unaffected.
    """

    __tablename__ = "agent_approval_queue"
    __table_args__ = (
        Index("ix_agent_approval_agent_state", "agent_id", "state"),
        Index("ix_agent_approval_owner_state", "owner_user_id", "state"),
    )

    id: Mapped[_uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid.uuid4)
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False
    )
    owner_user_id: Mapped[_uuid.UUID] = mapped_column(
        Uuid, ForeignKey("public.users.id"), nullable=False
    )
    kind: Mapped[ApprovalKind] = mapped_column(
        Enum(ApprovalKind, name="approvalkind"), nullable=False
    )
    # Opaque structured payload describing the pending action
    # (e.g. for contact_request: ``{"from_participant_id": "ag_x", "message": "..."}``).
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    state: Mapped[ApprovalState] = mapped_column(
        Enum(ApprovalState, name="approvalstate"),
        nullable=False,
        default=ApprovalState.pending,
        server_default=ApprovalState.pending.value,
    )
    resolved_by_user_id: Mapped[_uuid.UUID | None] = mapped_column(
        Uuid, nullable=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    resolved_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# ---------------------------------------------------------------------------
# Agent Presence & Status V1
#   See docs/agent-presence-status-v1-supabase.md
# ---------------------------------------------------------------------------


class AgentStatusSettings(Base):
    """Owner-driven manual status (available/busy/away/invisible)."""

    __tablename__ = "agent_status_settings"
    __table_args__ = (
        CheckConstraint(
            "manual_status IN ('available', 'busy', 'away', 'invisible')",
            name="ck_agent_status_settings_manual_status",
        ),
    )

    agent_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agents.agent_id", ondelete="CASCADE"),
        primary_key=True,
    )
    manual_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="available", server_default="available"
    )
    status_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    manual_expires_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_by_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_by_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentPresence(Base):
    """Composed effective status + activity/attribute projection."""

    __tablename__ = "agent_presence"
    __table_args__ = (
        CheckConstraint(
            "effective_status IN ('offline', 'online', 'busy', 'away', 'working')",
            name="ck_agent_presence_effective_status",
        ),
        Index("ix_agent_presence_status_updated", "effective_status", "updated_at"),
        Index("ix_agent_presence_last_seen", "last_seen_at"),
    )

    agent_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agents.agent_id", ondelete="CASCADE"),
        primary_key=True,
    )
    effective_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="offline", server_default="offline"
    )
    connected: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa_text("FALSE")
    )
    connection_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    version: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    last_seen_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    activity_json: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        default=dict,
        server_default="{}",
    )
    attributes_json: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        default=dict,
        server_default="{}",
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AgentPresenceConnection(Base):
    """Per-WebSocket connection lease. Multi-Hub safe."""

    __tablename__ = "agent_presence_connections"
    __table_args__ = (
        Index(
            "ix_agent_presence_connections_agent_seen",
            "agent_id",
            "last_seen_at",
        ),
        Index(
            "ix_agent_presence_connections_node",
            "node_id",
            "last_seen_at",
        ),
    )

    connection_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    agent_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agents.agent_id", ondelete="CASCADE"),
        nullable=False,
    )
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    last_seen_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AgentGatewayConnection(Base):
    """Third-party gateway (Telegram / WeChat) connection metadata.

    Hub stores metadata only — provider, label, whitelists, baseUrl, splitAt,
    masked tokenPreview, status. Bot tokens NEVER live here; they are written
    to the daemon's local secret store (~/.botcord/daemon/gateways/{id}.json,
    mode 0600). See ``docs/third-party-gateway-design.md`` § Hub / Backend.
    """

    __tablename__ = "agent_gateway_connections"
    __table_args__ = (
        CheckConstraint(
            "provider IN ('telegram', 'wechat', 'feishu')",
            name="ck_agent_gateway_connections_provider",
        ),
        CheckConstraint(
            "status IN ('pending', 'active', 'disabled', 'error')",
            name="ck_agent_gateway_connections_status",
        ),
        Index("ix_agent_gateway_connections_user", "user_id"),
        Index("ix_agent_gateway_connections_agent", "agent_id"),
        Index("ix_agent_gateway_connections_daemon", "daemon_instance_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[_uuid.UUID] = mapped_column(Uuid, nullable=False)
    agent_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agents.agent_id", ondelete="CASCADE"),
        nullable=False,
    )
    daemon_instance_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("daemon_instances.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=sa_text("TRUE")
    )
    config_json: Mapped[dict] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=False,
        default=dict,
        server_default="{}",
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

import datetime

from pydantic import BaseModel


class DashboardAgentProfile(BaseModel):
    agent_id: str
    display_name: str
    bio: str | None = None
    message_policy: str
    created_at: datetime.datetime


class DashboardRoom(BaseModel):
    room_id: str
    name: str
    description: str
    rule: str | None = None
    owner_id: str
    visibility: str
    member_count: int
    my_role: str
    created_at: datetime.datetime | None = None
    last_message_preview: str | None = None
    last_message_at: datetime.datetime | None = None
    last_sender_name: str | None = None


class DashboardContactInfo(BaseModel):
    contact_agent_id: str
    alias: str | None = None
    display_name: str
    created_at: datetime.datetime


class DashboardOverviewResponse(BaseModel):
    agent: DashboardAgentProfile
    rooms: list[DashboardRoom]
    contacts: list[DashboardContactInfo]
    pending_requests: int


class DashboardMessage(BaseModel):
    hub_msg_id: str
    msg_id: str
    sender_id: str
    sender_name: str
    type: str
    text: str
    payload: dict
    room_id: str | None = None
    topic: str | None = None
    topic_id: str | None = None
    goal: str | None = None
    state: str
    state_counts: dict[str, int] | None = None
    created_at: datetime.datetime
    source_type: str = "agent"


class DashboardMessageResponse(BaseModel):
    messages: list[DashboardMessage]
    has_more: bool


class DashboardAgentSearchResponse(BaseModel):
    agents: list[DashboardAgentProfile]


class DashboardConversationListResponse(BaseModel):
    conversations: list[DashboardRoom]


# ---------------------------------------------------------------------------
# Share schemas
# ---------------------------------------------------------------------------


class CreateShareResponse(BaseModel):
    share_id: str
    share_url: str
    link_url: str
    entry_type: str
    target_type: str
    target_id: str
    continue_url: str
    created_at: datetime.datetime
    expires_at: datetime.datetime | None = None


class SharedMessage(BaseModel):
    hub_msg_id: str
    msg_id: str
    sender_id: str
    sender_name: str
    type: str
    text: str
    payload: dict
    created_at: datetime.datetime


class SharedRoomInfo(BaseModel):
    room_id: str
    name: str
    description: str
    member_count: int
    visibility: str | None = None
    join_mode: str | None = None
    requires_payment: bool = False


class SharedRoomResponse(BaseModel):
    share_id: str
    room: SharedRoomInfo
    messages: list[SharedMessage]
    shared_by: str
    shared_at: datetime.datetime
    entry_type: str
    continue_url: str
    link_url: str


# ---------------------------------------------------------------------------
# Discover & Join rooms schemas
# ---------------------------------------------------------------------------


class DiscoverRoom(BaseModel):
    room_id: str
    name: str
    description: str
    rule: str | None = None
    owner_id: str
    visibility: str
    member_count: int
    required_subscription_product_id: str | None = None


class DiscoverRoomsResponse(BaseModel):
    rooms: list[DiscoverRoom]
    total: int


class JoinRoomResponse(BaseModel):
    room_id: str
    name: str
    description: str
    rule: str | None = None
    owner_id: str
    visibility: str
    member_count: int
    my_role: str


# ---------------------------------------------------------------------------
# Public platform stats
# ---------------------------------------------------------------------------


class PlatformStatsResponse(BaseModel):
    total_agents: int
    total_rooms: int
    public_rooms: int
    total_messages: int

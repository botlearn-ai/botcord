/**
 * [INPUT]: 依赖 dashboard/public API 的 JSON 契约，约束前端 store 与组件之间的数据边界
 * [OUTPUT]: 对外提供 dashboard/public/wallet/subscription 相关 TypeScript 类型
 * [POS]: frontend 类型中枢，负责把 BFF 返回结构显式化，避免组件自行猜测响应形状
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export interface AgentProfile {
  agent_id: string;
  display_name: string;
  bio: string | null;
  avatar_url?: string | null;
  message_policy: string;
  created_at: string;
  owner_human_id?: string | null;
  owner_display_name?: string | null;
  online?: boolean;
}

export interface RoomMemberPreview {
  display_name: string;
  avatar_url?: string | null;
  agent_id?: string;
}

export interface DashboardRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  owner_type?: ParticipantType;
  visibility: string;
  join_policy?: string;
  can_invite?: boolean;
  member_count: number;
  my_role: string;
  created_at?: string | null;
  rule: string | null;
  required_subscription_product_id?: string | null;
  default_send?: boolean;
  default_invite?: boolean;
  max_members?: number | null;
  slow_mode_seconds?: number | null;
  last_viewed_at?: string | null;
  has_unread: boolean;
  unread_count?: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
  allow_human_send?: boolean;
  /** For group rooms: up to 4 member previews for composite avatar (optional, frontend-friendly). */
  members_preview?: RoomMemberPreview[];
  /** For DM rooms only: whether the peer is an agent or a human. */
  peer_type?: ParticipantType;
  /**
   * If set, this room belongs to an owned bot's conversation graph (not the
   * human owner's own). The owner sees it via the unified Messages list, but
   * cannot send — they observe the bot. Frontend-only field, populated at
   * merge time by `mergeOwnerVisibleRooms`.
   */
  _originAgent?: { agent_id: string; display_name: string };
}

export interface RoomResponse {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  join_policy?: string;
  can_invite?: boolean;
  member_count: number;
  my_role?: string;
  rule: string | null;
  required_subscription_product_id?: string | null;
  allow_human_send?: boolean;
  created_at?: string | null;
}

export interface UpdateRoomBody {
  name?: string;
  description?: string;
  rule?: string | null;
  visibility?: string;
  join_policy?: string;
  allow_human_send?: boolean;
}

export interface ContactInfo {
  contact_agent_id: string;
  alias: string | null;
  display_name: string;
  avatar_url?: string | null;
  peer_type?: "agent" | "human";
  created_at: string;
  online?: boolean;
}

export interface ContactRequestItem {
  id: number | string;
  from_agent_id: string;
  to_agent_id: string;
  state: "pending" | "accepted" | "rejected";
  message: string | null;
  created_at: string;
  resolved_at: string | null;
  from_display_name: string | null;
  to_display_name: string | null;
}

export interface ContactRequestListResponse {
  requests: ContactRequestItem[];
}

export interface DashboardViewer {
  type: "agent" | "human";
  id: string;
  display_name: string | null;
}

export interface DashboardOverview {
  /** Null when the viewer is a Human (no ``X-Active-Agent`` header supplied). */
  agent: AgentProfile | null;
  /** Identity used to scope this overview — always present. */
  viewer: DashboardViewer;
  rooms: DashboardRoom[];
  contacts: ContactInfo[];
  pending_requests: number;
}

export interface Attachment {
  filename: string;
  url: string;
  content_type?: string;
  size_bytes?: number;
}

export interface DashboardMessage {
  hub_msg_id: string;
  msg_id: string;
  sender_id: string;
  sender_name: string;
  type: string;
  text: string;
  payload: Record<string, unknown>;
  room_id: string | null;
  topic: string | null;
  topic_id: string | null;
  goal: string | null;
  topic_title?: string | null;
  topic_description?: string | null;
  topic_status?: string | null;
  topic_creator_id?: string | null;
  topic_goal?: string | null;
  topic_message_count?: number | null;
  topic_created_at?: string | null;
  topic_updated_at?: string | null;
  topic_closed_at?: string | null;
  state: string;
  state_counts: Record<string, number> | null;
  created_at: string;
  source_type?: string;
  sender_kind?: "agent" | "human";
  display_sender_name?: string;
  sender_avatar_url?: string | null;
  source_user_id?: string | null;
  source_user_name?: string | null;
  is_mine?: boolean;
}

export interface RoomHumanSendResponse {
  hub_msg_id: string;
  room_id: string;
  status: string;
  topic_id?: string | null;
}

// --- User Chat types ---

export interface UserChatRoom {
  room_id: string;
  name: string;
  agent_id: string;
}

export interface UserChatSendResponse {
  hub_msg_id: string;
  room_id: string;
  status: string;
}

export interface FileUploadResult {
  file_id: string;
  url: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  expires_at: string;
}

// --- Owner-chat WS streaming types ---

export interface StreamBlockEntry {
  trace_id: string;
  seq: number;
  block: {
    kind: string;
    /** Legacy shape (plugin-driven): structured payload. */
    payload?: Record<string, unknown>;
    /** Current shape (daemon gateway): raw runtime event object. */
    raw?: unknown;
  };
  created_at: string;
}

// --- Owner-chat unified message model ---

export type OwnerChatMessageStatus =
  | "optimistic"   // User message: created locally, send in flight
  | "failed"       // User message: send failed, retryable
  | "confirmed"    // User message: server echoed back (has hubMsgId)
  | "streaming"    // Agent message: actively receiving stream blocks
  | "delivered";   // Final state for both user and agent messages

export interface OwnerChatMessage {
  /** Client-generated UUID — stable React key, always present. */
  clientId: string;
  /** Server-assigned message ID. Null while optimistic. */
  hubMsgId: string | null;

  sender: "user" | "agent";
  text: string;
  attachments?: Attachment[];
  /** Embedded execution blocks (empty for user messages). */
  streamBlocks: StreamBlockEntry[];

  status: OwnerChatMessageStatus;
  error?: string;

  createdAt: string;
  senderName: string;
  type: "message" | "notification";

  /** Original text payload for retry (may differ from display text for file-only sends). */
  sendText?: string;
  /** Unsent files preserved for retry. */
  retryFiles?: File[];
  /** Links streaming placeholder to its final delivered message. */
  traceId?: string;
}

/** Convert a DashboardMessage (from API) into an OwnerChatMessage. */
export function dashboardMsgToOwnerChat(
  msg: DashboardMessage,
  agentName: string,
): OwnerChatMessage {
  const isUser = msg.source_type === "dashboard_user_chat";
  return {
    clientId: msg.hub_msg_id,
    hubMsgId: msg.hub_msg_id,
    sender: isUser ? "user" : "agent",
    text: msg.text || "",
    attachments: (msg.payload?.attachments as Attachment[] | undefined) ?? undefined,
    streamBlocks: [],
    status: "delivered",
    createdAt: msg.created_at,
    senderName: isUser ? "You" : (msg.sender_name || agentName),
    type: msg.type === "notification" ? "notification" : "message",
  };
}

export interface OwnerChatWsMessage {
  type: "message";
  hub_msg_id: string;
  sender: "user" | "agent";
  room_id: string;
  text: string;
  created_at: string;
  ext?: Record<string, unknown>;
}

export interface OwnerChatNotification {
  type: "notification";
  text: string;
  created_at: string;
}

export interface RoomMessagesViewerContext {
  access_mode: "member" | "public";
  agent_id: string | null;
  membership_role: string | null;
}

export interface DashboardMessageResponse {
  messages: DashboardMessage[];
  has_more: boolean;
  viewer_context: RoomMessagesViewerContext;
}

export interface TopicInfo {
  topic_id: string;
  room_id: string;
  title: string;
  description: string;
  status: string; // open | completed | failed | expired
  creator_id: string;
  goal: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface HumanProfile {
  human_id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string | null;
}

export interface AgentSearchResponse {
  agents: AgentProfile[];
  humans?: HumanProfile[];
}

export interface ConversationListResponse {
  conversations: DashboardRoom[];
}

export interface InboxMessage {
  hub_msg_id: string;
  envelope: {
    from: string;
    to: string;
    type: string;
    payload: Record<string, unknown>;
    msg_id: string;
    [key: string]: unknown;
  };
  room_id: string | null;
  topic: string | null;
  topic_id: string | null;
}

export interface InboxPollResponse {
  messages: InboxMessage[];
  count: number;
  has_more: boolean;
}

export type RealtimeMetaEventType =
  | "message"
  | "contact_request"
  | "contact_request_response"
  | "contact_removed"
  | "room_member_added"
  | "room_member_removed"
  | "ack"
  | "result"
  | "error"
  | "system"
  | "typing"
  | "agent_status_changed";

export interface RealtimeMetaEvent {
  type: RealtimeMetaEventType;
  agent_id: string;
  room_id: string | null;
  hub_msg_id: string | null;
  created_at: string;
  ext: Record<string, unknown>;
}

// --- Discover & Join types ---

export interface DiscoverRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  join_policy?: "open" | "invite_only";
  member_count: number;
  rule: string | null;
  required_subscription_product_id?: string | null;
}

export interface DiscoverRoomsResponse {
  rooms: DiscoverRoom[];
  total: number;
}

export interface JoinRoomResponse {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  member_count: number;
  my_role: string;
  rule: string | null;
  required_subscription_product_id?: string | null;
}

export interface LeaveRoomResponse {
  room_id: string;
  left: boolean;
}

// --- Join Request types ---

export interface JoinRequestItem {
  request_id: string;
  room_id: string;
  agent_id: string;
  agent_display_name: string | null;
  message: string | null;
  status: "pending" | "accepted" | "rejected";
  created_at: string | null;
}

export interface JoinRequestListResponse {
  requests: JoinRequestItem[];
}

export interface MyJoinRequestResponse {
  has_request: boolean;
  request: {
    request_id: string;
    status: "pending" | "accepted" | "rejected";
    created_at: string | null;
  } | null;
}

export interface CreateJoinRequestResponse {
  request_id: string;
  room_id: string;
  agent_id: string;
  status: string;
  message: string | null;
  created_at: string | null;
}

export interface BindTicketResponse {
  bind_code: string;
  bind_ticket: string;
  nonce: string;
  expires_at: number;
  install_command?: string;
  intended_name?: string | null;
}

export type BindTicketStatusValue = "pending" | "claimed" | "expired" | "revoked";

export interface BindTicketStatusResponse {
  bind_code: string;
  status: BindTicketStatusValue;
  agent_id: string | null;
  expires_at: string | null;
  expires_at_ts: number | null;
  claimed_at?: string | null;
}

export interface ResetTicketResponse {
  agent_id: string;
  reset_code: string;
  reset_ticket: string;
  expires_at: number;
}

// --- Share types ---

export interface CreateShareResponse {
  share_id: string;
  share_url: string;
  link_url: string;
  entry_type: "public_room" | "paid_room" | "private_room";
  required_subscription_product_id?: string | null;
  target_type: "room";
  target_id: string;
  continue_url: string;
  created_at: string;
  expires_at: string | null;
}

export interface SharedMessage {
  hub_msg_id: string;
  msg_id: string;
  sender_id: string;
  sender_name: string;
  type: string;
  text: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SharedRoomInfo {
  room_id: string;
  name: string;
  description: string;
  member_count: number;
  visibility?: string;
  join_mode?: "open" | "invite_only";
  requires_payment?: boolean;
  required_subscription_product_id?: string | null;
}

export interface PlatformStats {
  total_agents: number;
  total_rooms: number;
  public_rooms: number;
  total_messages: number;
}

export interface SharedRoomResponse {
  share_id: string;
  room: SharedRoomInfo;
  messages: SharedMessage[];
  shared_by: string;
  shared_at: string;
  entry_type: "public_room" | "paid_room" | "private_room";
  continue_url: string;
  link_url: string;
}

export interface InvitePreviewResponse {
  code: string;
  kind: "friend" | "room";
  entry_type: "friend_invite" | "public_room" | "paid_room" | "private_invite";
  target_type: "friend" | "room";
  target_id: string;
  invite_url: string;
  continue_url: string;
  expires_at: string | null;
  max_uses: number;
  use_count: number;
  creator: {
    agent_id: string;
    display_name: string;
  };
  room: {
    room_id: string;
    name: string;
    description: string;
    visibility: string;
    join_mode: "open" | "invite_only" | "request";
    requires_payment: boolean;
    required_subscription_product_id?: string | null;
    member_count: number;
  } | null;
}

export interface RedeemInviteResponse {
  status: "redeemed" | "already_joined" | "already_connected";
  kind: "friend" | "room";
  target_type: "friend" | "room";
  target_id: string;
  continue_url: string;
}

// --- Public (guest) types ---

export interface PublicRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  join_policy?: string;
  member_count: number;
  rule?: string | null;
  required_subscription_product_id?: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
}

export interface PublicRoomMessagePreview {
  hub_msg_id: string;
  sender_id: string;
  sender_name: string | null;
  preview: string;
  created_at: string | null;
}

export interface PublicRoomMessagePreviewResponse {
  messages: PublicRoomMessagePreview[];
}

export interface PublicRoomsResponse {
  rooms: PublicRoom[];
  total: number;
}

export interface PublicAgentsResponse {
  agents: AgentProfile[];
  total: number;
}

export interface PublicHumanProfile {
  human_id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string | null;
  contact_status?: "contact" | "pending" | "none";
}

export interface PublicHumansResponse {
  humans: PublicHumanProfile[];
  total: number;
}

export interface PublicOverview {
  stats: PlatformStats;
  featured_rooms: PublicRoom[];
  recent_agents: AgentProfile[];
}

export interface PublicRoomMember {
  agent_id: string;
  /** "agent" (ag_*) or "human" (hu_*). Authenticated /members endpoint
   * always sets this; the public variant (unauth) may omit it for agents. */
  participant_type?: ParticipantType;
  display_name: string;
  bio: string | null;
  message_policy: string | null;
  created_at: string | null;
  role: string;
  joined_at: string;
  online?: boolean;
  /** Mute flag — only meaningful for the authenticated viewer's own row. */
  muted?: boolean;
  /** Per-member permission override. ``null`` = use room default. */
  can_send?: boolean | null;
  /** Per-member permission override. ``null`` = use room default. */
  can_invite?: boolean | null;
}

export interface PublicRoomMembersResponse {
  room_id: string;
  members: PublicRoomMember[];
  total: number;
}

export interface SubscriptionProduct {
  product_id: string;
  owner_id: string;
  owner_type: ParticipantType;
  provider_agent_id: string;
  name: string;
  description: string;
  asset_code: string;
  amount_minor: number;
  billing_interval: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  active_subscriber_count?: number;
}

export interface SubscriptionProductResponse {
  product: SubscriptionProduct;
}

export interface SubscriptionProductListResponse {
  products: SubscriptionProduct[];
}

export interface AgentSubscription {
  subscription_id: string;
  product_id: string;
  subscriber_agent_id: string;
  provider_agent_id: string;
  asset_code: string;
  amount_minor: number;
  billing_interval: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  next_charge_at: string;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  last_charged_at: string | null;
  last_charge_tx_id: string | null;
  consecutive_failed_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface MySubscriptionsResponse {
  subscriptions: AgentSubscription[];
}

export interface ProductSubscribersResponse {
  subscribers: AgentSubscription[];
}

export interface MigrateRoomPlanResponse {
  product_id: string;
  room: {
    room_id: string;
    name: string;
    description: string;
    rule: string | null;
    required_subscription_product_id: string | null;
  };
  affected_count: number;
}

// --- Wallet types ---

export interface WalletSummary {
  agent_id: string;
  asset_code: string;
  available_balance_minor: string;
  locked_balance_minor: string;
  total_balance_minor: string;
  updated_at: string;
}

export interface WalletTransaction {
  tx_id: string;
  type: 'topup' | 'withdrawal' | 'transfer';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  amount_minor: string;
  fee_minor: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  memo?: string;
  created_at: string;
  completed_at: string | null;
}

export interface WalletLedgerEntry {
  entry_id: string;
  tx_id: string;
  direction: 'debit' | 'credit';
  tx_type?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  amount_minor: string;
  balance_after_minor: string;
  created_at: string;
}

export interface WalletLedgerResponse {
  entries: WalletLedgerEntry[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface TopupResponse {
  topup_id: string;
  tx_id: string | null;
  agent_id: string;
  asset_code: string;
  amount_minor: string;
  status: string;
  channel: string;
  created_at: string;
  completed_at: string | null;
}

export interface WithdrawalResponse {
  withdrawal_id: string;
  tx_id: string | null;
  agent_id: string;
  asset_code: string;
  amount_minor: string;
  fee_minor: string;
  status: string;
  destination_type: string | null;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
  completed_at: string | null;
}

export interface WithdrawalListResponse {
  withdrawals: WithdrawalResponse[];
}

export interface CreateTransferRequest {
  to_agent_id: string;
  amount_minor: string;
  memo?: string;
  idempotency_key: string;
}

export interface CreateTopupRequest {
  amount_minor: string;
  channel: string;
}

export interface StripeCheckoutRequest {
  package_code: string;
  idempotency_key: string;
  quantity: number;
}

export interface StripeCheckoutResponse {
  topup_id: string;
  tx_id: string | null;
  checkout_session_id: string;
  checkout_url: string;
  expires_at: number | null;
  status: string;
}

export interface StripePackageItem {
  package_code: string;
  coin_amount_minor: string;
  fiat_amount: string;
  currency: string;
}

export interface StripePackageResponse {
  packages: StripePackageItem[];
}

export interface StripeSessionStatusResponse {
  topup_id: string;
  tx_id: string | null;
  checkout_session_id: string;
  topup_status: string;
  payment_status: string;
  wallet_credited: boolean;
  amount_minor: string;
  asset_code: string;
}

export interface CreateWithdrawalRequest {
  amount_minor: number;
  fee_minor?: number;
  destination_type?: string;
  destination?: Record<string, string>;
  idempotency_key?: string;
}

// --- User & Agent binding types ---

export interface UserProfile {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  status: string;
  max_agents: number;
  beta_access: boolean;
  beta_admin: boolean;
  roles: string[];
  agents: UserAgent[];
}

export interface UserAgent {
  agent_id: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  is_default: boolean;
  claimed_at: string;
  ws_online: boolean;
  daemon_instance_id?: string | null;
}

// --- Activity / Observability types ---

export interface ActivityStats {
  messages_sent: number;
  messages_received: number;
  topics_open: number;
  topics_completed: number;
  active_rooms: number;
}

export type ActivityEventType =
  | "message_sent"
  | "message_received"
  | "message_failed"
  | "topic_created"
  | "topic_completed"
  | "topic_failed"
  | "topic_expired";

export interface ActivityFeedItem {
  type: ActivityEventType;
  timestamp: string | null;
  agent_id: string | null;
  agent_name: string | null;
  room_id: string | null;
  room_name: string | null;
  preview: string | null;
  count: number;
  meta: Record<string, any> | null;
}

export interface ActivityFeedResponse {
  items: ActivityFeedItem[];
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Human-as-first-class (/api/humans/me surface)
// ---------------------------------------------------------------------------

export type ParticipantType = "agent" | "human";

export interface HumanInfo {
  human_id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
}

export interface HumanRoomSummary {
  room_id: string;
  name: string;
  description: string;
  rule: string | null;
  owner_id: string;
  owner_type: ParticipantType;
  visibility: string;
  join_policy: string;
  member_count: number;
  members_preview?: RoomMemberPreview[] | null;
  my_role: string;
  allow_human_send: boolean;
  default_send: boolean;
  default_invite: boolean;
  max_members: number | null;
  slow_mode_seconds: number | null;
  required_subscription_product_id: string | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  last_sender_name?: string | null;
  created_at: string | null;
}

export interface HumanRoomListResponse {
  rooms: HumanRoomSummary[];
}

export interface HumanAgentRoomBot {
  agent_id: string;
  display_name: string;
  role: string;
}

export interface HumanAgentRoomSummary {
  room_id: string;
  name: string;
  description: string | null;
  rule: string | null;
  owner_id: string;
  visibility: string;
  join_policy?: string | null;
  member_count: number;
  created_at?: string | null;
  required_subscription_product_id?: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
  allow_human_send?: boolean | null;
  bots: HumanAgentRoomBot[];
}

export interface HumanAgentRoomListResponse {
  rooms: HumanAgentRoomSummary[];
}

export interface HumanContactSummary {
  peer_id: string;
  peer_type: ParticipantType;
  alias: string | null;
  created_at: number;
}

export interface HumanContactListResponse {
  contacts: HumanContactSummary[];
}

export type ContactRequestOutcome =
  | "requested"
  | "queued_for_approval"
  | "already_contact"
  | "already_requested";

export interface HumanContactRequestResponse {
  status: ContactRequestOutcome;
  approval_id?: string | null;
  request_id?: string | null;
}

export type ApprovalKind = "contact_request" | "room_invite" | "payment";

export interface PendingApproval {
  id: string;
  agent_id: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface PendingApprovalListResponse {
  approvals: PendingApproval[];
}

export interface ResolveApprovalResponse {
  id: string;
  state: "approved" | "rejected";
}

// ---------------------------------------------------------------------------
// Human-surface room membership & contact-request summaries (new endpoints:
// POST /api/humans/me/rooms/{room_id}/members,
// GET /api/humans/me/contact-requests/{received,sent},
// POST /api/humans/me/contact-requests/{id}/{accept,reject})
// ---------------------------------------------------------------------------

export interface HumanRoomMemberResponse {
  room_id: string;
  participant_id: string;
  participant_type: ParticipantType;
  role: "owner" | "admin" | "member";
  joined_at: number;
}

// ---------------------------------------------------------------------------
// Phase 4 Human moderator endpoints
// (POST /api/humans/me/rooms/{id}/transfer | /promote | /mute | /permissions,
//  DELETE /api/humans/me/rooms/{id}/members/{participant_id})
// ---------------------------------------------------------------------------

export interface HumanRoomTransferResponse {
  room_id: string;
  new_owner_id: string;
  new_owner_type: ParticipantType;
}

export interface HumanRoomRoleChangeResponse {
  room_id: string;
  participant_id: string;
  participant_type: ParticipantType;
  role: "owner" | "admin" | "member";
}

export interface HumanRoomRemoveMemberResponse {
  room_id: string;
  participant_id: string;
  removed: boolean;
}

export interface HumanRoomMuteResponse {
  room_id: string;
  muted: boolean;
}

export interface HumanRoomPermissionsResponse {
  room_id: string;
  participant_id: string;
  participant_type: ParticipantType;
  can_send: boolean | null;
  can_invite: boolean | null;
}

export interface HumanContactRequestSummary {
  id: string;
  from_participant_id: string;
  from_type: ParticipantType;
  from_display_name: string | null;
  to_participant_id: string;
  to_type: ParticipantType;
  to_display_name: string | null;
  state: "pending" | "accepted" | "rejected";
  message: string | null;
  created_at: number;
}

export interface HumanContactRequestListResponse {
  requests: HumanContactRequestSummary[];
}

export interface HumanContactRequestResolveResponse {
  id: string;
  state: "accepted" | "rejected";
}

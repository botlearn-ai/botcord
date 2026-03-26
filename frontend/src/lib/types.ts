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
  message_policy: string;
  created_at: string;
}

export interface DashboardRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  join_policy?: string;
  can_invite?: boolean;
  member_count: number;
  my_role: string;
  rule: string | null;
  required_subscription_product_id?: string | null;
  last_viewed_at?: string | null;
  has_unread: boolean;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
}

export interface ContactInfo {
  contact_agent_id: string;
  alias: string | null;
  display_name: string;
  created_at: string;
}

export interface ContactRequestItem {
  id: number;
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

export interface DashboardOverview {
  agent: AgentProfile;
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

export interface AgentSearchResponse {
  agents: AgentProfile[];
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
  | "ack"
  | "result"
  | "error"
  | "typing";

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
}

// --- Share types ---

export interface CreateShareResponse {
  share_id: string;
  share_url: string;
  link_url: string;
  entry_type: "public_room" | "paid_room" | "private_room";
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

export interface PublicRoomsResponse {
  rooms: PublicRoom[];
  total: number;
}

export interface PublicAgentsResponse {
  agents: AgentProfile[];
  total: number;
}

export interface PublicOverview {
  stats: PlatformStats;
  featured_rooms: PublicRoom[];
  recent_agents: AgentProfile[];
}

export interface PublicRoomMember {
  agent_id: string;
  display_name: string;
  bio: string | null;
  message_policy: string;
  created_at: string;
  role: string;
  joined_at: string;
}

export interface PublicRoomMembersResponse {
  room_id: string;
  members: PublicRoomMember[];
  total: number;
}

export interface SubscriptionProduct {
  product_id: string;
  owner_agent_id: string;
  name: string;
  description: string;
  asset_code: string;
  amount_minor: number;
  billing_interval: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SubscriptionProductResponse {
  product: SubscriptionProduct;
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
  is_default: boolean;
  claimed_at: string;
}

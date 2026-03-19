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
  member_count: number;
  my_role: string;
  rule: string | null;
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
  state: string;
  state_counts: Record<string, number> | null;
  created_at: string;
}

export interface DashboardMessageResponse {
  messages: DashboardMessage[];
  has_more: boolean;
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

export interface TopicListResponse {
  topics: TopicInfo[];
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

// --- Discover & Join types ---

export interface DiscoverRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  member_count: number;
  rule: string | null;
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
}

// --- Share types ---

export interface CreateShareResponse {
  share_id: string;
  share_url: string;
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
}

// --- Public (guest) types ---

export interface PublicRoom {
  room_id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  member_count: number;
  rule?: string | null;
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
  role: string;
  joined_at: string;
}

export interface PublicRoomMembersResponse {
  room_id: string;
  members: PublicRoomMember[];
  total: number;
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
  amount_minor: string;
  destination_type?: string;
  destination?: Record<string, string>;
  idempotency_key?: string;
}

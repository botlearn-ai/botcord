// BotCord protocol types (mirrors hub/schemas.py)

export type BotCordSignature = {
  alg: "ed25519";
  key_id: string;
  value: string; // base64
};

export type MessageType =
  | "message"
  | "ack"
  | "result"
  | "error"
  | "contact_request"
  | "contact_request_response"
  | "contact_removed"
  | "system";

export type BotCordMessageEnvelope = {
  v: string;
  msg_id: string;
  ts: number;
  from: string;
  to: string;
  type: MessageType;
  reply_to: string | null;
  ttl_sec: number;
  topic?: string | null;
  goal?: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  sig: BotCordSignature;
  mentions?: string[] | null;
};

// Account config in openclaw.json channels.botcord
export type BotCordAccountConfig = {
  enabled?: boolean;
  credentialsFile?: string;
  hubUrl?: string;
  agentId?: string;
  keyId?: string;
  privateKey?: string;
  publicKey?: string;
  deliveryMode?: "polling" | "websocket";
  pollIntervalMs?: number;
  allowFrom?: string[];
  notifySession?: string;
  accounts?: Record<string, BotCordAccountConfig>;
};

export type BotCordChannelConfig = BotCordAccountConfig;

// Inbox poll response
export type InboxMessage = {
  hub_msg_id: string;
  envelope: BotCordMessageEnvelope;
  text?: string;
  room_id?: string;
  room_name?: string;
  room_rule?: string | null;
  room_member_count?: number;
  room_member_names?: string[];
  my_role?: string;
  my_can_send?: boolean;
  topic?: string;
  topic_id?: string;
  goal?: string;
  mentioned?: boolean;
};

export type InboxPollResponse = {
  messages: InboxMessage[];
  count: number;
  has_more: boolean;
};

// Hub API response types
export type SendResponse = {
  queued: boolean;
  hub_msg_id: string;
  status: string;
  topic_id?: string;
};

export type RoomInfo = {
  room_id: string;
  name: string;
  description?: string;
  rule?: string | null;
  visibility: "private" | "public";
  join_policy: "invite_only" | "open";
  default_send: boolean;
  member_count: number;
  created_at: string;
};

export type AgentInfo = {
  agent_id: string;
  display_name?: string;
  bio?: string;
  message_policy: string;
  endpoints: Array<{ url: string; state: string }>;
};

export type ContactInfo = {
  contact_agent_id: string;
  display_name?: string;
  created_at: string;
};

export type ContactRequestInfo = {
  request_id: string;
  from_agent_id: string;
  to_agent_id: string;
  state: "pending" | "accepted" | "rejected";
  created_at: string;
};

// File upload response (mirrors hub/schemas.py FileUploadResponse)
export type FileUploadResponse = {
  file_id: string;
  url: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  expires_at: string; // ISO 8601
};

// Attachment metadata included in message payloads
export type MessageAttachment = {
  filename: string;
  url: string;
  content_type?: string;
  size_bytes?: number;
};

// Wallet types (mirrors hub wallet schemas)

export type WalletSummary = {
  agent_id: string;
  asset_code: string;
  available_balance_minor: string;
  locked_balance_minor: string;
  total_balance_minor: string;
  updated_at: string;
};

export type WalletTransaction = {
  tx_id: string;
  type: "topup" | "withdrawal" | "transfer";
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  asset_code: string;
  amount_minor: string;
  fee_minor: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
};

export type WalletLedgerEntry = {
  entry_id: string;
  tx_id: string;
  agent_id: string;
  asset_code: string;
  direction: "debit" | "credit";
  amount_minor: string;
  balance_after_minor: string;
  created_at: string;
};

export type WalletLedgerResponse = {
  entries: WalletLedgerEntry[];
  next_cursor: string | null;
  has_more: boolean;
};

export type TopupResponse = {
  topup_id: string;
  tx_id: string | null;
  agent_id: string;
  asset_code: string;
  amount_minor: string;
  status: string;
  channel: string;
  created_at: string;
  completed_at: string | null;
};

export type WithdrawalResponse = {
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
};

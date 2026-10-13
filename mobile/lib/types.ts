// Subset of frontend/src/lib/types.ts that the mobile client reads.

export interface HumanInfo {
  human_id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
}

export interface DashboardRoom {
  room_id: string;
  name: string;
  member_count: number;
  has_unread: boolean;
  unread_count?: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
  allow_human_send?: boolean;
  peer_type?: "agent" | "human";
}

export interface DashboardOverview {
  viewer: { type: "agent" | "human"; id: string; display_name: string | null };
  rooms: DashboardRoom[];
}

export interface DashboardMessage {
  hub_msg_id: string;
  msg_id: string;
  sender_id: string;
  sender_name: string;
  display_sender_name?: string;
  sender_kind?: "agent" | "human";
  text: string;
  created_at: string;
  payload?: { attachments?: Attachment[] } & Record<string, unknown>;
  is_mine?: boolean;
  is_recalled?: boolean;
}

export interface Attachment {
  filename: string;
  url: string;
  content_type?: string;
  size_bytes?: number;
}

export interface FileUploadResult {
  file_id: string;
  url: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
}

export interface UserAgent {
  agent_id: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  is_default: boolean;
  ws_online: boolean;
  runtime?: string | null;
}

export interface OwnerChatRoom {
  room_id: string;
  name: string;
  agent_id: string;
}

export interface RoomMessagesResponse {
  messages: DashboardMessage[];
  has_more: boolean;
}

export interface RoomSendResponse {
  hub_msg_id: string;
  msg_id: string;
  room_id: string;
  status: string;
}

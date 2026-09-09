/** Organization communication always uses user auth and explicit space paths. */
import { ApiError, apiFetch } from "./api";

export interface TeamParticipant {
  user_id: string;
  membership_id: string;
  display_name: string;
}
export interface TeamConversation {
  id: string;
  space_id: string;
  kind: "room" | "dm";
  visibility: "organization" | "private";
  name: string;
  updated_at: string;
  last_sequence: number;
  unread_count: number;
  last_message: string | null;
  participants: TeamParticipant[];
  can_send: boolean;
}
export interface TeamMessage {
  sequence: number;
  conversation_id: string;
  client_id: string;
  author_user_id: string;
  author_name: string;
  content: string;
  created_at: string;
}
export interface TeamMessagePage {
  messages: TeamMessage[];
  has_more: boolean;
  last_sequence: number;
}
export interface NewTeamConversation {
  kind: "room" | "dm";
  name?: string;
  visibility: "organization" | "private";
  member_ids?: string[];
}
const path = (spaceId: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/conversations`;
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, { ...init, cache: "no-store" }, null);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof body.detail === "string" ? body.detail : "team_request_failed"
    );
  }
  return response.json();
}
export const teamConversationsApi = {
  list: (spaceId: string, signal?: AbortSignal) =>
    request<{ conversations: TeamConversation[] }>(path(spaceId), { signal }),
  create: (spaceId: string, body: NewTeamConversation) =>
    request<TeamConversation>(path(spaceId), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  messages: (
    spaceId: string,
    conversationId: string,
    cursor: { before?: number; after?: number } = {},
    signal?: AbortSignal
  ) => {
    const query = new URLSearchParams();
    if (cursor.before !== undefined) query.set("before", String(cursor.before));
    if (cursor.after !== undefined) query.set("after", String(cursor.after));
    return request<TeamMessagePage>(
      `${path(spaceId)}/${encodeURIComponent(
        conversationId
      )}/messages?${query}`,
      { signal }
    );
  },
  send: (
    spaceId: string,
    conversationId: string,
    content: string,
    clientId: string
  ) =>
    request<TeamMessage>(
      `${path(spaceId)}/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content, client_id: clientId }),
      }
    ),
  read: (spaceId: string, conversationId: string, sequence: number) =>
    request<{ sequence: number }>(
      `${path(spaceId)}/${encodeURIComponent(conversationId)}/read`,
      {
        method: "PUT",
        body: JSON.stringify({ sequence }),
      }
    ),
};
export function conversationName(
  conversation: TeamConversation,
  userId: string,
  fallback: string
) {
  return conversation.kind === "room"
    ? conversation.name
    : conversation.participants.find((p) => p.user_id !== userId)
        ?.display_name ?? fallback;
}

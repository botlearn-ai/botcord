/**
 * Organization (Team) rooms: real Hub Rooms scoped to a space. Listing,
 * creation and who may be in a room go through `/api/spaces/{id}/…` with
 * user auth; messages reuse the regular dashboard room endpoints.
 */
import { ApiError, apiFetch } from "./api";
import type { DashboardRoom, RoomMemberPreview } from "./types";
import { canManage, type SpaceAgent, type TeamSpace } from "./team-spaces";

export interface OrgParticipant {
  id: string;
  kind: "human" | "agent";
  display_name: string;
  role: string;
}
export interface OrgRoom {
  room_id: string;
  name: string;
  description?: string | null;
  rule?: string | null;
  owner_id?: string;
  owner_type?: "agent" | "human";
  visibility?: string;
  join_policy?: string;
  member_count: number;
  my_role?: string;
  allow_human_send?: boolean;
  default_send?: boolean;
  default_invite?: boolean;
  max_members?: number | null;
  slow_mode_seconds?: number | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_sender_name: string | null;
  unread_count?: number;
  has_unread?: boolean;
  members_preview?: RoomMemberPreview[] | null;
  created_at?: string | null;
  space_id: string;
  space_kind: "room" | "dm";
  space_visibility: "organization" | "private";
  joined: boolean;
  participants: OrgParticipant[];
  dm_peer_name?: string | null;
}
export interface NewOrgRoom {
  name: string;
  visibility: "organization" | "private";
  member_ids?: string[];
  agent_ids?: string[];
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, { ...init, cache: "no-store" }, null);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof body.detail === "string" ? body.detail : "org_room_request_failed"
    );
  }
  return response.json() as Promise<T>;
}
const part = encodeURIComponent;
const base = (spaceId: string) => `/api/spaces/${part(spaceId)}`;
const room = (spaceId: string, roomId: string) =>
  `${base(spaceId)}/rooms/${part(roomId)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body ? { body: JSON.stringify(body) } : {}),
});

export const orgRoomsApi = {
  list: (spaceId: string, signal?: AbortSignal) =>
    request<{ viewer_id: string; rooms: OrgRoom[] }>(`${base(spaceId)}/rooms`, {
      signal,
    }),
  create: (spaceId: string, body: NewOrgRoom) =>
    request<{ room_id: string; space_kind: "room"; space_visibility: string }>(
      `${base(spaceId)}/rooms`,
      post(body)
    ),
  openDm: (spaceId: string, memberId: string) =>
    request<{ room_id: string; space_kind: "dm" }>(
      `${base(spaceId)}/dms`,
      post({ member_id: memberId })
    ),
  /** Organization DM with an Agent you own or were granted access to. */
  openAgentDm: (spaceId: string, agentId: string) =>
    request<{ room_id: string; space_kind: "dm" }>(
      `${base(spaceId)}/agent-dms`,
      post({ agent_id: agentId })
    ),
  join: (spaceId: string, roomId: string) =>
    request<{ room_id: string; joined: true }>(
      `${room(spaceId, roomId)}/join`,
      post()
    ),
  participants: (spaceId: string, roomId: string, signal?: AbortSignal) =>
    request<{ participants: OrgParticipant[] }>(
      `${room(spaceId, roomId)}/participants`,
      { signal }
    ),
  addMembers: (spaceId: string, roomId: string, memberIds: string[]) =>
    request<{ added: string[] }>(
      `${room(spaceId, roomId)}/members`,
      post({ member_ids: memberIds })
    ),
  addAgent: (spaceId: string, roomId: string, agentId: string) =>
    request<{ room_id: string; agent_id: string }>(
      `${room(spaceId, roomId)}/agents`,
      post({ agent_id: agentId })
    ),
  removeParticipant: (spaceId: string, roomId: string, participantId: string) =>
    request<{ removed: string }>(
      `${room(spaceId, roomId)}/participants/${part(participantId)}`,
      { method: "DELETE" }
    ),
};

/** Body for POST /rooms: private rooms carry selected members; agents always. */
export function newRoomBody(
  name: string,
  visibility: "organization" | "private",
  memberIds: string[],
  agentIds: string[]
): NewOrgRoom {
  return {
    name: name.trim(),
    visibility,
    member_ids: visibility === "private" ? memberIds : [],
    agent_ids: agentIds,
  };
}

/** List title: DMs show the other member, rooms their name. */
export function orgRoomTitle(r: OrgRoom, fallback: string): string {
  if (r.space_kind === "dm") return r.dm_peer_name || fallback;
  return r.name;
}

/** Rooms view shows only rooms; the messages view shows rooms and DMs. */
export function orgRoomsForView(rooms: OrgRoom[], view: "messages" | "rooms"): OrgRoom[] {
  return view === "rooms" ? rooms.filter((r) => r.space_kind === "room") : rooms;
}

export function orgRoomUnread(r: OrgRoom): number {
  if (!r.joined) return 0;
  return r.unread_count ?? (r.has_unread ? 1 : 0);
}

/**
 * Preview metadata for `previewSender`. The list only carries the sender's
 * display name, so "mine" compares it with the viewer's own names.
 */
export function orgRoomPreviewMeta(r: OrgRoom, viewerNames: (string | null | undefined)[]) {
  const name = r.last_sender_name ?? null;
  return {
    last_message_author_name: name,
    last_message_mine: Boolean(name) && viewerNames.some((n) => n && n === name),
  };
}

/** Summary for the shared room components (RoomHeader / MessageList / composer). */
export function orgRoomToDashboardRoom(r: OrgRoom): DashboardRoom {
  return {
    room_id: r.room_id,
    name: r.name,
    description: r.description ?? "",
    owner_id: r.owner_id ?? "",
    owner_type: r.owner_type,
    visibility: r.visibility ?? "private",
    join_policy: r.join_policy,
    member_count: r.member_count,
    my_role: r.my_role ?? "member",
    rule: r.rule ?? null,
    default_send: r.default_send,
    default_invite: r.default_invite,
    max_members: r.max_members,
    slow_mode_seconds: r.slow_mode_seconds,
    created_at: r.created_at ?? null,
    has_unread: Boolean(r.has_unread),
    unread_count: r.unread_count,
    last_message_preview: r.last_message_preview,
    last_message_at: r.last_message_at,
    last_sender_name: r.last_sender_name,
    allow_human_send: r.allow_human_send,
    members_preview: r.members_preview ?? undefined,
    space_id: r.space_id,
    space_kind: r.space_kind,
    space_visibility: r.space_visibility,
  };
}

/**
 * Whether the viewer may add this organization Agent to a room: its owner
 * (sponsor membership) or an organization manager. Null means allowed,
 * otherwise the reason code shown instead of hiding the Agent.
 */
export function agentAddBlocker(
  space: TeamSpace,
  agent: SpaceAgent,
  ownedAgentIds: string[]
): "agent_owner_or_manager_required" | null {
  if (canManage(space)) return null;
  if (agent.sponsor_user_membership_id === space.membership.id) return null;
  if (ownedAgentIds.includes(agent.agent_id)) return null;
  return "agent_owner_or_manager_required";
}

/**
 * Removal follows the Hub: never the room owner; room owner/admin and org
 * managers may remove anyone, an Agent's owner may remove that Agent.
 */
export function canRemoveParticipant(
  participant: OrgParticipant,
  opts: {
    space: TeamSpace;
    viewerId: string;
    myRole: string | null | undefined;
    ownedAgentIds: string[];
    isDm: boolean;
  }
): boolean {
  if (opts.isDm || participant.role === "owner" || participant.id === opts.viewerId) return false;
  if (opts.myRole === "owner" || opts.myRole === "admin" || canManage(opts.space)) return true;
  return participant.kind === "agent" && opts.ownedAgentIds.includes(participant.id);
}

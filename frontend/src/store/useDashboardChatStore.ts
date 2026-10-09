/**
 * [INPUT]: 依赖 zustand/persist 保存 dashboard 会话与目录数据，依赖 @/lib/api 发起房间/目录/Agent 查询，依赖 session/ui/unread/contact store 提供鉴权、界面上下文与未读协调
 * [OUTPUT]: 对外提供 useDashboardChatStore，管理 overview、按稳定 msg_id 合并的消息缓存与共享首屏请求 Promise、带查询归属和并发去重的公开目录远端搜索结果、按身份隔离缓存和并发去重的 Agent 卡片数据与 chat 相关异步动作
 * [POS]: frontend dashboard 的 chat 数据状态源，负责真正的会话数据与目录数据，不负责阅读语义和连接生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AgentProfile,
  DashboardMessage,
  DashboardOverview,
  DashboardRoom,
  DiscoverRoom,
  HumanAgentRoomSummary,
  PublicRoomMember,
  PublicHumanProfile,
  PublicRoom,
  RealtimeMetaEvent,
  MessageStatusReaction,
  UserAgent,
} from "@/lib/types";
import { api, humansApi } from "@/lib/api";
import { createProfileCache } from "@/lib/profile-cache";
import {
  buildVisibleMessageRooms,
  compareRoomsByActivityDesc,
  roomMessagesInFlight,
  roomMessagesReloadPending,
  roomPollInFlight,
  toRoomSummary,
} from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { ownedAgentRoomToDashboardRoom } from "@/lib/messages-merge";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";

export function dashboardProfileScope(): string {
  const { token, user, human, activeIdentity } = useDashboardSessionStore.getState();
  return JSON.stringify([Boolean(token), user?.id ?? null, human?.human_id ?? null, activeIdentity?.type ?? null, activeIdentity?.id ?? null]);
}

const agentProfiles = createProfileCache((agentId: string) => api.getAgentCard(agentId));
let agentSelectionSequence = 0;
function invalidateAgentProfiles() {
  agentSelectionSequence += 1;
  agentProfiles.clear();
}

let publicRoomsRequestSeq = 0;
let publicAgentsRequestSeq = 0;
let publicHumansRequestSeq = 0;
type PublicDirectoryRequest = { query: string; scope: string; promise: Promise<void> };
let publicRoomsInFlight: PublicDirectoryRequest | null = null;
let publicAgentsInFlight: PublicDirectoryRequest | null = null;
let publicHumansInFlight: PublicDirectoryRequest | null = null;

function publicDirectoryScope(): string {
  const { activeIdentity, token } = useDashboardSessionStore.getState();
  return `${Boolean(token)}:${activeIdentity?.type ?? "guest"}:${activeIdentity?.id ?? ""}`;
}

function invalidatePublicDirectoryRequests(): void {
  publicRoomsRequestSeq++;
  publicAgentsRequestSeq++;
  publicHumansRequestSeq++;
  publicRoomsInFlight = null;
  publicAgentsInFlight = null;
  publicHumansInFlight = null;
}

const emptyRoomMessageSnapshot = new Map<string, string | null>();
const fullyLoadedRoomHistory = new Set<string>();
let roomMessageRequestSequence = 0;
const roomMessageEpochByRoom = new Map<string, number>();
const roomMessageLoadRequestByRoom = new Map<string, number>();
const roomMessageLoadPromises = new Map<string, Promise<void>>();
const roomMessagePollRequestByRoom = new Map<string, number>();
const roomMessageMoreRequestByRoom = new Map<string, number>();

function roomMessageEpoch(roomId: string): number {
  return roomMessageEpochByRoom.get(roomId) ?? 0;
}

function isCurrentRoomMessageRequest(
  roomId: string,
  epoch: number,
  requestId: number,
  requests: Map<string, number>,
): boolean {
  return roomMessageEpoch(roomId) === epoch && requests.get(roomId) === requestId;
}

function invalidateRoomMessageRequests(roomId: string): void {
  roomMessageEpochByRoom.set(roomId, roomMessageEpoch(roomId) + 1);
  roomMessagesInFlight.delete(roomId);
  roomMessagesReloadPending.delete(roomId);
  roomPollInFlight.delete(roomId);
  roomMessageLoadRequestByRoom.delete(roomId);
  roomMessageLoadPromises.delete(roomId);
  roomMessagePollRequestByRoom.delete(roomId);
  roomMessageMoreRequestByRoom.delete(roomId);
  emptyRoomMessageSnapshot.delete(roomId);
  fullyLoadedRoomHistory.delete(roomId);
}

function invalidateAllRoomMessageRequests(): void {
  const roomIds = new Set([
    ...roomMessageEpochByRoom.keys(),
    ...roomMessagesInFlight,
    ...roomMessagesReloadPending,
    ...roomPollInFlight,
    ...roomMessageLoadRequestByRoom.keys(),
    ...roomMessagePollRequestByRoom.keys(),
    ...roomMessageMoreRequestByRoom.keys(),
    ...emptyRoomMessageSnapshot.keys(),
    ...fullyLoadedRoomHistory,
  ]);
  for (const roomId of roomIds) invalidateRoomMessageRequests(roomId);
}

/**
 * Structural equality for overview snapshots. `DashboardOverview` is plain JSON
 * (no functions/Dates), so a stringify compare is correct. Used to keep the
 * stored reference stable across background polls that return identical data —
 * otherwise every 5s poll hands subscribers a fresh object and re-renders them.
 */
function overviewEqual(a: DashboardOverview, b: DashboardOverview): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
const roomMembersInFlight = new Map<string, Promise<PublicRoomMember[]>>();
const recalledPreviewText = "Message recalled";

function isFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" && error.message === "Failed to fetch";
}

function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) return true;
  if (!(error instanceof Error)) return false;
  return error.message === "Unauthorized";
}

function applyRealtimeRoomHint<T extends {
  room_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_sender_name: string | null;
}>(room: T, event: RealtimeMetaEvent): T {
  if (room.room_id !== event.room_id) return room;

  const preview = typeof event.ext.preview === "string"
    ? event.ext.preview
    : room.last_message_preview;

  const senderName = typeof event.ext.display_sender_name === "string"
    ? event.ext.display_sender_name
    : typeof event.ext.sender_name === "string"
      ? event.ext.sender_name
      : room.last_sender_name;

  return {
    ...room,
    last_message_at: event.created_at > (room.last_message_at ?? "") ? event.created_at : room.last_message_at,
    last_message_preview: preview,
    last_sender_name: senderName,
  };
}

function getRoomMessageSnapshot(room: DashboardRoom | null): string | null {
  return room?.last_message_at ?? null;
}

function buildRecalledMessagePatch(patch?: {
  recalled_at?: string | null;
  recalled_by_id?: string | null;
  recalled_by_type?: "agent" | "human" | null;
}): Partial<DashboardMessage> {
  const recalledAt = patch?.recalled_at ?? new Date().toISOString();
  return {
    text: "",
    payload: {
      recalled: true,
      is_recalled: true,
      recalled_at: recalledAt,
      recalled_by_id: patch?.recalled_by_id ?? null,
      recalled_by_type: patch?.recalled_by_type ?? null,
    },
    is_recalled: true,
    recalled_at: recalledAt,
    recalled_by_id: patch?.recalled_by_id ?? null,
    recalled_by_type: patch?.recalled_by_type ?? null,
  };
}

function messageStatusReactionFromEvent(event: RealtimeMetaEvent): MessageStatusReaction | null {
  const ext = event.ext || {};
  const msgId = typeof ext.msg_id === "string" ? ext.msg_id : null;
  const actorId = typeof ext.actor_id === "string" ? ext.actor_id : null;
  const kind = ext.kind === "replying" ? "replying" : null;
  const state =
    ext.state === "active" || ext.state === "cleared" || ext.state === "expired"
      ? ext.state
      : null;
  if (!event.room_id || !msgId || !actorId || !kind || !state) return null;
  return {
    room_id: event.room_id,
    msg_id: msgId,
    actor_id: actorId,
    actor_name: typeof ext.actor_name === "string" ? ext.actor_name : null,
    kind,
    emoji: typeof ext.emoji === "string" && ext.emoji ? ext.emoji : "⏳",
    state,
    turn_id: typeof ext.turn_id === "string" ? ext.turn_id : null,
    expires_at: typeof ext.expires_at === "string" ? ext.expires_at : null,
  };
}

function upsertStatusReaction(
  current: MessageStatusReaction[] | undefined,
  incoming: MessageStatusReaction,
): MessageStatusReaction[] {
  const existing = current ?? [];
  const key = `${incoming.actor_id}:${incoming.kind}`;
  const filtered = existing.filter((item) => {
    if (`${item.actor_id}:${item.kind}` !== key) return true;
    if (incoming.state === "active") return false;
    if (!incoming.turn_id) return false;
    return item.turn_id !== incoming.turn_id;
  });
  if (incoming.state !== "active") return filtered;
  return [...filtered, { ...incoming, state: "active" }];
}

function dashboardMessageStableId(message: Pick<DashboardMessage, "hub_msg_id" | "msg_id">): string {
  return message.msg_id || message.hub_msg_id;
}

function sameAttachmentIdentity(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return left.url === right.url
    && left.filename === right.filename
    && left.content_type === right.content_type
    && left.size_bytes === right.size_bytes;
}

function preserveStableAttachmentPayload(
  existing: DashboardMessage,
  incoming: DashboardMessage,
): DashboardMessage {
  const existingAttachments = existing.payload?.attachments;
  const incomingAttachments = incoming.payload?.attachments;
  if (
    !Array.isArray(existingAttachments)
    || !Array.isArray(incomingAttachments)
    || existingAttachments.length !== incomingAttachments.length
    || !incomingAttachments.every((att, index) => sameAttachmentIdentity(existingAttachments[index], att))
  ) {
    return incoming;
  }

  return {
    ...incoming,
    payload: {
      ...incoming.payload,
      attachments: existingAttachments,
    },
  };
}

function sortRoomMessagesChronologically(messages: DashboardMessage[]): DashboardMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aTime = Date.parse(a.message.created_at);
      const bTime = Date.parse(b.message.created_at);
      const normalizedA = Number.isNaN(aTime) ? 0 : aTime;
      const normalizedB = Number.isNaN(bTime) ? 0 : bTime;
      return normalizedA - normalizedB || a.index - b.index;
    })
    .map(({ message }) => message);
}

function mergeLoadedRoomMessages(
  currentMessages: DashboardMessage[] | undefined,
  loadedNewestFirst: DashboardMessage[],
): DashboardMessage[] {
  const loadedChronological = [...loadedNewestFirst].reverse();
  if (!currentMessages || currentMessages.length === 0) return loadedChronological;

  const byStableId = new Map<string, DashboardMessage>();
  const byHubMsgId = new Map<string, DashboardMessage>();
  for (const message of currentMessages) {
    byStableId.set(dashboardMessageStableId(message), message);
    byHubMsgId.set(message.hub_msg_id, message);
  }

  const merged = loadedChronological.map((incoming) => {
    const existing = byStableId.get(dashboardMessageStableId(incoming))
      ?? byHubMsgId.get(incoming.hub_msg_id);
    return existing ? preserveStableAttachmentPayload(existing, incoming) : incoming;
  });

  const loadedStableIds = new Set(merged.map(dashboardMessageStableId));
  const loadedHubMsgIds = new Set(merged.map((message) => message.hub_msg_id));
  for (const existing of currentMessages) {
    if (
      loadedStableIds.has(dashboardMessageStableId(existing))
      || loadedHubMsgIds.has(existing.hub_msg_id)
    ) {
      continue;
    }
    merged.push(existing);
  }

  return sortRoomMessagesChronologically(merged);
}

function ownerChatRoomIdForOptimistic(agentId: string): string {
  return `rm_oc_pending_${agentId}`;
}

function isOwnerChatSummary(room: Pick<HumanAgentRoomSummary, "room_id">): boolean {
  return room.room_id.startsWith("rm_oc_");
}

function ownerChatAgentId(room: HumanAgentRoomSummary): string | null {
  if (!isOwnerChatSummary(room)) return null;
  return room.bots[0]?.agent_id ?? null;
}

function buildOptimisticOwnerChatRoom(
  agent: Pick<UserAgent, "agent_id" | "display_name"> & Partial<Pick<UserAgent, "claimed_at">>,
  roomId?: string | null,
  existing?: HumanAgentRoomSummary,
): HumanAgentRoomSummary {
  const now = new Date().toISOString();
  const createdAt = existing?.created_at ?? agent.claimed_at ?? now;
  return {
    ...existing,
    room_id: roomId || ownerChatRoomIdForOptimistic(agent.agent_id),
    name: existing?.name || agent.display_name || agent.agent_id,
    description: existing?.description ?? null,
    rule: existing?.rule ?? null,
    owner_id: agent.agent_id,
    visibility: existing?.visibility || "private",
    join_policy: existing?.join_policy || "invite_only",
    member_count: existing?.member_count ?? 1,
    created_at: createdAt,
    required_subscription_product_id: existing?.required_subscription_product_id ?? null,
    last_message_preview: existing?.last_message_preview ?? null,
    last_message_at: existing?.last_message_at ?? null,
    last_sender_name: existing?.last_sender_name ?? null,
    allow_human_send: existing?.allow_human_send ?? true,
    members_preview: existing?.members_preview ?? null,
    bots: existing?.bots ?? [{
      agent_id: agent.agent_id,
      display_name: agent.display_name || agent.agent_id,
      role: "owner",
    }],
  };
}

function ensureOwnerChatRoomsForOwnedAgents(
  rooms: HumanAgentRoomSummary[],
  agents: UserAgent[],
): HumanAgentRoomSummary[] {
  if (agents.length === 0) return rooms;

  const roomAgentIds = new Set(
    rooms
      .map(ownerChatAgentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
  const fallbackRooms = agents
    .filter((agent) => !roomAgentIds.has(agent.agent_id))
    .map((agent) => buildOptimisticOwnerChatRoom(agent));

  if (fallbackRooms.length === 0) return rooms;
  return [...rooms, ...fallbackRooms].sort(compareRoomsByActivityDesc);
}

function mergeOptimisticOwnerChatRooms(
  rooms: HumanAgentRoomSummary[],
  optimisticByAgent: Record<string, HumanAgentRoomSummary>,
): HumanAgentRoomSummary[] {
  const optimisticRooms = Object.values(optimisticByAgent);
  if (optimisticRooms.length === 0) return rooms;

  const optimisticAgentIds = new Set(optimisticRooms.map((room) => room.bots[0]?.agent_id).filter(Boolean));
  const baseRooms = rooms.filter((room) => {
    const agentId = ownerChatAgentId(room);
    return !agentId || !optimisticAgentIds.has(agentId);
  });
  return [...baseRooms, ...optimisticRooms].sort(compareRoomsByActivityDesc);
}

function reconcileOptimisticOwnerChatRooms(
  serverRooms: HumanAgentRoomSummary[],
  optimisticByAgent: Record<string, HumanAgentRoomSummary>,
): Record<string, HumanAgentRoomSummary> {
  if (Object.keys(optimisticByAgent).length === 0) return optimisticByAgent;

  const serverOwnerChatAgents = new Set(
    serverRooms
      .map(ownerChatAgentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
  const next = { ...optimisticByAgent };
  for (const agentId of serverOwnerChatAgents) {
    delete next[agentId];
  }
  return next;
}

export function mapOwnedAgentRoomToDashboardRoom(room: HumanAgentRoomSummary): DashboardRoom {
  return ownedAgentRoomToDashboardRoom(room);
}

interface DashboardChatState {
  overviewRefreshing: boolean;
  overviewErrored: boolean;
  overview: DashboardOverview | null;
  messages: Record<string, DashboardMessage[]>;
  messagesLoading: Record<string, boolean>;
  messagesErrors: Record<string, string>;
  messagesHasMore: Record<string, boolean>;
  messagesLoadingMore: Record<string, boolean>;
  messagesMoreErrors: Record<string, string>;
  roomMembersByRoom: Record<string, PublicRoomMember[]>;
  roomMembersLoading: Record<string, boolean>;
  error: string | null;
  selectedAgentId: string | null;
  selectedAgentLoading: boolean;
  selectedAgentError: string | null;
  selectedAgentProfile: AgentProfile | null;
  selectedAgentConversations: DashboardRoom[] | null;
  searchResults: AgentProfile[] | null;
  discoverRooms: DiscoverRoom[];
  discoverLoading: boolean;
  joiningRoomId: string | null;
  leavingRoomId: string | null;
  publicRooms: PublicRoom[];
  publicRoomDetails: Record<string, PublicRoom>;
  publicRoomsLoading: boolean;
  publicRoomsLoaded: boolean;
  publicRoomsQuery: string | null;
  publicAgents: AgentProfile[];
  publicAgentsLoading: boolean;
  publicAgentsLoaded: boolean;
  publicAgentsQuery: string | null;
  publicHumans: PublicHumanProfile[];
  publicHumansLoading: boolean;
  publicHumansLoaded: boolean;
  publicHumansQuery: string | null;
  recentVisitedRooms: PublicRoom[];
  ownedAgentRooms: HumanAgentRoomSummary[];
  /** Organization (Team) rooms the viewer joined; only a getRoomSummary fallback, never listed personally. */
  spaceRooms: DashboardRoom[];
  optimisticOwnerChatRooms: Record<string, HumanAgentRoomSummary>;
  ownedAgentRoomsLoading: boolean;
  ownedAgentRoomsLoaded: boolean;
  roomMemberVersions: Record<string, number>;
  /** Quote-reply: per-room "currently replying to" target (null when not replying). */
  replyingTo: Record<string, DashboardMessage | null>;
  setReplyingTo: (roomId: string, message: DashboardMessage | null) => void;

  setError: (error: string | null) => void;
  addRecentPublicRoom: (room: PublicRoom) => void;
  resetChatState: () => void;
  logout: () => void;
  closeAgentCardState: () => void;
  getRoomSummary: (roomId: string) => DashboardRoom | null;
  setSpaceRooms: (rooms: DashboardRoom[]) => void;
  getVisibleMessageRooms: () => DashboardRoom[];
  hasMessage: (roomId: string, hubMsgId: string) => boolean;
  applyRealtimeEventHint: (event: RealtimeMetaEvent) => void;
  replaceOverview: (overview: DashboardOverview) => void;
  patchRoom: (roomId: string, patch: Partial<DashboardRoom>) => void;
  patchOwnerChatRoomSummary: (roomId: string, patch: Pick<HumanAgentRoomSummary, "last_message_at" | "last_message_preview" | "last_sender_name">) => void;
  bumpRoomMembersVersion: (roomId: string) => void;

  insertMessage: (roomId: string, message: DashboardMessage) => void;
  patchMessageIdentity: (roomId: string, temporaryId: string, patch: Partial<Pick<DashboardMessage, "hub_msg_id" | "msg_id" | "topic_id">>) => void;
  /** Mark a still-unconfirmed optimistic message as failed (send rejected). */
  markMessageFailed: (roomId: string, temporaryId: string) => void;
  markMessageRecalled: (roomId: string, msgId: string, patch?: { recalled_at?: string | null; recalled_by_id?: string | null; recalled_by_type?: "agent" | "human" | null }) => void;
  applyMessageStatusReaction: (event: RealtimeMetaEvent) => void;
  recallMessage: (roomId: string, msgId: string) => Promise<void>;
  loadRoomMessages: (roomId: string, opts?: { force?: boolean }) => Promise<void>;
  prefetchRoomMessages: (roomId: string) => Promise<void>;
  pollNewMessages: (roomId: string, opts?: {
    expectedHubMsgId?: string | null;
    retries?: number;
    /** Surface a lightweight refresh signal when a user actively opens a cached room. */
    showLoading?: boolean;
  }) => Promise<void>;
  loadMoreMessages: (roomId: string) => Promise<void>;
  loadRoomMembers: (roomId: string, opts?: { force?: boolean }) => Promise<PublicRoomMember[]>;
  selectAgent: (agentId: string) => Promise<void>;
  searchAgents: (q: string) => Promise<void>;
  refreshOverview: (opts?: { reloadOpenedRoom?: boolean }) => Promise<void>;
  loadDiscoverRooms: () => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  loadPublicRooms: (q?: string) => Promise<void>;
  loadPublicRoomDetail: (roomId: string) => Promise<PublicRoom | null>;
  loadPublicAgents: (q?: string) => Promise<void>;
  loadPublicHumans: (q?: string) => Promise<void>;
  loadOwnedAgentRooms: () => Promise<void>;
  upsertOptimisticOwnerChatRoom: (agent: Pick<UserAgent, "agent_id" | "display_name">, roomId?: string | null) => void;
}

const initialChatState = {
  overviewRefreshing: false,
  overviewErrored: false,
  overview: null,
  messages: {},
  messagesLoading: {},
  messagesErrors: {},
  messagesHasMore: {},
  messagesLoadingMore: {},
  messagesMoreErrors: {},
  roomMembersByRoom: {},
  roomMembersLoading: {},
  error: null,
  selectedAgentId: null,
  selectedAgentLoading: false,
  selectedAgentError: null,
  selectedAgentProfile: null,
  selectedAgentConversations: null,
  searchResults: null,
  discoverRooms: [],
  discoverLoading: false,
  joiningRoomId: null,
  leavingRoomId: null,
  publicRooms: [],
  publicRoomDetails: {},
  publicRoomsLoading: false,
  publicRoomsLoaded: false,
  publicRoomsQuery: null as string | null,
  publicAgents: [],
  publicAgentsLoading: false,
  publicAgentsLoaded: false,
  publicAgentsQuery: null as string | null,
  publicHumans: [],
  publicHumansLoading: false,
  publicHumansLoaded: false,
  publicHumansQuery: null as string | null,
  recentVisitedRooms: [],
  ownedAgentRooms: [],
  spaceRooms: [] as DashboardRoom[],
  optimisticOwnerChatRooms: {},
  ownedAgentRoomsLoading: false,
  ownedAgentRoomsLoaded: false,
  roomMemberVersions: {},
  replyingTo: {} as Record<string, DashboardMessage | null>,
};

function hasTransientChatState(state: DashboardChatState): boolean {
  return (
    state.overviewRefreshing
    || state.overviewErrored
    || state.overview !== null
    || Object.keys(state.messages).length > 0
    || Object.keys(state.messagesLoading).length > 0
    || Object.keys(state.messagesErrors).length > 0
    || Object.keys(state.messagesHasMore).length > 0
    || Object.keys(state.messagesLoadingMore).length > 0
    || Object.keys(state.messagesMoreErrors).length > 0
    || Object.keys(state.roomMembersByRoom).length > 0
    || Object.keys(state.roomMembersLoading).length > 0
    || state.error !== null
    || state.selectedAgentId !== null
    || state.selectedAgentLoading
    || state.selectedAgentError !== null
    || state.selectedAgentProfile !== null
    || state.selectedAgentConversations !== null
    || state.searchResults !== null
    || state.discoverRooms.length > 0
    || state.discoverLoading
    || state.joiningRoomId !== null
    || state.leavingRoomId !== null
    || state.publicRoomsLoading
    || state.publicHumansLoading
    || state.publicRoomsQuery !== null
    || state.publicAgentsQuery !== null
    || state.publicHumansQuery !== null
    || state.publicAgentsLoading
    || Object.keys(state.optimisticOwnerChatRooms).length > 0
    || state.ownedAgentRoomsLoading
  );
}

let _errorTimerId: ReturnType<typeof setTimeout> | null = null;
let overviewInFlight: Promise<void> | null = null;
let ownedAgentRoomsInFlight: Promise<void> | null = null;

export const useDashboardChatStore = create<DashboardChatState>()(
  persist(
    (set, get) => ({
      ...initialChatState,

      setError: (error) => {
        set({ error });
        if (_errorTimerId) {
          clearTimeout(_errorTimerId);
          _errorTimerId = null;
        }
        if (error) {
          _errorTimerId = setTimeout(() => {
            _errorTimerId = null;
            if (get().error === error) set({ error: null });
          }, 4000);
        }
      },

      addRecentPublicRoom: (room) =>
        set((state) => ({
          recentVisitedRooms: [
            room,
            ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
          ].slice(0, 20),
        })),

      setReplyingTo: (roomId, message) =>
        set((state) => ({
          replyingTo: { ...state.replyingTo, [roomId]: message },
        })),

      resetChatState: () => {
        invalidateAllRoomMessageRequests();
        invalidatePublicDirectoryRequests();
        invalidateAgentProfiles();
        set((state) => {
          if (!hasTransientChatState(state)) {
            return state;
          }
          return {
            ...initialChatState,
            recentVisitedRooms: state.recentVisitedRooms,
            publicRooms: state.publicRooms,
            publicAgents: state.publicAgents,
            publicRoomDetails: state.publicRoomDetails,
          };
        });
      },

      logout: () => {
        invalidateAllRoomMessageRequests();
        invalidatePublicDirectoryRequests();
        invalidateAgentProfiles();
        set({ ...initialChatState });
      },

      closeAgentCardState: () => {
        agentSelectionSequence += 1;
        set({ selectedAgentLoading: false, selectedAgentError: null });
      },

      getRoomSummary: (roomId) => {
        const state = get();
        const joinedRoom = state.overview?.rooms.find((room) => room.room_id === roomId);
        if (joinedRoom) return joinedRoom;
        const publicRoom = state.publicRooms.find((room) => room.room_id === roomId) || state.publicRoomDetails[roomId];
        if (publicRoom) return toRoomSummary(publicRoom);
        const recentRoom = state.recentVisitedRooms.find((room) => room.room_id === roomId);
        if (recentRoom) return toRoomSummary(recentRoom);
        const ownedAgentRoom = state.ownedAgentRooms.find((room) => room.room_id === roomId);
        if (ownedAgentRoom) return ownedAgentRoomToDashboardRoom(ownedAgentRoom);
        return state.spaceRooms.find((room) => room.room_id === roomId) ?? null;
      },

      setSpaceRooms: (spaceRooms) => set({ spaceRooms }),

      getVisibleMessageRooms: () =>
        buildVisibleMessageRooms({
          overview: get().overview,
          recentVisitedRooms: get().recentVisitedRooms,
          token: useDashboardSessionStore.getState().token,
        }),

      hasMessage: (roomId, hubMsgId) => {
        if (!hubMsgId) return false;
        return (get().messages[roomId] || []).some((message) => message.hub_msg_id === hubMsgId);
      },

      insertMessage: (roomId, message) =>
        set((state) => {
          const current = state.messages[roomId] || [];
          if (current.some((m) => m.hub_msg_id === message.hub_msg_id)) return state;
          return {
            messages: { ...state.messages, [roomId]: [...current, message] },
          };
        }),

      patchMessageIdentity: (roomId, temporaryId, patch) =>
        set((state) => {
          const current = state.messages[roomId];
          if (!current) return state;
          const definedPatch: Partial<Pick<DashboardMessage, "hub_msg_id" | "msg_id" | "topic_id">> = {};
          if (patch.hub_msg_id !== undefined) definedPatch.hub_msg_id = patch.hub_msg_id;
          if (patch.msg_id !== undefined) definedPatch.msg_id = patch.msg_id;
          if (patch.topic_id !== undefined) definedPatch.topic_id = patch.topic_id;
          if (Object.keys(definedPatch).length === 0) return state;
          let changed = false;
          const nextMessages = current.map((message) => {
            if (message.hub_msg_id !== temporaryId && message.msg_id !== temporaryId) return message;
            changed = true;
            return { ...message, ...definedPatch };
          });
          if (!changed) return state;
          return {
            messages: { ...state.messages, [roomId]: nextMessages },
          };
        }),

      markMessageFailed: (roomId, temporaryId) =>
        set((state) => {
          const current = state.messages[roomId];
          if (!current) return state;
          let changed = false;
          const nextMessages = current.map((message) => {
            if (message.hub_msg_id !== temporaryId && message.msg_id !== temporaryId) return message;
            changed = true;
            return { ...message, state: "failed" };
          });
          if (!changed) return state;
          return {
            messages: { ...state.messages, [roomId]: nextMessages },
          };
        }),

      markMessageRecalled: (roomId, msgId, patch) =>
        set((state) => {
          const current = state.messages[roomId];
          if (!current) return state;
          let changed = false;
          const recalledPatch = buildRecalledMessagePatch(patch);
          const nextMessages = current.map((message) => {
            if (message.msg_id !== msgId && message.hub_msg_id !== msgId) return message;
            changed = true;
            return { ...message, ...recalledPatch };
          });
          if (!changed) return state;

          const latestMessage = [...nextMessages].reverse().find(
            (message) => message.type !== "ack" && message.type !== "result" && message.type !== "error",
          );
          const shouldPatchRoomPreview = latestMessage?.msg_id === msgId || latestMessage?.hub_msg_id === msgId;
          const patchRoomSummary = <T extends {
            room_id: string;
            last_message_preview: string | null;
          }>(room: T): T => (
            shouldPatchRoomPreview && room.room_id === roomId
              ? { ...room, last_message_preview: recalledPreviewText }
              : room
          );

          return {
            messages: { ...state.messages, [roomId]: nextMessages },
            overview: state.overview
              ? {
                ...state.overview,
                rooms: state.overview.rooms.map(patchRoomSummary),
              }
              : state.overview,
            publicRoomDetails: state.publicRoomDetails[roomId]
              ? {
                ...state.publicRoomDetails,
                [roomId]: patchRoomSummary(state.publicRoomDetails[roomId]),
              }
              : state.publicRoomDetails,
            recentVisitedRooms: state.recentVisitedRooms.map(patchRoomSummary),
            ownedAgentRooms: state.ownedAgentRooms.map(patchRoomSummary),
          };
        }),

      applyMessageStatusReaction: (event) =>
        set((state) => {
          if (!event.room_id) return state;
          const reaction = messageStatusReactionFromEvent(event);
          if (!reaction) return state;
          const current = state.messages[event.room_id];
          if (!current) return state;
          let changed = false;
          const nextMessages = current.map((message) => {
            if (message.msg_id !== reaction.msg_id && message.hub_msg_id !== reaction.msg_id) {
              return message;
            }
            changed = true;
            return {
              ...message,
              status_reactions: upsertStatusReaction(message.status_reactions, reaction),
            };
          });
          if (!changed) return state;
          return {
            messages: {
              ...state.messages,
              [event.room_id]: nextMessages,
            },
          };
        }),

      recallMessage: async (roomId, msgId) => {
        const previous = get().messages[roomId]?.find(
          (message) => message.msg_id === msgId || message.hub_msg_id === msgId,
        );
        get().markMessageRecalled(roomId, msgId);
        try {
          const result = await api.recallRoomMessage(roomId, msgId);
          get().markMessageRecalled(roomId, msgId, {
            recalled_at: result.recalled_at,
            recalled_by_id: result.recalled_by_id,
            recalled_by_type: result.recalled_by_type ?? null,
          });
        } catch (error) {
          if (previous) {
            set((state) => ({
              messages: {
                ...state.messages,
                [roomId]: (state.messages[roomId] || []).map((message) =>
                  message.msg_id === msgId || message.hub_msg_id === msgId ? previous : message,
                ),
              },
            }));
          }
          get().setError(error instanceof Error ? error.message : "Failed to recall message");
          throw error;
        }
      },

      applyRealtimeEventHint: (event) =>
        set((state) => ({
          overview: state.overview
            ? {
              ...state.overview,
              rooms: state.overview.rooms.map((room) => applyRealtimeRoomHint(room, event)),
            }
            : state.overview,
          publicRoomDetails: event.room_id && state.publicRoomDetails[event.room_id]
            ? {
              ...state.publicRoomDetails,
              [event.room_id]: applyRealtimeRoomHint(state.publicRoomDetails[event.room_id], event),
            }
            : state.publicRoomDetails,
          recentVisitedRooms: event.room_id
            ? state.recentVisitedRooms.map((room) => applyRealtimeRoomHint(room, event))
            : state.recentVisitedRooms,
          ownedAgentRooms: event.room_id
            ? state.ownedAgentRooms.map((room) => applyRealtimeRoomHint(room, event))
            : state.ownedAgentRooms,
        })),

      replaceOverview: (overview) => {
        const current = get().overview;
        if (current && overviewEqual(current, overview)) {
          // Identical to what we already hold — keep the existing reference so no
          // subscriber re-renders. Only touch state if a loading/error flag is set.
          if (get().overviewRefreshing || get().overviewErrored) {
            set({ overviewRefreshing: false, overviewErrored: false });
          }
          return;
        }
        set({ overview, overviewRefreshing: false, overviewErrored: false });
        useDashboardUnreadStore.getState().reconcileUnreadRooms(overview.rooms);
      },

      patchRoom: (roomId, patch) =>
        set((state) => ({
          overview: state.overview
            ? {
              ...state.overview,
              rooms: state.overview.rooms.map((room) =>
                room.room_id === roomId ? { ...room, ...patch } : room,
              ),
            }
            : state.overview,
        })),

      patchOwnerChatRoomSummary: (roomId, patch) =>
        set((state) => {
          const existing = state.ownedAgentRooms.find((room) => room.room_id === roomId);
          if (!existing) return state;
          const currentAt = existing.last_message_at ?? "";
          const nextAt = patch.last_message_at ?? "";
          if (currentAt && nextAt && nextAt < currentAt) return state;

          const patchRoomSummary = (room: HumanAgentRoomSummary): HumanAgentRoomSummary =>
            room.room_id === roomId
              ? {
                ...room,
                last_message_at: patch.last_message_at,
                last_message_preview: patch.last_message_preview,
                last_sender_name: patch.last_sender_name,
              }
              : room;

          return {
            ownedAgentRooms: state.ownedAgentRooms
              .map(patchRoomSummary)
              .sort(compareRoomsByActivityDesc),
            optimisticOwnerChatRooms: Object.fromEntries(
              Object.entries(state.optimisticOwnerChatRooms).map(([agentId, room]) => [
                agentId,
                patchRoomSummary(room),
              ]),
            ),
          };
        }),

      bumpRoomMembersVersion: (roomId) =>
        set((state) => ({
          roomMembersByRoom: Object.fromEntries(
            Object.entries(state.roomMembersByRoom).filter(([key]) => key !== roomId),
          ),
          roomMemberVersions: {
            ...state.roomMemberVersions,
            [roomId]: (state.roomMemberVersions[roomId] ?? 0) + 1,
          },
        })),

      loadRoomMessages: (roomId: string, opts) => {
        const pending = roomMessageLoadPromises.get(roomId);
        if (pending) {
          if (opts?.force) roomMessagesReloadPending.add(roomId);
          return pending;
        }
        const epoch = roomMessageEpoch(roomId);
        const requestId = ++roomMessageRequestSequence;
        roomMessageLoadRequestByRoom.set(roomId, requestId);
        const request = Promise.resolve().then(async () => {
          if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageLoadRequestByRoom)) return;

          try {
            const result = await api.getRoomMessages(roomId, { limit: 50 });
            if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageLoadRequestByRoom)) return;
            if (result.messages.length === 0) {
              emptyRoomMessageSnapshot.set(roomId, getRoomMessageSnapshot(get().getRoomSummary(roomId)));
            } else {
              emptyRoomMessageSnapshot.delete(roomId);
            }
            if (!result.has_more) fullyLoadedRoomHistory.add(roomId);
            set((state) => {
              if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageLoadRequestByRoom)) return state;
              return {
                messages: {
                  ...state.messages,
                  [roomId]: mergeLoadedRoomMessages(state.messages[roomId], result.messages),
                },
                // A full refresh only returns the newest page. Once pagination
                // already reached the oldest message, keep that terminal state
                // instead of reviving a misleading "load earlier" affordance.
                messagesHasMore: {
                  ...state.messagesHasMore,
                  [roomId]: fullyLoadedRoomHistory.has(roomId) ? false : result.has_more,
                },
              };
            });
          } catch (error) {
            console.error("[ChatStore] Failed to load messages:", error);
            if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageLoadRequestByRoom)) return;
            const message = error instanceof Error ? error.message : "Failed to load messages";
            set((state) => ({
              messagesErrors: { ...state.messagesErrors, [roomId]: message },
            }));
          } finally {
            if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageLoadRequestByRoom)) return;
            roomMessagesInFlight.delete(roomId);
            roomMessageLoadRequestByRoom.delete(roomId);
            roomMessageLoadPromises.delete(roomId);
            set((state) => ({
              messagesLoading: { ...state.messagesLoading, [roomId]: false },
            }));
            if (roomMessagesReloadPending.delete(roomId)) {
              void get().loadRoomMessages(roomId, { force: true });
            }
          }
        });
        // Publish the Promise before notifying subscribers: a detail pane can
        // synchronously join a hover request from a store subscription.
        roomMessageLoadPromises.set(roomId, request);
        roomMessagesInFlight.add(roomId);
        set((state) => {
          const messagesErrors = { ...state.messagesErrors };
          delete messagesErrors[roomId];
          return { messagesLoading: { ...state.messagesLoading, [roomId]: true }, messagesErrors };
        });
        return request;
      },

      prefetchRoomMessages: async (roomId: string) => {
        const state = get();
        if (Object.prototype.hasOwnProperty.call(state.messages, roomId)) return;
        await get().loadRoomMessages(roomId);
      },

      pollNewMessages: async (roomId: string, opts) => {
        if (roomPollInFlight.has(roomId)) return;
        const epoch = roomMessageEpoch(roomId);
        const requestId = ++roomMessageRequestSequence;
        roomMessagePollRequestByRoom.set(roomId, requestId);
        const hadCachedMessages = Object.prototype.hasOwnProperty.call(get().messages, roomId);
        const showLoading = Boolean(opts?.showLoading && hadCachedMessages);
        if (showLoading) {
          set((state) => {
            const messagesErrors = { ...state.messagesErrors };
            delete messagesErrors[roomId];
            return {
              messagesLoading: { ...state.messagesLoading, [roomId]: true },
              messagesErrors,
            };
          });
        }
        roomPollInFlight.add(roomId);
        try {
          const existing = get().messages[roomId];

          if (!existing) {
            await get().loadRoomMessages(roomId);
          } else if (existing.length === 0) {
            const currentSnapshot = getRoomMessageSnapshot(get().getRoomSummary(roomId));
            const previousSnapshot = emptyRoomMessageSnapshot.get(roomId);
            if (opts?.expectedHubMsgId || previousSnapshot !== currentSnapshot) {
              await get().loadRoomMessages(roomId, { force: Boolean(opts?.expectedHubMsgId) });
            }
          } else {
            if (opts?.expectedHubMsgId) {
              const expectedMessage = existing.find((message) => message.hub_msg_id === opts.expectedHubMsgId);
              if (expectedMessage && (!expectedMessage.msg_id || expectedMessage.msg_id.startsWith("tmp_"))) {
                await get().loadRoomMessages(roomId, { force: true });
                return;
              }
            }
            const newestPersisted = [...existing].reverse().find(
              (m) => m.hub_msg_id && !m.hub_msg_id.startsWith("tmp_"),
            );
            if (!newestPersisted) {
              await get().loadRoomMessages(roomId, { force: Boolean(opts?.expectedHubMsgId) });
              return;
            }
            const activityFor = existing.filter((m) =>
              m.sender_kind === "human" && !m.hub_msg_id.startsWith("tmp_")
              && (!m.reply_activity || m.reply_activity.some((a) => a.status !== "completed"))
            ).slice(-100).map((m) => m.msg_id);
            const result = await api.getRoomMessages(roomId, { after: newestPersisted.hub_msg_id, limit: 50, activityFor });
            if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessagePollRequestByRoom)) return;
            if (result.activity_updates && Object.keys(result.activity_updates).length) {
              set((state) => ({ messages: { ...state.messages, [roomId]: (state.messages[roomId] || []).map((m) =>
                Object.prototype.hasOwnProperty.call(result.activity_updates, m.msg_id)
                  ? { ...m, reply_activity: result.activity_updates![m.msg_id] } : m
              ) } }));
            }
            if (result.messages.length > 0) {
              if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessagePollRequestByRoom)) return;
              const newMsgs = result.messages.reverse();
              set((state) => {
                if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessagePollRequestByRoom)) return state;
                const current = state.messages[roomId] || [];
                const existingStableIds = new Set(current.map(dashboardMessageStableId));
                const existingHubMsgIds = new Set(current.map((message) => message.hub_msg_id));
                const deduped = newMsgs.filter((message) =>
                  !existingStableIds.has(dashboardMessageStableId(message))
                  && !existingHubMsgIds.has(message.hub_msg_id)
                );
                if (deduped.length === 0) return state;
                const currentWithoutMatchedOptimistic = current.filter((message) => {
                  if (!message.hub_msg_id?.startsWith("tmp_")) return true;
                  return !deduped.some((newMessage) =>
                    newMessage.text === message.text
                    && (
                      newMessage.sender_id === message.sender_id
                      || newMessage.is_mine === message.is_mine
                    ),
                  );
                });
                return {
                  messages: { ...state.messages, [roomId]: [...currentWithoutMatchedOptimistic, ...deduped] },
                };
              });
            }
          }
        } catch (error) {
          console.error("[ChatStore] Failed to poll new messages:", error);
          if (showLoading && isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessagePollRequestByRoom)) {
            const message = error instanceof Error ? error.message : "Failed to refresh messages";
            set((state) => ({
              messagesErrors: { ...state.messagesErrors, [roomId]: message },
            }));
          }
        } finally {
          if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessagePollRequestByRoom)) return;
          roomPollInFlight.delete(roomId);
          roomMessagePollRequestByRoom.delete(roomId);
          if (showLoading) {
            set((state) => ({
              messagesLoading: { ...state.messagesLoading, [roomId]: false },
            }));
          }
        }

        const expectedHubMsgId = opts?.expectedHubMsgId ?? null;
        const retries = opts?.retries ?? 0;
        if (
          roomMessageEpoch(roomId) === epoch
          && expectedHubMsgId
          && retries > 0
          && !get().hasMessage(roomId, expectedHubMsgId)
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          await get().pollNewMessages(roomId, {
            expectedHubMsgId,
            retries: retries - 1,
            showLoading: opts?.showLoading,
          });
        }
      },

      loadMoreMessages: async (roomId: string) => {
        const existing = get().messages[roomId];
        if (!existing || existing.length === 0 || get().messagesLoadingMore[roomId]) return;

        const oldest = existing[0];
        const epoch = roomMessageEpoch(roomId);
        const requestId = ++roomMessageRequestSequence;
        roomMessageMoreRequestByRoom.set(roomId, requestId);
        set((state) => {
          const messagesMoreErrors = { ...state.messagesMoreErrors };
          delete messagesMoreErrors[roomId];
          return {
            messagesLoadingMore: { ...state.messagesLoadingMore, [roomId]: true },
            messagesMoreErrors,
          };
        });
        try {
          const result = await api.getRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 });
          if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageMoreRequestByRoom)) return;
          if (!result.has_more) fullyLoadedRoomHistory.add(roomId);
          set((state) => {
            if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageMoreRequestByRoom)) return state;
            return {
              messages: {
                ...state.messages,
                [roomId]: mergeLoadedRoomMessages(
                  state.messages[roomId] ?? existing,
                  result.messages,
                ),
              },
              messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
            };
          });
        } catch (error) {
          console.error("[ChatStore] Failed to load more messages:", error);
          if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageMoreRequestByRoom)) return;
          const message = error instanceof Error ? error.message : "Failed to load older messages";
          set((state) => ({
            messagesMoreErrors: { ...state.messagesMoreErrors, [roomId]: message },
          }));
        } finally {
          if (!isCurrentRoomMessageRequest(roomId, epoch, requestId, roomMessageMoreRequestByRoom)) return;
          roomMessageMoreRequestByRoom.delete(roomId);
          set((state) => ({
            messagesLoadingMore: { ...state.messagesLoadingMore, [roomId]: false },
          }));
        }
      },

      loadRoomMembers: async (roomId: string, opts) => {
        const cached = get().roomMembersByRoom[roomId];
        if (cached && !opts?.force) return cached;

        const inFlight = roomMembersInFlight.get(roomId);
        if (inFlight && !opts?.force) return inFlight;

        const request = (async () => {
          set((state) => ({
            roomMembersLoading: { ...state.roomMembersLoading, [roomId]: true },
          }));
          try {
            const result = await api.getRoomMembers(roomId).catch(() => api.getPublicRoomMembers(roomId));
            set((state) => ({
              roomMembersByRoom: { ...state.roomMembersByRoom, [roomId]: result.members },
            }));
            return result.members;
          } catch (error) {
            console.error("[ChatStore] Failed to load room members:", error);
            set((state) => ({
              roomMembersByRoom: { ...state.roomMembersByRoom, [roomId]: [] },
            }));
            return [];
          } finally {
            roomMembersInFlight.delete(roomId);
            set((state) => {
              const next = { ...state.roomMembersLoading };
              delete next[roomId];
              return { roomMembersLoading: next };
            });
          }
        })();

        roomMembersInFlight.set(roomId, request);
        return request;
      },

      selectAgent: async (agentId: string) => {
        const scope = dashboardProfileScope();
        const selection = ++agentSelectionSequence;
        const cached = agentProfiles.get(scope, agentId);
        useDashboardUIStore.getState().openAgentCard();
        set({
          selectedAgentId: agentId,
          selectedAgentLoading: !cached,
          selectedAgentError: null,
          selectedAgentProfile: cached?.profile ?? null,
          selectedAgentConversations: cached?.conversations ?? null,
        });
        const isCurrent = () => selection === agentSelectionSequence
          && scope === dashboardProfileScope()
          && useDashboardUIStore.getState().agentCardOpen;
        try {
          const result = await agentProfiles.load(scope, agentId);
          if (!isCurrent()) return;
          set({
            selectedAgentLoading: false,
            selectedAgentError: null,
            selectedAgentProfile: result.profile,
            selectedAgentConversations: result.conversations,
          });
        } catch (error: unknown) {
          if (!isCurrent()) return;
          const retained = agentProfiles.get(scope, agentId);
          set({
            selectedAgentProfile: retained?.profile ?? null,
            selectedAgentConversations: retained?.conversations ?? null,
            selectedAgentLoading: false,
            selectedAgentError: retained ? null : error instanceof Error ? error.message : "Failed to load agent profile",
          });
        }
      },

      searchAgents: async (q: string) => {
        if (!q.trim()) {
          set({ searchResults: null });
          return;
        }
        try {
          const agents = await api.searchAgentDirectory(q);
          set({ searchResults: agents });
        } catch (error) {
          console.error("[ChatStore] Search failed:", error);
        }
      },

      refreshOverview: async (opts) => {
        if (!opts?.reloadOpenedRoom && overviewInFlight) {
          return overviewInFlight;
        }
        const { token } = useDashboardSessionStore.getState();
        const openedRoomId = opts?.reloadOpenedRoom
          ? useDashboardUIStore.getState().openedRoomId
          : null;

        if (!token) {
          await Promise.all([get().loadPublicRooms(), get().loadPublicAgents()]);
          return;
        }
        // Human-first: /overview resolves the viewer from the Supabase JWT.

        const hasOverview = Boolean(get().overview);
        const request = (async () => {
          // Only flip the loading flag on first load (nothing to show yet).
          // Background polls keep the existing overview on screen, so toggling
          // overviewRefreshing every 5s just churns re-renders for no UI change.
          if (!hasOverview) {
            set({ overviewRefreshing: true, overviewErrored: false });
          }
          try {
            const overview = await api.getOverview();
            get().replaceOverview(overview);
            if (openedRoomId) {
              void get().loadRoomMessages(openedRoomId);
            }
          } catch (error: any) {
            if (isAuthError(error)) {
              console.warn("[ChatStore] Background overview auth refresh failed:", error);
              set({ overviewRefreshing: false, overviewErrored: false });
              return;
            }
            if (get().overview && isFetchNetworkError(error)) {
              console.warn("[ChatStore] Background overview refresh failed:", error);
              set({ overviewRefreshing: false, overviewErrored: false });
              return;
            }
            set({ error: error?.message || "Failed to refresh", overviewRefreshing: false, overviewErrored: true });
          }
        })().finally(() => {
          if (overviewInFlight === request) {
            overviewInFlight = null;
          }
        });
        if (!opts?.reloadOpenedRoom) {
          overviewInFlight = request;
        }
        return request;
      },

      loadDiscoverRooms: async () => {
        set({ discoverLoading: true });
        try {
          const result = await api.discoverRooms();
          set({ discoverRooms: result.rooms, discoverLoading: false });
        } catch {
          set({ discoverLoading: false });
        }
      },

      joinRoom: async (roomId: string) => {
        const { token } = useDashboardSessionStore.getState();
        if (!token) return;
        set({ joiningRoomId: roomId });
        try {
          await api.joinRoom(roomId);
          const overview = await api.getOverview();
          set((state) => ({
            joiningRoomId: null,
            discoverRooms: state.discoverRooms.filter((room) => room.room_id !== roomId),
          }));
          get().replaceOverview(overview);
        } catch (error) {
          set({ joiningRoomId: null });
          get().setError(error instanceof Error ? error.message : "Unknown error");
        }
      },

      leaveRoom: async (roomId: string) => {
        const { token } = useDashboardSessionStore.getState();
        if (!token) return;
        // A leave removes this cache. Invalidate every outstanding page/poll
        // first so a late response cannot recreate the room after cleanup.
        invalidateRoomMessageRequests(roomId);
        set({ leavingRoomId: roomId });
        try {
          await api.leaveRoom(roomId);
          const [overview] = await Promise.all([
            api.getOverview(),
            get().loadPublicRoomDetail(roomId),
          ]);
          set((state) => {
            const messages = { ...state.messages };
            const messagesLoading = { ...state.messagesLoading };
            const messagesErrors = { ...state.messagesErrors };
            const messagesHasMore = { ...state.messagesHasMore };
            const messagesLoadingMore = { ...state.messagesLoadingMore };
            const messagesMoreErrors = { ...state.messagesMoreErrors };
            const roomMembersByRoom = { ...state.roomMembersByRoom };
            const roomMembersLoading = { ...state.roomMembersLoading };
            delete messages[roomId];
            delete messagesLoading[roomId];
            delete messagesErrors[roomId];
            delete messagesHasMore[roomId];
            delete messagesLoadingMore[roomId];
            delete messagesMoreErrors[roomId];
            delete roomMembersByRoom[roomId];
            delete roomMembersLoading[roomId];
            return {
              leavingRoomId: null,
              messages,
              messagesLoading,
              messagesErrors,
              messagesHasMore,
              messagesLoadingMore,
              messagesMoreErrors,
              roomMembersByRoom,
              roomMembersLoading,
            };
          });
          const ui = useDashboardUIStore.getState();
          if (ui.openedRoomId === roomId || ui.focusedRoomId === roomId) {
            ui.setFocusedRoomId(null);
            ui.setOpenedRoomId(null);
            ui.setOpenedTopicId(null);
          }
          get().replaceOverview(overview);
        } catch (error) {
          // Requests that started before the leave attempt were invalidated so
          // a late response cannot re-create this room. If leaving fails, they
          // will no longer run their own finally blocks, so release their UI
          // loading flags here while keeping the existing cached messages.
          set((state) => {
            const messagesLoading = { ...state.messagesLoading };
            const messagesLoadingMore = { ...state.messagesLoadingMore };
            delete messagesLoading[roomId];
            delete messagesLoadingMore[roomId];
            return { leavingRoomId: null, messagesLoading, messagesLoadingMore };
          });
          throw error;
        }
      },

      loadPublicRooms: async (q = "") => {
        const query = q.trim();
        const scope = publicDirectoryScope();
        if (publicRoomsInFlight?.query === query && publicRoomsInFlight.scope === scope) {
          return publicRoomsInFlight.promise;
        }
        const requestId = ++publicRoomsRequestSeq;
        const isCurrent = () => requestId === publicRoomsRequestSeq && scope === publicDirectoryScope();
        set({ publicRoomsLoading: true });
        const promise = (async () => {
          try {
            const result = await api.getPublicRooms({ q: query || undefined, limit: 50 });
            if (!isCurrent()) return;
            set((state) => ({
                publicRooms: result.rooms,
                publicRoomDetails: {
                  ...state.publicRoomDetails,
                  ...Object.fromEntries(result.rooms.map((room) => [room.room_id, room])),
                },
                publicRoomsQuery: query,
                publicRoomsLoading: false,
                publicRoomsLoaded: true,
              }));
          } catch {
            if (!isCurrent()) return;
            // Failed searches must not label previous results as this query.
            set({ publicRoomsLoading: false, publicRoomsLoaded: true });
          }
        })();
        publicRoomsInFlight = { query, scope, promise };
        try {
          await promise;
        } finally {
          if (publicRoomsInFlight?.promise === promise) publicRoomsInFlight = null;
        }
      },

      loadPublicRoomDetail: async (roomId: string) => {
        const cached = get().publicRoomDetails[roomId];
        if (cached) return cached;
        try {
          const result = await api.getPublicRoom(roomId);
          const room = result.rooms[0] || null;
          if (!room) return null;
          set((state) => ({
            publicRoomDetails: {
              ...state.publicRoomDetails,
              [room.room_id]: room,
            },
            recentVisitedRooms: [
              room,
              ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
            ].slice(0, 20),
          }));
          return room;
        } catch {
          return null;
        }
      },

      loadPublicAgents: async (q = "") => {
        const query = q.trim();
        const scope = publicDirectoryScope();
        if (publicAgentsInFlight?.query === query && publicAgentsInFlight.scope === scope) {
          return publicAgentsInFlight.promise;
        }
        const requestId = ++publicAgentsRequestSeq;
        const isCurrent = () => requestId === publicAgentsRequestSeq && scope === publicDirectoryScope();
        set({ publicAgentsLoading: true });
        const promise = (async () => {
          try {
            const result = await api.getPublicAgents({ q: query || undefined, limit: 50 });
            if (!isCurrent()) return;
            set({
                publicAgents: result.agents,
                publicAgentsQuery: query,
                publicAgentsLoading: false,
                publicAgentsLoaded: true,
              });
          } catch {
            if (!isCurrent()) return;
            // Failed searches must not label previous results as this query.
            set({ publicAgentsLoading: false, publicAgentsLoaded: true });
          }
        })();
        publicAgentsInFlight = { query, scope, promise };
        try {
          await promise;
        } finally {
          if (publicAgentsInFlight?.promise === promise) publicAgentsInFlight = null;
        }
      },

      loadPublicHumans: async (q = "") => {
        const query = q.trim();
        const scope = publicDirectoryScope();
        if (publicHumansInFlight?.query === query && publicHumansInFlight.scope === scope) {
          return publicHumansInFlight.promise;
        }
        const requestId = ++publicHumansRequestSeq;
        const isCurrent = () => requestId === publicHumansRequestSeq && scope === publicDirectoryScope();
        set({ publicHumansLoading: true });
        const promise = (async () => {
          try {
            const result = await api.getPublicHumans({ q: query || undefined, limit: 100 });
            if (!isCurrent()) return;
            set({
                publicHumans: result.humans,
                publicHumansQuery: query,
                publicHumansLoading: false,
                publicHumansLoaded: true,
              });
          } catch {
            if (!isCurrent()) return;
            // Failed searches must not label previous results as this query.
            set({ publicHumansLoading: false, publicHumansLoaded: true });
          }
        })();
        publicHumansInFlight = { query, scope, promise };
        try {
          await promise;
        } finally {
          if (publicHumansInFlight?.promise === promise) publicHumansInFlight = null;
        }
      },

      loadOwnedAgentRooms: async () => {
        if (ownedAgentRoomsInFlight) {
          return ownedAgentRoomsInFlight;
        }
        const { token, activeIdentity, ownedAgents } = useDashboardSessionStore.getState();
        if (!token || activeIdentity?.type !== "human") {
          set({ ownedAgentRooms: [], ownedAgentRoomsLoading: false, ownedAgentRoomsLoaded: true });
          return;
        }
        ownedAgentRoomsInFlight = (async () => {
          set({ ownedAgentRoomsLoading: true });
          try {
            const result = await humansApi.listAgentRooms();
            const optimisticOwnerChatRooms = reconcileOptimisticOwnerChatRooms(
              result.rooms,
              get().optimisticOwnerChatRooms,
            );
            set({
              ownedAgentRooms: ensureOwnerChatRoomsForOwnedAgents(
                mergeOptimisticOwnerChatRooms(result.rooms, optimisticOwnerChatRooms),
                ownedAgents,
              ),
              optimisticOwnerChatRooms,
              ownedAgentRoomsLoading: false,
              ownedAgentRoomsLoaded: true,
            });
          } catch (error) {
            set({
              ownedAgentRooms: ensureOwnerChatRoomsForOwnedAgents(
                get().ownedAgentRooms,
                ownedAgents,
              ),
              ownedAgentRoomsLoading: false,
              ownedAgentRoomsLoaded: true,
            });
            get().setError(error instanceof Error ? error.message : "Failed to load bot rooms");
          }
        })().finally(() => {
          ownedAgentRoomsInFlight = null;
        });
        return ownedAgentRoomsInFlight;
      },

      upsertOptimisticOwnerChatRoom: (agent, roomId) => {
        set((state) => {
          const existingOwnerChatRoom = state.ownedAgentRooms.find((room) => ownerChatAgentId(room) === agent.agent_id);
          const optimisticRoom = roomId || !existingOwnerChatRoom
            ? buildOptimisticOwnerChatRoom(agent, roomId, existingOwnerChatRoom)
            : existingOwnerChatRoom;
          const optimisticOwnerChatRooms = {
            ...state.optimisticOwnerChatRooms,
            [agent.agent_id]: optimisticRoom,
          };
          return {
            optimisticOwnerChatRooms,
            ownedAgentRooms: mergeOptimisticOwnerChatRooms(
              state.ownedAgentRooms,
              optimisticOwnerChatRooms,
            ),
          };
        });
      },
    }),
    {
      name: "dashboard-chat-storage",
      partialize: (state) => ({
        recentVisitedRooms: state.recentVisitedRooms,
        publicRooms: state.publicRooms,
        publicAgents: state.publicAgents,
        publicRoomDetails: state.publicRoomDetails,
      }),
    },
  ),
);

/** Message history belongs to the signed-in human, not the selected Bot. */
export function messageCacheOwnerKey(): string {
  const { token, human } = useDashboardSessionStore.getState();
  return JSON.stringify([Boolean(token), human?.human_id ?? null]);
}

let lastMessageCacheOwnerKey = messageCacheOwnerKey();
useDashboardSessionStore.subscribe(() => {
  const nextKey = messageCacheOwnerKey();
  if (nextKey !== lastMessageCacheOwnerKey) {
    lastMessageCacheOwnerKey = nextKey;
    useDashboardChatStore.getState().resetChatState();
  }
});

let lastAgentProfileScope = dashboardProfileScope();
useDashboardSessionStore.subscribe(() => {
  const scope = dashboardProfileScope();
  if (scope === lastAgentProfileScope) return;
  lastAgentProfileScope = scope;
  invalidateAgentProfiles();
  useDashboardUIStore.getState().closeAgentCard();
  useDashboardChatStore.setState({
    selectedAgentId: null, selectedAgentProfile: null, selectedAgentConversations: null,
    selectedAgentLoading: false, selectedAgentError: null,
  });
});

/**
 * [INPUT]: Authenticated account id, cursor-based sync API and realtime hints.
 * [OUTPUT]: Account-isolated, persistent conversation summaries; cache-first delta refresh.
 * [POS]: Messages directory, independent of message history and legacy overview loaders.
 * [PROTOCOL]: Never persist tokens. Fence requests on account changes and logout.
 */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
import type { MessagesFilterKey } from "@/lib/messages-merge";
import { getIsoTimestampValue } from "./dashboard-shared";

export type DirectoryView = { filter: MessagesFilterKey; botScope: string };
const defaultView: DirectoryView = { filter: "self-all", botScope: "all" };
const cacheKey = (account: string) => `botcord-conversations:v1:${process.env.NEXT_PUBLIC_HUB_BASE_URL ?? "default"}:${account}`;
export const sortConversations = (rooms: DashboardRoom[]) => [...rooms].sort((a, b) =>
  getIsoTimestampValue(b.last_message_at) - getIsoTimestampValue(a.last_message_at)
  || a.room_id.localeCompare(b.room_id),
);

interface Snapshot { cursor: string | null; version: 1; accountId: string; rooms: DashboardRoom[]; view: DirectoryView; humanId: string | null }
function readCache(accountId: string): Snapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(accountId)) ?? "null");
    if (value?.version !== 1 || value.accountId !== accountId || !Array.isArray(value.rooms)
      || !value.rooms.every((r: DashboardRoom) => typeof r?.room_id === "string" && typeof r.name === "string")) return null;
    const filters = ["self-all", "self-my-bot", "self-third-bot", "self-human", "self-group", "bots-all", "bots-bot-bot", "bots-bot-human", "bots-group"];
    return { ...value, cursor: typeof value.cursor === "string" ? value.cursor : null, humanId: typeof value.humanId === "string" ? value.humanId : null,
      view: filters.includes(value.view?.filter) && typeof value.view?.botScope === "string" ? value.view : defaultView };
  } catch { return null; }
}
function persist(state: DirectoryState) {
  if (!state.accountId || !state.ready) return;
  try {
    localStorage.setItem(cacheKey(state.accountId), JSON.stringify({
      version: 1, accountId: state.accountId, humanId: state.humanId, rooms: state.rooms, view: state.view, cursor: state.cursor,
    }));
  } catch { /* Quota/disabled storage must not prevent in-memory chat. */ }
}

interface DirectoryState {
  cursor: string | null;
  accountId: string | null;
  humanId: string | null;
  rooms: DashboardRoom[];
  ready: boolean;
  syncing: boolean;
  hasMore: boolean;
  error: string | null;
  view: DirectoryView;
  activate: (accountId: string | null, forget?: boolean) => void;
  setView: (view: DirectoryView) => void;
  sync: () => Promise<void>;
  patch: (roomId: string, patch: Partial<DashboardRoom>) => void;
  onEvent: (event: RealtimeMetaEvent) => void;
}
let generation = 0;
let pending: Promise<void> | null = null;
let requestedAgain = false;
let localVersions: Record<string, number> = {};

export const useConversationDirectoryStore = create<DirectoryState>()((set, get) => ({
  cursor: null, accountId: null, humanId: null, rooms: [], ready: false, syncing: false, hasMore: false, error: null, view: defaultView,
  activate: (accountId, forget = false) => {
    const current = get();
    if (forget && current.accountId) {
      try { localStorage.removeItem(cacheKey(current.accountId)); } catch {}
    }
    if (accountId === current.accountId && !forget) return;
    generation += 1;
    pending = null;
    requestedAgain = false;
    localVersions = {};
    const cached = accountId ? readCache(accountId) : null;
    set({ accountId, cursor: cached?.cursor ?? null, humanId: cached?.humanId ?? null, rooms: cached?.rooms ?? [], ready: Boolean(cached),
      syncing: false, hasMore: false, error: null, view: cached?.view ?? defaultView });
  },
  setView: (view) => { set({ view }); persist(get()); },
  sync: () => {
    if (!get().accountId) return Promise.resolve();
    if (pending) { requestedAgain = true; return pending; }
    const requestGeneration = generation;
    const accountId = get().accountId;
    const current = () => generation === requestGeneration && get().accountId === accountId;
    set({ syncing: true, error: null });
    const request = (async () => {
      try {
        // Bounded drain: newest changes arrive first. Yield between batches so
        // a cold first page can render without waiting for the entire account.
        for (let page = 0; page < 100 && current(); page += 1) {
          requestedAgain = false;
          const versions = { ...localVersions };
          const cursor = get().cursor;
          const result = await api.syncConversations(cursor);
          if (!current()) return;
          if (result.account_id !== accountId) throw new Error("Conversation account changed");
          const previous = new Map(get().rooms.map((room) => [room.room_id, room]));
          const rooms = result.reset ? new Map<string, DashboardRoom>() : new Map(previous);
          let skipped = false;
          for (const id of result.removed_ids) rooms.delete(id);
          for (const room of result.upserts) {
            if ((localVersions[room.room_id] ?? 0) !== (versions[room.room_id] ?? 0)) {
              requestedAgain = true;
              skipped = true;
              const local = previous.get(room.room_id);
              if (local) rooms.set(room.room_id, local);
              continue;
            }
            rooms.set(room.room_id, room);
          }
          // Replay this page if a local event raced it; advancing the cursor
          // after skipping an upsert would permanently lose its authoritative data.
          set({ cursor: skipped ? cursor : result.next_cursor, rooms: sortConversations([...rooms.values()]), ready: true,
            humanId: result.human_id, hasMore: result.has_more });
          persist(get());
          if (!result.has_more && !requestedAgain) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        if (current()) set({ error: error instanceof Error ? error.message : "Conversation sync failed" });
      } finally {
        if (current()) { set({ syncing: false }); pending = null; }
      }
    })();
    pending = request;
    return request;
  },
  patch: (roomId, patch) => {
    const existing = get().rooms.find((room) => room.room_id === roomId);
    if (!existing) return;
    if (patch.last_message_at && getIsoTimestampValue(patch.last_message_at) < getIsoTimestampValue(existing.last_message_at)) return;
    localVersions[roomId] = (localVersions[roomId] ?? 0) + 1;
    set({ rooms: sortConversations(get().rooms.map((room) => room.room_id === roomId
      ? { ...room, ...patch, room_id: roomId, revision: "" } : room)) });
    persist(get());
  },
  onEvent: (event) => {
    // Typing, delivery receipts and response state are not message activity.
    if (["typing", "ack", "result", "error", "message_status_reaction"].includes(event.type)) return;
    if (event.room_id && (event.type === "message" || event.type === "system")) {
      const existing = get().rooms.find((room) => room.room_id === event.room_id);
      if (existing && typeof event.ext.preview === "string") get().patch(event.room_id, {
        last_message_at: event.created_at, last_message_preview: event.ext.preview,
        last_sender_name: typeof event.ext.display_sender_name === "string" ? event.ext.display_sender_name
          : typeof event.ext.sender_name === "string" ? event.ext.sender_name : existing.last_sender_name,
      });
    }
    void get().sync();
  },
}));

import { api } from "./api";
import { findCachedOwnerChatRoom } from "@/store/useOwnerChatStore";
import { messageCacheOwnerKey } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

type OwnerRoom = { room_id: string; name: string };
const pending = new Map<string, Promise<OwnerRoom>>();

// The shell and detail pane can discover the same room during one navigation.
// Share only in-flight work; durable room summaries stay in the chat store.
export function resolveOwnerChatRoom(agentId: string): Promise<OwnerRoom> {
  const known = findCachedOwnerChatRoom(agentId);
  if (known) return Promise.resolve(known);
  const existing = pending.get(agentId);
  if (existing) return existing;
  const requestOwnerKey = messageCacheOwnerKey();
  const request = Promise.resolve()
    .then(() => {
      if (messageCacheOwnerKey() !== requestOwnerKey) throw new Error("Chat session changed");
      return api.getUserChatRoom(agentId);
    })
    .finally(() => {
      if (pending.get(agentId) === request) pending.delete(agentId);
    });
  pending.set(agentId, request);
  return request;
}

let ownerKey = messageCacheOwnerKey();
useDashboardSessionStore.subscribe(() => {
  const nextKey = messageCacheOwnerKey();
  if (nextKey !== ownerKey) {
    ownerKey = nextKey;
    pending.clear();
  }
});
